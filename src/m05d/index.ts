import { canonicalBytes, canonicalHash, ProtocolValidationError } from '../protocol/canonical.js'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { assertHash, assertSafeText } from '../protocol/canonical.js'
import { validateMemoryCatalog, validateRetrievalCases, validateEvaluationProtocol, validatePairedTasks, type MemoryCatalog, type RetrievalCases } from '../protocol/evaluation.js'
import { createSearchTool } from '../search-tool.js'
import { createOpenTool } from '../open-tool.js'
import { RetrievalRuntime } from '../retrieval/runtime.js'
import { createRecallContext, createRecallReceipt, encodeRecallContext, replayRecallContext, validateRecallContext, validateRecallReceipt, type RecallContextEnvelope, type RecallContextReceipt } from '../protocol/recall.js'
import { validateOpenDisclosure, validateSearchDisclosure } from '../protocol/retrieval.js'
import { RECALL_PREFIX } from '../recall-tool.js'

const GROUPS = ['no_memory', 'tool_only', 'auto_inject'] as const
const SEEDS = [101, 202, 303, 404, 505] as const
const ACQUISITION_BY_SEED = { 101: 'novel_candidate', 202: 'duplicate_skip', 303: 'external_failure_skip', 404: 'sensitive_reject', 505: 'duplicate_skip' } as const
const V1_GOLDEN = {
  'memory-catalog.json': 'sha256_9d335b99ec7a1c9578ad2c7df1c5e15f9588ecf27d92276d722759b9165ab5c8',
  'paired-tasks.json': 'sha256_9e7f8c27450acb04b760b74092ee068ccb6e5e200d7bac8aa871a71b3aa84ccb',
  'protocol.json': 'sha256_62fc6353c4ea09979b8e8243d44df374d232c824287f41601aafd0e27a5c6f67',
  'retrieval-cases.json': 'sha256_561d204a2be27256165adf63d1b190d2f441dc18a2910797b8b5f2ae9b783ce5',
} as const
const THRESHOLDS = {
  difficult_recall_at_5_min: 0.8,
  context_precision_at_5_min: 0.7,
  excluded_leakage_max: 0,
  replay_consistency_min: 1,
  wrong_memory_adoption_max: 0.05,
  tool_only_success_delta_points_min: 10,
  non_memory_regression_points_max: 0,
  overhead_token_ratio_median_max: 0.15,
  retrieval_latency_p95_ms_max: 1000,
  acquisition_critical_path_blocking_max: 0,
} as const
const FAILURE_CODES = ['memory_unavailable', 'model_error', 'assertion_failed'] as const
const ACQUISITION_REASON_CODES = ['novel_candidate', 'duplicate_overlap', 'external_failure', 'sensitive_input'] as const
const TOOL_VOCAB = ['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open'] as const
const MEMORY_EVENT_VOCAB = ['user_message', 'recall_user_message'] as const

export type M05DGroup = (typeof GROUPS)[number]
export type TaskKind = 'memory_dependent' | 'non_memory_control'
export type AcquisitionReasonCode = (typeof ACQUISITION_REASON_CODES)[number]
export interface M05DTask {
  task_id: string
  task_kind: TaskKind
  task_family: string
  prompt: string
  required_memory_ids: string[]
  forbidden_memory_ids: string[]
  success_assertions: Array<{ assertion_id: string; kind: 'exit_code' | 'result_equals'; field?: string; expected: string | number | boolean | null }>
  max_steps: number
}
export interface AcquisitionCase {
  case_id: 'novel_candidate' | 'duplicate_skip' | 'external_failure_skip' | 'sensitive_reject'
  episode_summary: string
  outcome_class: 'success' | 'external_failure'
  overlap_memory_ids: string[]
  sensitive: boolean
  expected_decision: AcquisitionCase['case_id']
  provider_output: { title: string; summary: string; redaction_status: 'passed' } | null
}
export interface M05DFixtures {
  protocol: { evaluation_id: 'm05_v2'; fixture_version: 2; schema_version: 1; groups: M05DGroup[]; model: { provider: string; model: string; requested_seeds: number[]; temperature: 0 }; repetitions_per_task: 5; thresholds: Record<string, number>; runner_limits: { max_model_calls_per_task: 4; max_acquisition_calls_per_run: 1; call_timeout_ms: number; batch_timeout_ms: number } }
  /** Immutable v1 subfixture reused by v2; validated with the v1 validator. */
  catalog: MemoryCatalog
  /** Immutable v1 subfixture reused by v2; validated with the v1 validator. */
  retrievalCases: RetrievalCases
  tasks: M05DTask[]
  acquisitionCases: AcquisitionCase[]
  manifest: { schema_version: 1; fixture_version: 2; files: Array<{ relative_name: string; content_sha256: string }> }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError()
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new ProtocolValidationError()
}
function id(value: unknown, prefix: string): void {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[a-z0-9][a-z0-9._-]{0,63}$`).test(value)) throw new ProtocolValidationError()
}
function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string')) throw new ProtocolValidationError()
  const result = [...value] as string[]
  if (new Set(result).size !== result.length) throw new ProtocolValidationError()
  return result.sort()
}
function memoryIds(value: unknown): string[] {
  const result = strings(value, 32)
  if (result.some((item) => !/^memory_[a-z0-9][a-z0-9._-]{0,63}$/.test(item))) throw new ProtocolValidationError()
  return result
}
export class M05DAgentTimeoutError extends ProtocolValidationError {}
export class M05DBatchTimeoutError extends ProtocolValidationError {}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorFactory: () => Error = () => new M05DAgentTimeoutError()): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(errorFactory()), timeoutMs) })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function validateTask(value: unknown): M05DTask {
  const task = object(value)
  exactKeys(task, ['task_id', 'task_kind', 'task_family', 'prompt', 'required_memory_ids', 'forbidden_memory_ids', 'success_assertions', 'max_steps'])
  id(task.task_id, 'task_')
  if (task.task_kind !== 'memory_dependent' && task.task_kind !== 'non_memory_control') throw new ProtocolValidationError()
  if (typeof task.task_family !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(task.task_family) || typeof task.prompt !== 'string') throw new ProtocolValidationError()
  assertSafeText(task.task_family, 64); assertSafeText(task.prompt, 1000)
  const required = memoryIds(task.required_memory_ids)
  const forbidden = memoryIds(task.forbidden_memory_ids)
  if (required.some((memoryId) => forbidden.includes(memoryId))) throw new ProtocolValidationError()
  if (task.task_kind === 'non_memory_control' && required.length !== 0) throw new ProtocolValidationError()
  if (task.task_kind === 'memory_dependent' && required.length === 0) throw new ProtocolValidationError()
  if (!Array.isArray(task.success_assertions) || task.success_assertions.length === 0) throw new ProtocolValidationError()
  const assertions = task.success_assertions.map((value) => {
    const assertion = object(value)
    if (assertion.kind === 'exit_code') {
      exactKeys(assertion, ['assertion_id', 'kind', 'expected']); id(assertion.assertion_id, 'assert_')
      if (!Number.isSafeInteger(assertion.expected) || (assertion.expected as number) < 0 || (assertion.expected as number) > 255) throw new ProtocolValidationError()
      return { assertion_id: assertion.assertion_id as string, kind: 'exit_code' as const, expected: assertion.expected as number }
    }
    if (assertion.kind === 'result_equals') {
      exactKeys(assertion, ['assertion_id', 'kind', 'field', 'expected']); id(assertion.assertion_id, 'assert_')
      if (typeof assertion.field !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(assertion.field)) throw new ProtocolValidationError()
      if (assertion.expected !== null && !['string', 'number', 'boolean'].includes(typeof assertion.expected)) throw new ProtocolValidationError()
      if (typeof assertion.expected === 'string') assertSafeText(assertion.expected, 300)
      if (typeof assertion.expected === 'number' && (!Number.isFinite(assertion.expected) || Math.abs(assertion.expected) >= 1e21 || assertion.expected !== 0 && Math.abs(assertion.expected) < 1e-6)) throw new ProtocolValidationError()
      return { assertion_id: assertion.assertion_id as string, kind: 'result_equals' as const, field: assertion.field, expected: assertion.expected as string | number | boolean | null }
    }
    throw new ProtocolValidationError()
  })
  if (new Set(assertions.map((assertion) => assertion.assertion_id)).size !== assertions.length) throw new ProtocolValidationError()
  if (!Number.isSafeInteger(task.max_steps) || (task.max_steps as number) < 1 || (task.max_steps as number) > 100) throw new ProtocolValidationError()
  return { task_id: task.task_id as string, task_kind: task.task_kind as TaskKind, task_family: task.task_family as string, prompt: task.prompt as string, required_memory_ids: required, forbidden_memory_ids: forbidden, success_assertions: assertions, max_steps: task.max_steps as number }
}

function validateAcquisitionCase(value: unknown): AcquisitionCase {
  const item = object(value)
  exactKeys(item, ['case_id', 'episode_summary', 'outcome_class', 'overlap_memory_ids', 'sensitive', 'expected_decision', 'provider_output'])
  const cases = ['novel_candidate', 'duplicate_skip', 'external_failure_skip', 'sensitive_reject'] as const
  if (!cases.includes(item.case_id as AcquisitionCase['case_id']) || typeof item.episode_summary !== 'string' || (item.outcome_class !== 'success' && item.outcome_class !== 'external_failure') || typeof item.sensitive !== 'boolean') throw new ProtocolValidationError()
  assertSafeText(item.episode_summary, 1000)
  const overlap = memoryIds(item.overlap_memory_ids)
  if (item.expected_decision !== item.case_id) throw new ProtocolValidationError()
  if (item.case_id !== 'novel_candidate' && item.provider_output !== null) throw new ProtocolValidationError()
  if (item.case_id === 'novel_candidate') {
    const output = object(item.provider_output); exactKeys(output, ['title', 'summary', 'redaction_status'])
    if (typeof output.title !== 'string' || typeof output.summary !== 'string' || output.redaction_status !== 'passed') throw new ProtocolValidationError()
    assertSafeText(output.title, 200); assertSafeText(output.summary, 1000)
    return { case_id: item.case_id as AcquisitionCase['case_id'], episode_summary: item.episode_summary as string, outcome_class: item.outcome_class as AcquisitionCase['outcome_class'], overlap_memory_ids: overlap, sensitive: item.sensitive as boolean, expected_decision: item.expected_decision as AcquisitionCase['case_id'], provider_output: output as AcquisitionCase['provider_output'] }
  }
  return { case_id: item.case_id as AcquisitionCase['case_id'], episode_summary: item.episode_summary as string, outcome_class: item.outcome_class as AcquisitionCase['outcome_class'], overlap_memory_ids: overlap, sensitive: item.sensitive as boolean, expected_decision: item.expected_decision as AcquisitionCase['case_id'], provider_output: null }
}

function acquisitionDecision(item: AcquisitionCase): AcquisitionCase['case_id'] {
  if (item.sensitive) return 'sensitive_reject'
  if (item.outcome_class === 'external_failure') return 'external_failure_skip'
  if (item.overlap_memory_ids.length > 0) return 'duplicate_skip'
  return 'novel_candidate'
}
function acquisitionReasonCode(item: AcquisitionCase): AcquisitionReasonCode {
  if (item.sensitive) return 'sensitive_input'
  if (item.outcome_class === 'external_failure') return 'external_failure'
  if (item.overlap_memory_ids.length > 0) return 'duplicate_overlap'
  return 'novel_candidate'
}

export function validateM05Dv2Fixtures(value: unknown): M05DFixtures {
  const root = object(value)
  exactKeys(root, ['protocol', 'catalog', 'retrievalCases', 'tasks', 'acquisitionCases', 'manifest'])
  const protocol = object(root.protocol)
  exactKeys(protocol, ['schema_version', 'evaluation_id', 'fixture_version', 'groups', 'model', 'repetitions_per_task', 'thresholds', 'runner_limits'])
  if (protocol.schema_version !== 1 || protocol.evaluation_id !== 'm05_v2' || protocol.fixture_version !== 2 || protocol.repetitions_per_task !== 5) throw new ProtocolValidationError()
  if (JSON.stringify(protocol.groups) !== JSON.stringify(GROUPS)) throw new ProtocolValidationError()
  const model = object(protocol.model)
  exactKeys(model, ['provider', 'model', 'temperature', 'requested_seeds'])
  if (model.temperature !== 0 || JSON.stringify(model.requested_seeds) !== JSON.stringify(SEEDS) || typeof model.provider !== 'string' || typeof model.model !== 'string') throw new ProtocolValidationError()
  assertSafeText(model.provider, 80); assertSafeText(model.model, 120)
  const limits = object(protocol.runner_limits)
  exactKeys(limits, ['max_model_calls_per_task', 'max_acquisition_calls_per_run', 'call_timeout_ms', 'batch_timeout_ms'])
  if (limits.max_model_calls_per_task !== 4 || limits.max_acquisition_calls_per_run !== 1 || limits.call_timeout_ms !== 30000 || limits.batch_timeout_ms !== 600000) throw new ProtocolValidationError()
  const thresholds = object(protocol.thresholds); exactKeys(thresholds, Object.keys(THRESHOLDS))
  for (const [key, expected] of Object.entries(THRESHOLDS)) if (thresholds[key] !== expected) throw new ProtocolValidationError()
  const catalog = validateMemoryCatalog(root.catalog)
  const retrievalCases = validateRetrievalCases(root.retrievalCases)
  if ((root.catalog as Record<string, unknown>).fixture_version !== 1 || (root.retrievalCases as Record<string, unknown>).fixture_version !== 1) throw new ProtocolValidationError()
  if (!Array.isArray(root.tasks) || root.tasks.length !== 8) throw new ProtocolValidationError()
  const tasks = root.tasks.map(validateTask)
  if (new Set(tasks.map((task) => task.task_id)).size !== 8 || tasks.filter((task) => task.task_kind === 'memory_dependent').length !== 6 || tasks.filter((task) => task.task_kind === 'non_memory_control').length !== 2) throw new ProtocolValidationError()
  if (new Set(tasks.map((task) => task.task_family)).size < 2) throw new ProtocolValidationError()
  const memoryIdsSet = new Set(catalog.memories.map((memory) => memory.memory_id))
  for (const task of tasks) {
    for (const memoryId of [...task.required_memory_ids, ...task.forbidden_memory_ids]) if (!memoryIdsSet.has(memoryId)) throw new ProtocolValidationError()
    if (task.required_memory_ids.some((memoryId) => catalog.memories.find((memory) => memory.memory_id === memoryId)?.lifecycle !== 'active')) throw new ProtocolValidationError()
  }
  for (const item of retrievalCases.cases) for (const memoryId of [...item.expected_memory_ids, ...item.forbidden_memory_ids]) if (!memoryIdsSet.has(memoryId)) throw new ProtocolValidationError()
  const positive = new Set([...tasks.flatMap((task) => task.required_memory_ids), ...retrievalCases.cases.flatMap((item) => item.expected_memory_ids)])
  const forbidden = new Set([...tasks.flatMap((task) => task.forbidden_memory_ids), ...retrievalCases.cases.flatMap((item) => item.forbidden_memory_ids)])
  for (const memory of catalog.memories) if (memory.lifecycle === 'active' && !positive.has(memory.memory_id) || memory.lifecycle !== 'active' && !forbidden.has(memory.memory_id)) throw new ProtocolValidationError()
  if (!Array.isArray(root.acquisitionCases) || root.acquisitionCases.length !== 4) throw new ProtocolValidationError()
  const acquisitionCases = root.acquisitionCases.map(validateAcquisitionCase)
  if (new Set(acquisitionCases.map((item) => item.case_id)).size !== 4) throw new ProtocolValidationError()
  for (const item of acquisitionCases) for (const memoryId of item.overlap_memory_ids) if (!memoryIdsSet.has(memoryId)) throw new ProtocolValidationError()
  if (acquisitionCases.some((item) => acquisitionDecision(item) !== item.expected_decision)) throw new ProtocolValidationError()
  const manifest = object(root.manifest)
  exactKeys(manifest, ['schema_version', 'fixture_version', 'files'])
  if (manifest.schema_version !== 1 || manifest.fixture_version !== 2 || !Array.isArray(manifest.files)) throw new ProtocolValidationError()
  const files = manifest.files.map((entry) => { const item = object(entry); exactKeys(item, ['relative_name', 'content_sha256']); if (typeof item.relative_name !== 'string') throw new ProtocolValidationError(); assertHash(item.content_sha256); return { relative_name: item.relative_name, content_sha256: item.content_sha256 } })
  const expectedFiles = ['acquisition-cases.json', 'memory-catalog.json', 'paired-tasks.json', 'protocol.json', 'retrieval-cases.json']
  if (JSON.stringify(files.map((entry) => entry.relative_name).sort()) !== JSON.stringify(expectedFiles.sort())) throw new ProtocolValidationError()
  if (new Set(files.map((entry) => entry.relative_name)).size !== files.length) throw new ProtocolValidationError()
  const content = new Map(Object.entries({
    'protocol.json': root.protocol,
    'memory-catalog.json': catalog,
    'retrieval-cases.json': retrievalCases,
    'paired-tasks.json': { schema_version: 1, fixture_version: 2, tasks: root.tasks },
    'acquisition-cases.json': { schema_version: 1, fixture_version: 2, cases: root.acquisitionCases },
  }).map(([name, value]) => [name, canonicalHash(value)]))
  for (const [name, hash] of content) if (files.find((entry) => entry.relative_name === name)?.content_sha256 !== hash) throw new ProtocolValidationError()
  return { protocol: protocol as M05DFixtures['protocol'], catalog, retrievalCases, tasks, acquisitionCases, manifest: { schema_version: 1, fixture_version: 2, files } }
}

export async function loadM05Dv2Fixtures(): Promise<M05DFixtures> {
  const [protocol, catalog, retrievalCases, tasks, acquisitionCases, manifest] = await Promise.all([
    import('../../fixtures/m0.5/v2/protocol.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v2/memory-catalog.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v2/retrieval-cases.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v2/paired-tasks.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v2/acquisition-cases.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v2/fixture-manifest.json', { with: { type: 'json' } }),
  ])
  const result = validateM05Dv2Fixtures({ protocol: protocol.default, catalog: catalog.default, retrievalCases: retrievalCases.default, tasks: tasks.default.tasks, acquisitionCases: acquisitionCases.default.cases, manifest: manifest.default })
  const v1 = await Promise.all([
    import('../../fixtures/m0.5/v1/protocol.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/memory-catalog.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/retrieval-cases.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/paired-tasks.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/fixture-manifest.json', { with: { type: 'json' } }),
  ])
  const v1Entries = new Map((v1[4].default.files as Array<{ relative_name: string; content_sha256: string }>).map((entry) => [entry.relative_name, entry.content_sha256]))
  const v1Canonical = new Map([
    ['protocol.json', canonicalHash(validateEvaluationProtocol(v1[0].default))],
    ['memory-catalog.json', canonicalHash(validateMemoryCatalog(v1[1].default))],
    ['retrieval-cases.json', canonicalHash(validateRetrievalCases(v1[2].default))],
    ['paired-tasks.json', canonicalHash(validatePairedTasks(v1[3].default))],
  ])
  for (const name of Object.keys(V1_GOLDEN)) if (v1Entries.get(name) !== V1_GOLDEN[name as keyof typeof V1_GOLDEN] || v1Canonical.get(name) !== v1Entries.get(name)) throw new ProtocolValidationError()
  const byName = new Map(result.manifest.files.map((file) => [file.relative_name, file.content_sha256]))
  const actual = new Map(Object.entries({ 'protocol.json': protocol.default, 'memory-catalog.json': validateMemoryCatalog(catalog.default), 'retrieval-cases.json': validateRetrievalCases(retrievalCases.default), 'paired-tasks.json': tasks.default, 'acquisition-cases.json': acquisitionCases.default }).map(([name, value]) => [name, canonicalHash(value)]))
  for (const [name, hash] of actual) if (byName.get(name) !== hash) throw new ProtocolValidationError()
  return result
}

export interface ModelReceipt { schema_version: 1; task_id: string; exit_code: number; result: Record<string, string | number | boolean | null>; adopted_memory_ids: string[]; failure_code: string | null }
export function validateModelReceipt(raw: unknown, observedMemoryIds: readonly string[] = [], allowedResultFields?: readonly string[], expectedTaskId?: string): ModelReceipt {
  if (typeof raw !== 'string' || raw.length > 4000 || /```/.test(raw) || raw.trim() !== raw) throw new ProtocolValidationError()
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ProtocolValidationError() }
  const receipt = object(value); exactKeys(receipt, ['schema_version', 'task_id', 'exit_code', 'result', 'adopted_memory_ids', 'failure_code'])
  const exitCode = receipt.exit_code as number
  if (receipt.schema_version !== 1 || typeof receipt.task_id !== 'string') throw new ProtocolValidationError()
  id(receipt.task_id, 'task_')
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || receipt.failure_code !== null && !FAILURE_CODES.includes(receipt.failure_code as (typeof FAILURE_CODES)[number])) throw new ProtocolValidationError()
  if ((exitCode === 0) !== (receipt.failure_code === null)) throw new ProtocolValidationError()
  if (expectedTaskId !== undefined && receipt.task_id !== expectedTaskId) throw new ProtocolValidationError()
  const result = object(receipt.result); if (allowedResultFields && Object.keys(result).some((key) => !allowedResultFields.includes(key))) throw new ProtocolValidationError()
  for (const item of Object.values(result)) {
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new ProtocolValidationError()
    if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) >= 1e21 || item !== 0 && Math.abs(item) < 1e-6)) throw new ProtocolValidationError()
    if (typeof item === 'string' && /[\u0000-\u001f\u007f]/.test(item)) throw new ProtocolValidationError()
  }
  const adopted = memoryIds(receipt.adopted_memory_ids); const observed = new Set(observedMemoryIds); if (adopted.some((memoryId) => !observed.has(memoryId))) throw new ProtocolValidationError()
  return { schema_version: 1, task_id: receipt.task_id as string, exit_code: exitCode, result: result as ModelReceipt['result'], adopted_memory_ids: adopted, failure_code: receipt.failure_code as string | null }
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export function validateUsage(value: unknown): Usage {
  const usage = object(value); exactKeys(usage, ['inputTokens', 'outputTokens', ...usage.cacheReadTokens === undefined ? [] : ['cacheReadTokens'], ...usage.cacheWriteTokens === undefined ? [] : ['cacheWriteTokens'], ...usage.reasoningTokens === undefined ? [] : ['reasoningTokens']])
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)) throw new ProtocolValidationError()
  return usage as unknown as Usage
}

export interface OfflineReceipt { run_id: string; task_id: string; group: M05DGroup; requested_seed: number; seed_honored: false; evidence_kind: 'offline_fake_provider'; tool_calls: string[]; memory_events: string[]; recall_source: { kind: 'plugin'; plugin: 'dsh-mnemosyne'; form: 'recall' } | null; recall_context: RecallContextEnvelope | null; recall_receipt: RecallContextReceipt | null; observed_memory_ids: string[]; retrieved_memory_ids: string[]; opened_memory_ids: string[]; adopted_memory_ids: string[]; model_exit_code: number; model_result: Record<string, string | number | boolean | null>; model_failure_code: ModelReceipt['failure_code']; model_call_count: number; usage: { model: Usage; retrieval_estimated_tokens: number; acquisition_tokens: number }; acquisition: { case_id: AcquisitionCase['case_id']; provider_calls: number; after_task_completed: boolean; decision: AcquisitionCase['case_id']; reason_code: AcquisitionReasonCode; candidate_content_sha256: string | null }; disposal_clean: boolean; success: boolean; canonical_hash: string }
export interface OfflineSummary { evidence_kind: 'offline_fake_provider'; receipts: OfflineReceipt[]; canonical_bytes: string; invariants: { run_count: boolean; group_isolation: boolean; tool_ordering: boolean; recall_source: boolean; replay_consistency: boolean; excluded_leakage: boolean; disposal_cleanliness: boolean; scripted_outcomes: boolean; acquisition_after_task: boolean; skip_zero_provider: boolean }; recommendation?: never }

export interface M05DAgentCallContext { provider: string; model: string; run_id: string; task_id: string; kind: 'task' | 'acquisition'; requested_seed: number; sequence: number }
export type M05DAgentAdapterFactory = (context: M05DAgentCallContext) => LlmAdapter
export interface M05DAgentLoopOptions {
  adapterFactory?: M05DAgentAdapterFactory
  claim?: (kind: 'task' | 'acquisition', context: Omit<M05DAgentCallContext, 'sequence'>) => number
  onTransportFinished?: (sequence: number) => void
  onComplete?: (sequence: number) => void
  onFail?: (sequence: number, error: unknown) => void
  run_id?: string
  requested_seed?: number
  provider?: string
  model?: string
  batchTimeoutMs?: number
  getBatchRemaining?: () => number
}

export class ProviderIdentityMismatchError extends ProtocolValidationError {}

class ClaimingAdapter extends LlmAdapter {
  constructor(
    private readonly factory: M05DAgentAdapterFactory,
    private readonly claim: (kind: 'task' | 'acquisition', context: Omit<M05DAgentCallContext, 'sequence'>) => number,
    private readonly kind: 'task' | 'acquisition',
    private readonly runId: string,
    private readonly taskId: string,
    private readonly requestedSeed: number,
    private readonly timeoutMs: number,
    private readonly callCounter: { value: number },
    private readonly factoryProvider?: string,
    private readonly factoryModel?: string,
    private readonly onTransportFinished?: (sequence: number) => void,
    private readonly onComplete?: (sequence: number) => void,
    private readonly onFail?: (sequence: number, error: unknown) => void,
    private readonly timeoutState?: { callTimedOut: boolean; batchTimedOut: boolean; protocolError: unknown },
    private readonly getBatchRemaining?: () => number,
  ) {
    super()
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'M0.5 evaluation adapter seam' }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const remainingBatch = this.getBatchRemaining ? this.getBatchRemaining() : this.timeoutMs
    if (remainingBatch <= 0) {
      if (this.timeoutState) this.timeoutState.batchTimedOut = true
      throw new M05DBatchTimeoutError()
    }
    const targetProvider = this.factoryProvider ?? options.provider
    const targetModel = this.factoryModel ?? options.model
    const context = {
      provider: targetProvider,
      model: targetModel,
      run_id: this.runId,
      task_id: this.taskId,
      kind: this.kind,
      requested_seed: this.requestedSeed,
    }
    const sequence = this.claim(this.kind, context)
    this.callCounter.value++
    let settledFail = false
    let isCallTimeout = false
    let isBatchTimeout = false
    const controller = new AbortController()

    const effectiveTimeoutMs = Math.min(this.timeoutMs, remainingBatch)
    const isBatchExpiringFirst = remainingBatch < this.timeoutMs

    let timeoutTimer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        if (isBatchExpiringFirst) {
          isBatchTimeout = true
          if (this.timeoutState) this.timeoutState.batchTimedOut = true
          const err = new M05DBatchTimeoutError()
          controller.abort(err)
          reject(err)
        } else {
          isCallTimeout = true
          if (this.timeoutState) this.timeoutState.callTimedOut = true
          const err = new M05DAgentTimeoutError()
          controller.abort(err)
          reject(err)
        }
      }, effectiveTimeoutMs)
    })

    const onParentAbort = () => {
      controller.abort(options.signal?.reason ?? new Error('aborted by parent signal'))
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onParentAbort()
      } else {
        options.signal.addEventListener('abort', onParentAbort, { once: true })
      }
    }

    let iterator: AsyncIterator<StreamChunk> | undefined
    try {
      const adapter = this.factory({ ...context, sequence })
      if (!(adapter instanceof LlmAdapter)) {
        throw new ProtocolValidationError()
      }
      const info = adapter.providerInfo(targetProvider)
      if (!info || typeof info !== 'object' || info.id !== targetProvider) {
        throw new ProviderIdentityMismatchError()
      }
      const streamIterable = adapter.stream({
        ...options,
        provider: targetProvider,
        model: targetModel,
        signal: controller.signal,
      })
      iterator = streamIterable[Symbol.asyncIterator]()

      let isToolCall = false
      while (true) {
        const nextResult = await Promise.race([
          iterator.next(),
          timeoutPromise,
        ])
        if (nextResult.done) {
          break
        }
        if (isBatchTimeout) {
          throw new M05DBatchTimeoutError()
        }
        if (isCallTimeout) {
          throw new M05DAgentTimeoutError()
        }
        const chunk = nextResult.value
        if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'finish' && chunk.reason.kind === 'tool-calls')) {
          isToolCall = true
        }
        yield chunk
      }
      clearTimeout(timeoutTimer)
      this.onTransportFinished?.(sequence)
      if (isToolCall && this.kind === 'task') {
        this.onComplete?.(sequence)
      }
    } catch (error) {
      clearTimeout(timeoutTimer)
      if (!settledFail) {
        settledFail = true
        this.onFail?.(sequence, error)
      }
      if (iterator?.return) {
        try {
          void Promise.race([
            iterator.return(),
            new Promise((resolve) => setTimeout(resolve, 10)),
          ]).catch(() => {})
        } catch {}
      }
      throw error
    } finally {
      clearTimeout(timeoutTimer)
      if (options.signal) {
        options.signal.removeEventListener('abort', onParentAbort)
      }
      controller.abort()
    }
  }
}

export class FakeProvider extends LlmAdapter {
  private readonly state: { calls: number }
  constructor(...states: [{ calls: number }?]) { super(); this.state = states[0] ?? { calls: 0 } }
  get callCount(): number { return this.state.calls }
  providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'M0.5D offline fake provider' } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.state.calls += 1
    const toolNames = new Set((options.tools ?? []).map((tool) => tool.name))
    let block: StreamChunk extends infer _ ? ({ type: 'text'; text: string } | { type: 'tool-call'; id: ReturnType<typeof CallId>; name: string; arguments: string }) : never
    const messageText = (message: GenerateOptions['messages'][number]) => message.content.flatMap((content) => content.type === 'text' ? [content.text] : content.type === 'tool-result' ? content.content.flatMap((block) => block.type === 'text' ? [block.text] : []) : [])
    const visible = options.messages.flatMap(messageText).join('\n')
    const visibleUserText = options.messages.filter((message) => message.role === 'user').flatMap(messageText).join('\n')
    const visibleMemorySource = visibleUserText.replace(/M05D_TASK_SHAPE\n\{[^\n]+\}/g, '')
    const recallText = options.messages.filter((message) => message.source.kind === 'plugin' && message.source.form === 'recall').flatMap(messageText).find((text) => text.startsWith(RECALL_PREFIX))
    const recalledContext = recallText ? replayRecallContext(recallText.slice(RECALL_PREFIX.length).trimStart().split('\n')[0]) : undefined
    const recalledMemoryIds = recalledContext?.memory_ids ?? []
    const visibleMemoryIds = recalledMemoryIds.length > 0 ? recalledMemoryIds : [...new Set([...visibleMemorySource.matchAll(/"memory_id":"(memory_[a-z0-9][a-z0-9._-]{0,63})"/g)].map((match) => match[1]))]
    const hasFixtureResult = visible.includes('"fixture_id"')
    const hasSearchDisclosure = visible.includes('"items"') && visible.includes('"retrieval_ref"')
    const hasOpenDisclosure = visible.includes('"body"') && visible.includes('"memory_id"')
    if (!hasFixtureResult && toolNames.has('m05d_task_fixture')) {
      block = { type: 'tool-call', id: CallId('m05d-task-fixture'), name: 'm05d_task_fixture', arguments: JSON.stringify({ task_id: visible.match(/task_id:(task_[a-z0-9][a-z0-9._-]{0,63})/)?.[1] ?? 'task_missing' }) }
    }
    else if (hasFixtureResult && !hasSearchDisclosure && toolNames.has('mnemosyne_search')) {
      const query = visibleUserText.split('\n').filter((line) => !line.startsWith('M05D_TASK_SHAPE') && !line.startsWith('task_id:')).at(-1) ?? 'offline synthetic task'
      block = { type: 'tool-call', id: CallId('m05d-search'), name: 'mnemosyne_search', arguments: JSON.stringify({ query }) }
    }
    else if (hasSearchDisclosure && !hasOpenDisclosure && toolNames.has('mnemosyne_open')) {
      const searchText = visibleUserText.split('\n').reverse().find((line) => line.includes('"items"') && line.includes('"retrieval_ref"'))
      if (!searchText) throw new ProtocolValidationError()
      const searchDisclosure = validateSearchDisclosure(JSON.parse(searchText))
      block = { type: 'tool-call', id: CallId('m05d-open'), name: 'mnemosyne_open', arguments: JSON.stringify({ memory_id: searchDisclosure.items[0].memory_id, retrieval_id: searchDisclosure.retrieval_ref, search_disclosure_sha256: searchDisclosure.content_sha256 }) }
    } else {
      const shapeMatch = visibleUserText.match(/M05D_TASK_SHAPE\n(\{[^\n]+\})/)
      const shape = shapeMatch ? JSON.parse(shapeMatch[1]) as { task_id: string; result_fields: string[] } : undefined
      const taskId = shape?.task_id ?? visible.match(/task_id:(task_[a-z0-9][a-z0-9._-]{0,63})/)?.[1] ?? 'task_missing'
      const openText = recallText === undefined ? visibleUserText.split('\n').reverse().find((line) => line.includes('"body"') && line.includes('"memory_id"')) : undefined
      const adopted = openText ? [validateOpenDisclosure(JSON.parse(openText)).memory_id] : visibleMemoryIds
      const outcome = deterministicResult(shape, `${visible}\n${recalledContext ? JSON.stringify(recalledContext) : ''}`, adopted.length > 0)
      block = { type: 'text', text: JSON.stringify({ schema_version: 1, task_id: taskId, exit_code: outcome.exitCode, result: outcome.result, adopted_memory_ids: adopted, failure_code: outcome.failureCode }) }
    }
    if (block.type === 'tool-call') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FakeAcquisitionProvider extends LlmAdapter {
  private readonly state: { calls: number }
  constructor(...states: [{ calls: number }?]) { super(); this.state = states[0] ?? { calls: 0 } }
  get callCount(): number { return this.state.calls }
  providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'M0.5D offline acquisition provider' } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.state.calls += 1
    const episode = options.messages.flatMap((message) => message.content.flatMap((content) => content.type === 'text' ? [content.text] : [])).join(' ').trim()
    const output = { title: 'Offline synthetic candidate', summary: episode, redaction_status: 'passed' as const }
    const text = JSON.stringify(output)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createTaskFixtureTool(taskId: string): ReturnType<typeof defineTool> {
  return defineTool({ name: 'm05d_task_fixture', description: 'Return the public synthetic task fixture identity; it is not a memory or expected-answer source.', parameters: { task_id: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { schema_version: { type: 'integer', required: true }, fixture_id: { type: 'string', required: true }, task_id: { type: 'string', required: true } } } as never, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args: unknown) => { const input = object(args); exactKeys(input, ['task_id']); if (input.task_id !== taskId) throw new ProtocolValidationError(); return { schema_version: 1, fixture_id: `fixture_${taskId}`, task_id: taskId } } } as never)
}

export async function runAgentLoopEvidence(task: M05DTask, group: M05DGroup, catalog: MemoryCatalog, acquisitionCase: AcquisitionCase, callTimeoutMs: number, options: M05DAgentLoopOptions = {}): Promise<{ toolCalls: string[]; memoryEvents: string[]; recallSource: OfflineReceipt['recall_source']; recallContext: RecallContextEnvelope | null; recallReceipt: RecallContextReceipt | null; usage: Usage; receipt: ModelReceipt; acquisition: OfflineReceipt['acquisition']; acquisitionTokens: number; observedMemoryIds: string[]; retrievedMemoryIds: string[]; openedMemoryIds: string[]; disposalClean: boolean; retrievalEstimatedTokens: number; modelCallCount: number; duration_ms: number }> {
  const ctx = new Context()
  const fibers = [] as Array<{ dispose(): Promise<void> }>
  const registrations = [] as Array<() => void>
  let result: Omit<Awaited<ReturnType<typeof runAgentLoopEvidence>>, 'disposalClean' | 'duration_ms'> | undefined
  let llmRuntime: LlmRuntime | undefined
  let toolRuntime: ToolRuntime | undefined
  let recallContext: RecallContextEnvelope | null = null
  let recallReceipt: RecallContextReceipt | null = null
  let recallSource: OfflineReceipt['recall_source'] = null
  const runStarted = performance.now()
  const taskSequences: number[] = []
  let acquisitionSequence: number | undefined
  try {
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime]) fibers.push(await ctx.plugin(plugin))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    llmRuntime = ctx.llm
    toolRuntime = ctx.tools
    registrations.push(ctx.tools.register(createTaskFixtureTool(task.task_id)))
    const runtime = group === 'no_memory' ? undefined : new RetrievalRuntime(catalog)
    if (group === 'tool_only' && task.task_kind === 'memory_dependent' && runtime !== undefined) { registrations.push(ctx.tools.register(createSearchTool(runtime)), ctx.tools.register(createOpenTool(runtime))) }
    const fakeProvider = new FakeProvider(); const taskCallCounter = { value: 0 }; const runId = options.run_id ?? `m05d-${group}-${task.task_id}`; const requestedSeed = options.requested_seed ?? 0
    const timeoutState = { callTimedOut: false, batchTimedOut: false, protocolError: undefined as unknown }
    const claimTask = (kind: 'task' | 'acquisition', c: Omit<M05DAgentCallContext, 'sequence'>) => {
      const seq = options.claim!(kind, c)
      taskSequences.push(seq)
      return seq
    }
    const taskAdapter = options.adapterFactory && options.claim ? new ClaimingAdapter(options.adapterFactory, claimTask, 'task', runId, task.task_id, requestedSeed, callTimeoutMs, taskCallCounter, options.provider, options.model, options.onTransportFinished, options.onComplete, (seq, err) => { if (err instanceof M05DBatchTimeoutError) timeoutState.batchTimedOut = true; if (err instanceof M05DAgentTimeoutError) timeoutState.callTimedOut = true; if (err instanceof ProtocolValidationError) timeoutState.protocolError = err; options.onFail?.(seq, err) }, timeoutState, options.getBatchRemaining) : fakeProvider
    registrations.push(ctx.llm.registerAdapter(['m05d-fake'], taskAdapter))
    const agent = (ctx as Context & { agentLoop: AgentLoop }).agentLoop.create(SessionId(`m05d-${group}-${task.task_id}`), { provider: 'm05d-fake', model: 'offline' })
    if (group === 'auto_inject' && task.task_kind === 'memory_dependent') {
      if (runtime === undefined) throw new ProtocolValidationError()
      const search = runtime.search({ query: task.prompt, top_k: 5 }); const opens = search.items.slice(0, 2).filter((item) => item.score_fixed > 0).map((item) => runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: item.memory_id }))
      if (opens.length === 0) throw new ProtocolValidationError()
      const context = createRecallContext(search, opens); const receipt = createRecallReceipt(context)
      recallContext = context; recallReceipt = receipt; recallSource = { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' }
      agent.inject(createUserMessage({ content: [{ type: 'text', text: `${RECALL_PREFIX}\n${encodeRecallContext(context)}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } }))
    }
    const resultFields = task.success_assertions.filter((assertion) => assertion.kind === 'result_equals').map((assertion) => assertion.field as string)
    agent.inject(createUserMessage({ content: [{ type: 'text', text: `M05D_TASK_SHAPE\n${JSON.stringify({ task_id: task.task_id, result_fields: resultFields })}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice', summary: 'offline task fixture' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `task_id:${task.task_id}\n${task.prompt}` }], source: { kind: 'user' } }))
    const batchTimeoutMs = options.getBatchRemaining ? options.getBatchRemaining() : (options.batchTimeoutMs ?? callTimeoutMs)
    if (batchTimeoutMs <= 0) throw new M05DBatchTimeoutError()
    await withTimeout(agent.whenIdle(), batchTimeoutMs, () => new M05DBatchTimeoutError())
    if (timeoutState.protocolError) throw timeoutState.protocolError
    if (timeoutState.batchTimedOut) throw new M05DBatchTimeoutError()
    if (timeoutState.callTimedOut) throw new M05DAgentTimeoutError()
    const actualTaskCalls = options.adapterFactory && options.claim ? taskCallCounter.value : fakeProvider.callCount
    if (actualTaskCalls < 1 || actualTaskCalls > 4) throw new ProtocolValidationError()
    const events = agent.session.events
    const toolCalls = events.filter((event: (typeof events)[number]) => event.type === 'tool/call').map((event: (typeof events)[number] & { type: 'tool/call' }) => event.data.name)
    const memoryEvents = events.filter((event: (typeof events)[number]) => event.type === 'user/message').map((event: (typeof events)[number] & { type: 'user/message' }) => event.data.source.kind === 'plugin' && event.data.source.form === 'recall' ? 'recall_user_message' : 'user_message')
    const usageEvents = events.filter((event: (typeof events)[number]) => event.type === 'assistant/message').flatMap((event: (typeof events)[number] & { type: 'assistant/message' }) => event.data.usage ? [validateUsage(event.data.usage)] : [])
    if (usageEvents.length === 0) throw new ProtocolValidationError()
    const usage = usageEvents.reduce((total, item) => ({ inputTokens: total.inputTokens + item.inputTokens, outputTokens: total.outputTokens + item.outputTokens, ...(total.cacheReadTokens !== undefined || item.cacheReadTokens !== undefined ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (item.cacheReadTokens ?? 0) } : {}), ...(total.cacheWriteTokens !== undefined || item.cacheWriteTokens !== undefined ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (item.cacheWriteTokens ?? 0) } : {}), ...(total.reasoningTokens !== undefined || item.reasoningTokens !== undefined ? { reasoningTokens: (total.reasoningTokens ?? 0) + (item.reasoningTokens ?? 0) } : {}) }), { inputTokens: 0, outputTokens: 0 } as Usage)
    const assistant = [...events].reverse().find((event: (typeof events)[number]) => event.type === 'assistant/message' && event.data.message.content.length === 1 && event.data.message.content[0].type === 'text')
    if (!assistant || assistant.type !== 'assistant/message' || assistant.data.message.content.length !== 1 || assistant.data.message.content[0].type !== 'text') throw new ProtocolValidationError()
    const taskComplete = agent.session.events.some((event) => event.type === 'turn/end')
    if (!taskComplete) throw new ProtocolValidationError()
    const textMemoryIds = (text: string) => [...text.matchAll(/"memory_id":"(memory_[a-z0-9][a-z0-9._-]{0,63})"/g)].map((match) => match[1])
    const recallTexts = events.filter((event: (typeof events)[number]) => event.type === 'user/message').flatMap((event: (typeof events)[number] & { type: 'user/message' }) => event.data.source.kind === 'plugin' && event.data.source.form === 'recall' ? event.data.content.flatMap((content) => content.type === 'text' ? [content.text] : []) : [])
    const recallContexts = recallTexts.map((text) => text.startsWith(RECALL_PREFIX) ? replayRecallContext(text.slice(RECALL_PREFIX.length).trimStart()) : (() => { throw new ProtocolValidationError() })())
    const recallMemoryIds = recallTexts.flatMap(textMemoryIds)
    const toolResultTexts = events.filter((event: (typeof events)[number]) => event.type === 'tool/result').flatMap((event: (typeof events)[number] & { type: 'tool/result' }) => event.data.message.content.flatMap((content) => content.type === 'tool-result' ? content.content.flatMap((block) => block.type === 'text' ? [block.text] : []) : []))
    const toolMemoryIds = toolResultTexts.flatMap(textMemoryIds)
    const toolResultValues = toolResultTexts.map((text) => { try { return object(JSON.parse(text)) } catch { throw new ProtocolValidationError() } })
    const searchDisclosures = toolResultValues.filter((value) => Array.isArray(value.items)).map(validateSearchDisclosure)
    const openDisclosures = toolResultValues.filter((value) => typeof value.body === 'string').map(validateOpenDisclosure)
    const retrievedMemoryIds = [...new Set(toolCalls.includes('mnemosyne_search') ? searchDisclosures.flatMap((disclosure) => disclosure.items.map((item) => item.memory_id)) : recallContexts.flatMap((context) => context.search_disclosure.items.map((item) => item.memory_id)))].sort()
    const openedMemoryIds = [...new Set(toolCalls.includes('mnemosyne_open') ? openDisclosures.map((disclosure) => disclosure.memory_id) : recallContexts.flatMap((context) => context.open_disclosures.map((item) => item.memory_id)))].sort()
    const observed = [...new Set([...recallMemoryIds, ...toolMemoryIds])].sort()
    const receipt = validateModelReceipt(assistant.data.message.content[0].text, observed, task.success_assertions.filter((assertion) => assertion.kind === 'result_equals').map((assertion) => assertion.field as string), task.task_id)
    if (receipt.adopted_memory_ids.some((memoryId) => !openedMemoryIds.includes(memoryId)) || openedMemoryIds.some((memoryId) => !retrievedMemoryIds.includes(memoryId))) throw new ProtocolValidationError()
    if (receipt.task_id !== task.task_id) throw new ProtocolValidationError()
    if (group === 'no_memory' && (JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']) || memoryEvents.some((event) => event === 'recall_user_message') || receipt.adopted_memory_ids.length !== 0)) throw new ProtocolValidationError()
    if (group === 'tool_only' && (task.task_kind === 'memory_dependent' ? JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']) : JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']))) throw new ProtocolValidationError()
    if (group === 'auto_inject' && (JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']) || (task.task_kind === 'memory_dependent' ? memoryEvents.filter((event) => event === 'recall_user_message').length !== 1 : memoryEvents.filter((event) => event === 'recall_user_message').length !== 0))) throw new ProtocolValidationError()
    const retrievalEstimatedTokens = [...toolResultTexts, ...recallTexts].reduce((total, text) => total + Math.max(1, text.trim().split(/\s+/).length), 0)
    if (memoryEvents.some((event) => !MEMORY_EVENT_VOCAB.includes(event as (typeof MEMORY_EVENT_VOCAB)[number])) || toolCalls.some((name) => !TOOL_VOCAB.includes(name as (typeof TOOL_VOCAB)[number]))) throw new ProtocolValidationError()

    // Settle final text ModelReceipt sequence as complete (fail-closed, no swallowed errors)
    const finalSequence = taskSequences.at(-1)
    if (finalSequence !== undefined) {
      options.onComplete?.(finalSequence)
    }

    let acquisitionTokens = 0; let providerCalls = 0
    let candidateContentSha256: string | null = null
    const decision = acquisitionDecision(acquisitionCase)
    if (decision === 'novel_candidate') {
      const remainingForAcquisition = options.getBatchRemaining ? options.getBatchRemaining() : (options.batchTimeoutMs ?? callTimeoutMs)
      if (remainingForAcquisition <= 0) {
        throw new M05DBatchTimeoutError()
      }
      const acquisitionCallCounter = { value: 0 }
      const claimAcq = (kind: 'task' | 'acquisition', c: Omit<M05DAgentCallContext, 'sequence'>) => {
        const seq = options.claim!(kind, c)
        acquisitionSequence = seq
        return seq
      }
      const onAcqFail = (seq: number, err: unknown) => {
        if (err instanceof M05DBatchTimeoutError) timeoutState.batchTimedOut = true
        if (err instanceof M05DAgentTimeoutError) timeoutState.callTimedOut = true
        if (err instanceof ProtocolValidationError) timeoutState.protocolError = err
        options.onFail?.(seq, err)
      }
      const acquisitionProvider = options.adapterFactory && options.claim ? new ClaimingAdapter(options.adapterFactory, claimAcq, 'acquisition', runId, task.task_id, requestedSeed, callTimeoutMs, acquisitionCallCounter, options.provider, options.model, options.onTransportFinished, options.onComplete, onAcqFail, timeoutState, options.getBatchRemaining) : new FakeAcquisitionProvider()
      registrations.push(ctx.llm.registerAdapter(['m05d-acquisition'], acquisitionProvider))
      const acquisitionCallTimeout = Math.min(callTimeoutMs, remainingForAcquisition)
      const isAcqBatchExpiring = remainingForAcquisition < callTimeoutMs
      const chunks = await withTimeout(
        (async () => {
          const collected: StreamChunk[] = []
          for await (const chunk of ctx.llm.stream({
            provider: 'm05d-acquisition',
            model: 'offline',
            messages: [createUserMessage({ content: [{ type: 'text', text: acquisitionCase.episode_summary }], source: { kind: 'user' } })],
          })) collected.push(chunk)
          return collected
        })(),
        acquisitionCallTimeout,
        isAcqBatchExpiring ? () => new M05DBatchTimeoutError() : () => new M05DAgentTimeoutError(),
      )
      if (timeoutState.protocolError) throw timeoutState.protocolError
      if (timeoutState.batchTimedOut) throw new M05DBatchTimeoutError()
      if (timeoutState.callTimedOut) throw new M05DAgentTimeoutError()
      const usages = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage').map((chunk) => validateUsage(chunk.usage))
      if (usages.length !== 1) {
        if (acquisitionSequence !== undefined) options.onFail?.(acquisitionSequence, new ProtocolValidationError())
        throw new ProtocolValidationError()
      }
      const candidateText = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta').map((chunk) => chunk.text).join(' ')
      let candidate: Record<string, unknown>
      try {
        candidate = object(JSON.parse(candidateText))
        exactKeys(candidate, ['title', 'summary', 'redaction_status'])
        if (candidate.redaction_status !== 'passed') throw new ProtocolValidationError()
        assertSafeText(candidate.title, 200)
        assertSafeText(candidate.summary, 1000)
      } catch (err) {
        if (acquisitionSequence !== undefined) options.onFail?.(acquisitionSequence, err)
        throw new ProtocolValidationError()
      }
      const actualAcquisitionCalls = options.adapterFactory && options.claim ? acquisitionCallCounter.value : (acquisitionProvider as FakeAcquisitionProvider).callCount
      if (actualAcquisitionCalls !== 1 || acquisitionCase.provider_output === null || canonicalBytes(candidate) !== canonicalBytes(acquisitionCase.provider_output)) {
        if (acquisitionSequence !== undefined) options.onFail?.(acquisitionSequence, new ProtocolValidationError())
        throw new ProtocolValidationError()
      }
      providerCalls = actualAcquisitionCalls
      candidateContentSha256 = canonicalHash(candidate)
      acquisitionTokens = usages[0].inputTokens + usages[0].outputTokens + (usages[0].cacheReadTokens ?? 0) + (usages[0].cacheWriteTokens ?? 0)
      if (acquisitionSequence !== undefined) {
        options.onComplete?.(acquisitionSequence)
      }
    }

    result = { toolCalls, memoryEvents, recallSource, recallContext, recallReceipt, usage: validateUsage(usage), receipt, acquisition: { case_id: acquisitionCase.case_id, provider_calls: providerCalls, after_task_completed: taskComplete, decision: acquisitionDecision(acquisitionCase), reason_code: acquisitionReasonCode(acquisitionCase), candidate_content_sha256: candidateContentSha256 }, acquisitionTokens, observedMemoryIds: observed, retrievedMemoryIds, openedMemoryIds, retrievalEstimatedTokens, modelCallCount: options.adapterFactory && options.claim ? taskCallCounter.value : fakeProvider.callCount }
  } finally {
    for (const registration of registrations.reverse()) registration()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
  if (!result) throw new ProtocolValidationError()
  const disposalClean = llmRuntime !== undefined && toolRuntime !== undefined && llmRuntime.listProviders().length === 0 && toolRuntime.schemas().length === 0
  return { ...result, disposalClean, duration_ms: Math.max(0, Math.round(performance.now() - runStarted)) }
}

function deterministicResult(shape: { task_id: string; result_fields: string[] } | undefined, visibleText: string, hasMemory: boolean): { exitCode: number; result: Record<string, string | number | boolean | null>; failureCode: ModelReceipt['failure_code'] } {
  if (!shape || shape.result_fields.length > 1) throw new ProtocolValidationError()
  const result: Record<string, string | number | boolean | null> = {}
  const evidence = visibleText.toLowerCase()
  const control = visibleText.match(/fixed control value\s+([a-z0-9]+)/i)?.[1]
  const exitCode = control !== undefined || hasMemory ? 0 : 1
  const field = shape.result_fields[0]
  if (!field) return { exitCode, result, failureCode: exitCode === 0 ? null : 'memory_unavailable' }
  if (exitCode !== 0) { result[field] = null; return { exitCode, result, failureCode: 'memory_unavailable' } }
  if (control !== undefined) result[field] = /^\d+$/.test(control) ? Number(control) : control
  else if (field === 'rebuild_mode' && evidence.includes('smallest affected target')) result[field] = 'targeted'
  else if (field === 'canonical_paths_equal' && evidence.includes('same canonical macos location')) result[field] = true
  else if (field === 'active_workspace_selected' && evidence.includes('active workspace root')) result[field] = true
  else if (field === 'executable_kind' && evidence.includes('stable installed executable path')) result[field] = 'stable'
  else if (field === 'token_categories_separate' && evidence.includes('input and output usage separate')) result[field] = true
  else if (field === 'active_workspace_preserved' && evidence.includes('memory_workspace_scope')) result[field] = true
  return { exitCode, result, failureCode: null }
}

export async function runOfflineM05D(): Promise<OfflineSummary> {
  const fixtures = await loadM05Dv2Fixtures(); const receipts: OfflineReceipt[] = []; const batchStarted = Date.now()
  for (const task of fixtures.tasks) for (const group of GROUPS) for (const requested_seed of SEEDS) {
    if (Date.now() - batchStarted > fixtures.protocol.runner_limits.batch_timeout_ms) throw new ProtocolValidationError()
    const caseId = ACQUISITION_BY_SEED[requested_seed as keyof typeof ACQUISITION_BY_SEED]; const acquisitionCase = fixtures.acquisitionCases.find((item) => item.case_id === caseId); if (!acquisitionCase) throw new ProtocolValidationError()
    const loop = await runAgentLoopEvidence(task, group, fixtures.catalog, acquisitionCase, fixtures.protocol.runner_limits.call_timeout_ms); const toolCalls = loop.toolCalls
    const success = task.success_assertions.every((assertion) => assertion.kind === 'exit_code' ? loop.receipt.exit_code === assertion.expected : loop.receipt.result[assertion.field as string] === assertion.expected)
    const body = { run_id: `run_${canonicalHash({ evaluation_id: fixtures.protocol.evaluation_id, task_id: task.task_id, group, requested_seed }).slice(7, 23)}`, task_id: task.task_id, group, requested_seed, seed_honored: false as const, evidence_kind: 'offline_fake_provider' as const, tool_calls: toolCalls, memory_events: loop.memoryEvents, recall_source: loop.recallSource, recall_context: loop.recallContext, recall_receipt: loop.recallReceipt, observed_memory_ids: loop.observedMemoryIds, retrieved_memory_ids: loop.retrievedMemoryIds, opened_memory_ids: loop.openedMemoryIds, adopted_memory_ids: loop.receipt.adopted_memory_ids, model_exit_code: loop.receipt.exit_code, model_result: loop.receipt.result, model_failure_code: loop.receipt.failure_code, model_call_count: loop.modelCallCount, usage: { model: loop.usage, retrieval_estimated_tokens: loop.retrievalEstimatedTokens, acquisition_tokens: loop.acquisitionTokens }, acquisition: loop.acquisition, disposal_clean: loop.disposalClean, success }
    receipts.push({ ...body, canonical_hash: canonicalHash(body) })
  }
  const invariants = validateOfflineReceipts(receipts, fixtures)
  const canonical_bytes = canonicalBytes(receipts)
  return { evidence_kind: 'offline_fake_provider', receipts, canonical_bytes, invariants }
}

export function validateOfflineReceipts(receipts: readonly OfflineReceipt[], fixtures: M05DFixtures): OfflineSummary['invariants'] {
  const checked = validateM05Dv2Fixtures(fixtures)
  const { tasks, protocol, catalog, acquisitionCases } = checked
  const evaluationId = protocol.evaluation_id
  if (receipts.length !== 120) throw new ProtocolValidationError()
  const taskById = new Map(tasks.map((task) => [task.task_id, task]))
  if (taskById.size !== 8) throw new ProtocolValidationError()
  const forbiddenMemoryIds = new Set([...tasks.flatMap((task) => task.forbidden_memory_ids), ...(catalog?.memories.filter((memory) => memory.lifecycle !== 'active').map((memory) => memory.memory_id) ?? [])])
  const keys = receipts.map((receipt) => `${receipt.task_id}\0${receipt.group}\0${receipt.requested_seed}`)
  const runCount = new Set(keys).size === 120 && new Set(receipts.map((receipt) => receipt.run_id)).size === 120
  if (!runCount) throw new ProtocolValidationError()
  for (const receipt of receipts) {
    exactKeys(object(receipt), ['run_id', 'task_id', 'group', 'requested_seed', 'seed_honored', 'evidence_kind', 'tool_calls', 'memory_events', 'recall_source', 'recall_context', 'recall_receipt', 'observed_memory_ids', 'retrieved_memory_ids', 'opened_memory_ids', 'adopted_memory_ids', 'model_exit_code', 'model_result', 'model_failure_code', 'model_call_count', 'usage', 'acquisition', 'disposal_clean', 'success', 'canonical_hash'])
    const task = taskById.get(receipt.task_id)
    if (!task || !GROUPS.includes(receipt.group) || !SEEDS.includes(receipt.requested_seed as (typeof SEEDS)[number])) throw new ProtocolValidationError()
    const expectedRun = `run_${canonicalHash({ evaluation_id: evaluationId, task_id: receipt.task_id, group: receipt.group, requested_seed: receipt.requested_seed }).slice(7, 23)}`
    if (receipt.run_id !== expectedRun || receipt.evidence_kind !== 'offline_fake_provider' || receipt.seed_honored !== false || typeof receipt.success !== 'boolean' || !Number.isSafeInteger(receipt.model_call_count) || receipt.model_call_count < 1 || receipt.model_call_count > protocol.runner_limits.max_model_calls_per_task) throw new ProtocolValidationError()
    assertHash(receipt.canonical_hash)
    const { canonical_hash: _hash, ...body } = receipt
    if (canonicalHash(body) !== receipt.canonical_hash) throw new ProtocolValidationError()
    if (!Number.isSafeInteger(receipt.model_exit_code) || receipt.model_exit_code < 0 || receipt.model_exit_code > 255 || typeof receipt.model_result !== 'object' || receipt.model_result === null || Array.isArray(receipt.model_result)) throw new ProtocolValidationError()
    const allowedResultFields = task.success_assertions.filter((assertion) => assertion.kind === 'result_equals').map((assertion) => assertion.field as string)
    validateModelReceipt(JSON.stringify({ schema_version: 1, task_id: receipt.task_id, exit_code: receipt.model_exit_code, result: receipt.model_result, adopted_memory_ids: receipt.adopted_memory_ids, failure_code: receipt.model_failure_code }), receipt.opened_memory_ids, allowedResultFields, receipt.task_id)
    const usage = object(receipt.usage); exactKeys(usage, ['model', 'retrieval_estimated_tokens', 'acquisition_tokens']); validateUsage(receipt.usage.model)
    if (!Number.isSafeInteger(receipt.usage.retrieval_estimated_tokens) || receipt.usage.retrieval_estimated_tokens < 0 || !Number.isSafeInteger(receipt.usage.acquisition_tokens) || receipt.usage.acquisition_tokens < 0) throw new ProtocolValidationError()
    const uniqueSorted = (values: string[]) => values.length === new Set(values).size && JSON.stringify(values) === JSON.stringify([...values].sort())
    if (!uniqueSorted(receipt.observed_memory_ids) || !uniqueSorted(receipt.retrieved_memory_ids) || !uniqueSorted(receipt.opened_memory_ids) || !uniqueSorted(receipt.adopted_memory_ids)) throw new ProtocolValidationError()
    for (const ids of [receipt.observed_memory_ids, receipt.retrieved_memory_ids, receipt.opened_memory_ids, receipt.adopted_memory_ids]) { memoryIds(ids); if (ids.some((memoryId) => forbiddenMemoryIds.has(memoryId))) throw new ProtocolValidationError() }
    if ([...receipt.retrieved_memory_ids, ...receipt.opened_memory_ids, ...receipt.adopted_memory_ids].some((memoryId) => !receipt.observed_memory_ids.includes(memoryId)) || receipt.adopted_memory_ids.some((memoryId) => !receipt.opened_memory_ids.includes(memoryId)) || receipt.opened_memory_ids.some((memoryId) => !receipt.retrieved_memory_ids.includes(memoryId))) throw new ProtocolValidationError()
    const acquisition = object(receipt.acquisition); exactKeys(acquisition, ['case_id', 'provider_calls', 'after_task_completed', 'decision', 'reason_code', 'candidate_content_sha256'])
    const expectedCase = ACQUISITION_BY_SEED[receipt.requested_seed as keyof typeof ACQUISITION_BY_SEED]
    const acquisitionCase = acquisitionCases.find((item) => item.case_id === receipt.acquisition.case_id)
    if (!acquisitionCase || receipt.acquisition.case_id !== expectedCase || receipt.acquisition.after_task_completed !== true || receipt.acquisition.decision !== acquisitionDecision(acquisitionCase) || receipt.acquisition.reason_code !== acquisitionReasonCode(acquisitionCase) || !ACQUISITION_REASON_CODES.includes(receipt.acquisition.reason_code)) throw new ProtocolValidationError()
    if (!Number.isSafeInteger(receipt.acquisition.provider_calls) || receipt.acquisition.provider_calls < 0 || receipt.acquisition.provider_calls > protocol.runner_limits.max_acquisition_calls_per_run || (expectedCase === 'novel_candidate' ? receipt.acquisition.provider_calls !== 1 || acquisitionCase.provider_output === null || receipt.acquisition.candidate_content_sha256 !== canonicalHash(acquisitionCase.provider_output) : receipt.acquisition.provider_calls !== 0 || receipt.acquisition.candidate_content_sha256 !== null)) throw new ProtocolValidationError()
    if (receipt.acquisition.candidate_content_sha256 !== null) assertHash(receipt.acquisition.candidate_content_sha256)
    if (receipt.tool_calls.some((name) => !TOOL_VOCAB.includes(name as (typeof TOOL_VOCAB)[number])) || receipt.memory_events.some((event) => !MEMORY_EVENT_VOCAB.includes(event as (typeof MEMORY_EVENT_VOCAB)[number]))) throw new ProtocolValidationError()
    if (receipt.group === 'no_memory' && (JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) || receipt.observed_memory_ids.length !== 0 || receipt.retrieved_memory_ids.length !== 0 || receipt.opened_memory_ids.length !== 0 || receipt.adopted_memory_ids.length !== 0 || receipt.memory_events.some((event) => event === 'recall_user_message'))) throw new ProtocolValidationError()
    if (receipt.group === 'tool_only' && (task.task_kind === 'memory_dependent' ? JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']) : JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']))) throw new ProtocolValidationError()
    if (receipt.group === 'auto_inject' && (JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) || (task.task_kind === 'memory_dependent' ? receipt.memory_events.filter((event) => event === 'recall_user_message').length !== 1 || receipt.retrieved_memory_ids.length === 0 || receipt.opened_memory_ids.length === 0 : receipt.memory_events.filter((event) => event === 'recall_user_message').length !== 0 || receipt.observed_memory_ids.length !== 0))) throw new ProtocolValidationError()
    if (receipt.recall_context === null || receipt.recall_receipt === null || receipt.recall_source === null) {
      if (receipt.recall_context !== null || receipt.recall_receipt !== null || receipt.recall_source !== null || task.task_kind === 'memory_dependent' && receipt.group === 'auto_inject') throw new ProtocolValidationError()
    } else {
      if (JSON.stringify(receipt.recall_source) !== JSON.stringify({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' })) throw new ProtocolValidationError()
      const context = validateRecallContext(receipt.recall_context); const recallReceipt = validateRecallReceipt(receipt.recall_receipt)
      const contextRetrieved = context.search_disclosure.items.map((item) => item.memory_id).sort(); const contextOpened = context.open_disclosures.map((item) => item.memory_id).sort()
      if (recallReceipt.context_content_sha256 !== context.content_sha256 || JSON.stringify(recallReceipt.memory_ids) !== JSON.stringify(context.memory_ids) || JSON.stringify(contextRetrieved) !== JSON.stringify(receipt.retrieved_memory_ids) || JSON.stringify(contextOpened) !== JSON.stringify(receipt.opened_memory_ids) || context.memory_ids.some((memoryId) => forbiddenMemoryIds.has(memoryId)) || context.search_disclosure.items.some((item) => forbiddenMemoryIds.has(item.memory_id)) || context.open_disclosures.some((item) => forbiddenMemoryIds.has(item.memory_id))) throw new ProtocolValidationError()
      if (receipt.group !== 'auto_inject' || task.task_kind !== 'memory_dependent') throw new ProtocolValidationError()
    }
    if (task.task_kind === 'non_memory_control' && receipt.observed_memory_ids.length !== 0) throw new ProtocolValidationError()
    const expectedSuccess = task.task_kind === 'non_memory_control' || receipt.group !== 'no_memory'
    if (receipt.success !== expectedSuccess) throw new ProtocolValidationError()
  }
  const groupIsolation = GROUPS.every((group) => receipts.filter((receipt) => receipt.group === group).length === 40) && receipts.every((receipt) => { const task = taskById.get(receipt.task_id)!; return receipt.group === 'no_memory' ? JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture']) && receipt.observed_memory_ids.length === 0 : receipt.group === 'tool_only' ? task.task_kind === 'memory_dependent' ? JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']) : JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture']) : task.task_kind === 'memory_dependent' ? JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture']) && receipt.memory_events.filter((event) => event === 'recall_user_message').length === 1 : JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture']) && receipt.memory_events.filter((event) => event === 'recall_user_message').length === 0 })
  const toolOrdering = receipts.filter((receipt) => receipt.group === 'tool_only').every((receipt) => { const task = taskById.get(receipt.task_id)!; return task.task_kind === 'memory_dependent' ? JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']) : JSON.stringify(receipt.tool_calls) === JSON.stringify(['m05d_task_fixture']) })
  const recallSource = receipts.filter((receipt) => receipt.group === 'auto_inject').every((receipt) => { const task = taskById.get(receipt.task_id)!; return task.task_kind === 'memory_dependent' ? receipt.memory_events.filter((event) => event === 'recall_user_message').length === 1 : receipt.memory_events.filter((event) => event === 'recall_user_message').length === 0 })
  const replayConsistency = receipts.every((receipt) => { const { canonical_hash: _hash, ...body } = receipt; return canonicalHash(body) === receipt.canonical_hash })
  const excludedLeakage = receipts.every((receipt) => [...receipt.retrieved_memory_ids, ...receipt.opened_memory_ids, ...receipt.adopted_memory_ids].every((memoryId) => !forbiddenMemoryIds.has(memoryId)))
  const disposalCleanliness = receipts.every((receipt) => receipt.disposal_clean === true)
  const acquisitionAfterTask = receipts.every((receipt) => receipt.acquisition.after_task_completed)
  const skipZeroProvider = receipts.filter((receipt) => receipt.acquisition.case_id !== 'novel_candidate').every((receipt) => receipt.acquisition.provider_calls === 0)
  const scriptedOutcomes = receipts.every((receipt) => { const task = taskById.get(receipt.task_id)!; return task.success_assertions.every((assertion) => assertion.kind === 'exit_code' ? receipt.model_exit_code === assertion.expected : receipt.model_result[assertion.field as string] === assertion.expected) === receipt.success })
  const invariants = { run_count: runCount, group_isolation: groupIsolation, tool_ordering: toolOrdering, recall_source: recallSource, replay_consistency: replayConsistency, excluded_leakage: excludedLeakage, disposal_cleanliness: disposalCleanliness, scripted_outcomes: scriptedOutcomes, acquisition_after_task: acquisitionAfterTask, skip_zero_provider: skipZeroProvider }
  if (Object.values(invariants).some((value) => value !== true)) throw new ProtocolValidationError()
  return invariants
}

export { V1_GOLDEN }
