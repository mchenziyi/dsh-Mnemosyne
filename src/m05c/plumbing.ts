import { canonicalBytes, canonicalHash, compareCodePoints, ProtocolValidationError } from '../protocol/canonical.js'
import { encodeDisclosure, type DisclosureEnvelope } from '../protocol/retrieval.js'
import { fixtureManifestHash, type EvaluationProtocol, type FixtureManifest, type MemoryCatalog, type PairedTask, validateEvaluationProtocol, validateFixtureManifest, validateMemoryCatalog, validatePairedTasks, validateRetrievalCases } from '../protocol/evaluation.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { encodeRecallContext, replayRecallContext, validateRecallReceipt } from '../protocol/recall.js'
const RECALL_PREFIX = '[Mnemosyne Recall v1 — plugin generated; not user authored]'

export type PlumbingGroup = 'no_memory' | 'tool_only' | 'auto_inject'
const GROUPS: PlumbingGroup[] = ['no_memory', 'tool_only', 'auto_inject']

export interface FixtureTruth { protocol: EvaluationProtocol; manifest: FixtureManifest; manifestHash: string; tasks: PairedTask[]; catalog?: MemoryCatalog }

export interface AssertionResult { assertion_id: string; passed: boolean }
export interface PlumbingRunReceipt {
  schema_version: 1
  run_id: string
  evaluation_id: string
  fixture_manifest_sha256: string
  task_id: string
  group: PlumbingGroup
  requested_seed: number
  seed_honored: false
  adapter_kind: 'scripted_fixture'
  tool_calls: string[]
  context_source: 'none' | 'plugin_recall'
  recall_context_sha256: string | null
  recall_replay_verified: boolean
  retrieved_memory_ids: string[]
  opened_memory_ids: string[]
  visible_memory_ids: string[]
  assertion_results: AssertionResult[]
  success: boolean
  failure_code: string | null
  disposal_clean: boolean
  content_sha256: string
}

export interface PlumbingSummary {
  schema_version: 1
  summary_id: string
  evaluation_id: string
  fixture_manifest_sha256: string
  receipts: Record<PlumbingGroup, PlumbingRunReceipt[]>
  unique_receipt_hashes: string[]
  invariants: {
    group_isolation: boolean
    tool_ordering: boolean
    recall_source: boolean
    replay_consistency: boolean
    excluded_leakage: boolean
    disposal_cleanliness: boolean
    scripted_outcomes: boolean
  }
  status: 'pass' | 'fail'
  content_sha256: string
}

export interface PlumbingEvaluation { receipts: PlumbingRunReceipt[]; summary: PlumbingSummary }

async function loadBaseTruth(): Promise<FixtureTruth> {
  const [protocolJson, casesJson, tasksJson, manifestJson] = await Promise.all([
    import('../../fixtures/m0.5/v1/protocol.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/retrieval-cases.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/paired-tasks.json', { with: { type: 'json' } }),
    import('../../fixtures/m0.5/v1/fixture-manifest.json', { with: { type: 'json' }}),
  ])
  const protocol = validateEvaluationProtocol(protocolJson.default); const cases = validateRetrievalCases(casesJson.default); const tasks = validatePairedTasks(tasksJson.default); const manifest = validateFixtureManifest(manifestJson.default)
  const files = new Map(manifest.files.map((entry) => [entry.relative_name, entry.content_sha256]))
  if (files.get('protocol.json') !== canonicalHash(protocol) || files.get('retrieval-cases.json') !== canonicalHash(cases) || files.get('paired-tasks.json') !== canonicalHash(tasks)) throw new ProtocolValidationError()
  return { protocol, manifest, manifestHash: fixtureManifestHash(manifest), tasks: tasks.tasks }
}

async function loadFullTruth(base: FixtureTruth): Promise<FixtureTruth> {
  const catalogJson = await import('../../fixtures/m0.5/v1/memory-catalog.json', { with: { type: 'json' }})
  const catalog = validateMemoryCatalog(catalogJson.default); const entry = base.manifest.files.find((item) => item.relative_name === 'memory-catalog.json')
  if (!entry || entry.content_sha256 !== canonicalHash(catalog)) throw new ProtocolValidationError()
  return { ...base, catalog }
}

export async function loadEvaluationTruth(): Promise<FixtureTruth> {
  return loadFullTruth(await loadBaseTruth())
}

function stableRunId(truth: FixtureTruth, taskId: string, group: PlumbingGroup, seed: number): string {
  return `plumbing_${canonicalHash({ evaluation_id: truth.protocol.evaluation_id, fixture_manifest_sha256: truth.manifestHash, task_id: taskId, group, requested_seed: seed, adapter_kind: 'scripted_fixture' }).slice(7, 23)}`
}

function taskFor(truth: FixtureTruth, taskId: string): PairedTask { const task = truth.tasks.find((item) => item.task_id === taskId); if (!task) throw new ProtocolValidationError(); return task }

function withoutHash(value: Record<string, unknown>): Record<string, unknown> { const copy = { ...value }; delete copy.content_sha256; return copy }

const TOOL_NAMES = ['mnemosyne_search', 'mnemosyne_open', 'mnemosyne_eval_recall_context'] as const
const MEMORY_ID = /^memory_[a-z0-9][a-z0-9._-]{0,63}$/
const CONTROLLED_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function validatePlumbingReceipt(value: unknown, truth: FixtureTruth): PlumbingRunReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError()
  const input = value as Record<string, unknown>
  const keys = ['schema_version', 'run_id', 'evaluation_id', 'fixture_manifest_sha256', 'task_id', 'group', 'requested_seed', 'seed_honored', 'adapter_kind', 'tool_calls', 'context_source', 'recall_context_sha256', 'recall_replay_verified', 'retrieved_memory_ids', 'opened_memory_ids', 'visible_memory_ids', 'assertion_results', 'success', 'failure_code', 'disposal_clean', 'content_sha256']
  if (Object.keys(input).sort(compareCodePoints).join('\0') !== [...keys].sort(compareCodePoints).join('\0')) throw new ProtocolValidationError()
  const group = input.group as PlumbingGroup; const task = taskFor(truth, String(input.task_id)); const seeds = truth.protocol.model.requested_seeds
  if (input.schema_version !== 1 || input.evaluation_id !== truth.protocol.evaluation_id || input.fixture_manifest_sha256 !== truth.manifestHash || input.seed_honored !== false || input.adapter_kind !== 'scripted_fixture' || !GROUPS.includes(group) || typeof input.requested_seed !== 'number' || !seeds.includes(input.requested_seed) || typeof input.task_id !== 'string' || input.run_id !== stableRunId(truth, task.task_id, group, input.requested_seed)) throw new ProtocolValidationError()
  const arrays = ['tool_calls', 'retrieved_memory_ids', 'opened_memory_ids', 'visible_memory_ids'] as const
  for (const key of arrays) {
    if (!Array.isArray(input[key]) || (input[key] as unknown[]).some((item) => typeof item !== 'string')) throw new ProtocolValidationError()
    if (key !== 'tool_calls' && !(input[key] as string[]).every((item) => MEMORY_ID.test(item)) || key !== 'tool_calls' && new Set(input[key] as string[]).size !== (input[key] as string[]).length || key !== 'tool_calls' && JSON.stringify([...(input[key] as string[])].sort(compareCodePoints)) !== JSON.stringify(input[key])) throw new ProtocolValidationError()
  }
  if (!(input.tool_calls as string[]).every((item) => TOOL_NAMES.includes(item as typeof TOOL_NAMES[number]))) throw new ProtocolValidationError()
  const calls = input.tool_calls as string[]
  if (calls.filter((item) => item === 'mnemosyne_search').length > 1 || calls[0] === 'mnemosyne_open' || calls[0] === 'mnemosyne_eval_recall_context' || calls.filter((item) => item === 'mnemosyne_open').length > 2 || calls.filter((item) => item === 'mnemosyne_open').length !== (input.opened_memory_ids as string[]).length) throw new ProtocolValidationError()
  if (group === 'no_memory' && calls.length !== 0) throw new ProtocolValidationError()
  if (!calls.includes('mnemosyne_search') && (input.retrieved_memory_ids as string[]).length !== 0) throw new ProtocolValidationError()
  if (input.success && group !== 'no_memory' && (calls[0] !== 'mnemosyne_search' || calls.filter((item) => item === 'mnemosyne_search').length !== 1)) throw new ProtocolValidationError()
  const recallCallCount = calls.filter((item) => item === 'mnemosyne_eval_recall_context').length
  if (recallCallCount > 0 && (group !== 'auto_inject' || recallCallCount !== 1 || calls[calls.length - 1] !== 'mnemosyne_eval_recall_context')) throw new ProtocolValidationError()
  if (input.success && group === 'auto_inject' && recallCallCount !== 1) throw new ProtocolValidationError()
  if (recallCallCount === 1 && (input.opened_memory_ids as string[]).length < 1) throw new ProtocolValidationError()
  if (group !== 'auto_inject' && calls.includes('mnemosyne_eval_recall_context')) throw new ProtocolValidationError()
  const retrieved = input.retrieved_memory_ids as string[]; const opened = input.opened_memory_ids as string[]; const visible = input.visible_memory_ids as string[]
  if (opened.some((id) => !retrieved.includes(id)) || (group === 'no_memory' && (retrieved.length || opened.length || visible.length))) throw new ProtocolValidationError()
  if ((group === 'tool_only' && visible.join('\0') !== opened.join('\0')) || (group === 'auto_inject' && recallCallCount === 1 && visible.join('\0') !== opened.join('\0')) || (group === 'auto_inject' && recallCallCount === 0 && visible.length !== 0)) throw new ProtocolValidationError()
  const active = new Set((truth.catalog?.memories ?? []).filter((memory) => memory.lifecycle === 'active').map((memory) => memory.memory_id)); if (truth.catalog && [...retrieved, ...opened].some((id) => !active.has(id))) throw new ProtocolValidationError()
  if (!['none', 'plugin_recall'].includes(input.context_source as string) || (group !== 'auto_inject' && input.context_source !== 'none') || (recallCallCount === 1 && input.context_source !== 'plugin_recall') || (recallCallCount === 0 && input.context_source !== 'none')) throw new ProtocolValidationError()
  if (typeof input.recall_replay_verified !== 'boolean' || (input.recall_context_sha256 !== null && (typeof input.recall_context_sha256 !== 'string' || !/^sha256_[0-9a-f]{64}$/.test(input.recall_context_sha256))) || (input.context_source === 'none' && (input.recall_context_sha256 !== null || input.recall_replay_verified)) || (input.context_source === 'plugin_recall' && (!input.recall_context_sha256 || input.recall_replay_verified !== true)) || (group !== 'auto_inject' && (input.recall_context_sha256 !== null || input.recall_replay_verified))) throw new ProtocolValidationError()
  if (!Array.isArray(input.assertion_results) || input.assertion_results.length !== task.success_assertions.length || (input.assertion_results as unknown[]).some((item) => !item || typeof item !== 'object' || Object.keys(item as object).length !== 2 || typeof (item as Record<string, unknown>).assertion_id !== 'string' || !/^assert_[a-z0-9][a-z0-9._-]{0,63}$/.test((item as Record<string, unknown>).assertion_id as string) || typeof (item as Record<string, unknown>).passed !== 'boolean')) throw new ProtocolValidationError()
  const assertionResults = input.assertion_results as AssertionResult[]
  const expectedAssertionIds = task.success_assertions.map((item) => item.assertion_id).sort(compareCodePoints)
  if (new Set(assertionResults.map((item) => item.assertion_id)).size !== assertionResults.length || JSON.stringify(assertionResults.map((item) => item.assertion_id)) !== JSON.stringify(expectedAssertionIds) || typeof input.success !== 'boolean' || input.success !== assertionResults.every((item) => item.passed) || (input.success && input.failure_code !== null) || (!input.success && (typeof input.failure_code !== 'string' || !CONTROLLED_ID.test(input.failure_code))) || typeof input.disposal_clean !== 'boolean') throw new ProtocolValidationError()
  if (typeof input.content_sha256 !== 'string' || input.content_sha256 !== canonicalHash(withoutHash(input))) throw new ProtocolValidationError()
  return input as unknown as PlumbingRunReceipt
}

export function encodePlumbingReceipt(value: PlumbingRunReceipt, truth: FixtureTruth): string { return canonicalBytes(validatePlumbingReceipt(value, truth)) }

export function validateRecallExecution(execution: ToolExecutionResult): { contextSha256: string; replayVerified: true; memoryIds: string[]; visibleBodies: string[] } {
  if (execution.isError || !execution.additionalContexts || execution.additionalContexts.length !== 1) throw new ProtocolValidationError()
  const message = execution.additionalContexts[0]
  if (message.source.kind !== 'plugin' || message.source.plugin !== 'dsh-mnemosyne' || message.source.form !== 'recall' || message.content.length !== 1 || message.content[0].type !== 'text') throw new ProtocolValidationError()
  const text = message.content[0].text
  if (!text.startsWith(`${RECALL_PREFIX}\n`)) throw new ProtocolValidationError()
  const envelope = replayRecallContext(text.slice(RECALL_PREFIX.length + 1)); const recallReceipt = validateRecallReceipt(execution.value)
  if (recallReceipt.context_content_sha256 !== envelope.content_sha256 || recallReceipt.context_id !== envelope.context_id || recallReceipt.retrieval_id !== envelope.retrieval_id || JSON.stringify(recallReceipt.memory_ids) !== JSON.stringify(envelope.memory_ids)) throw new ProtocolValidationError()
  if (encodeRecallContext(envelope) !== text.slice(RECALL_PREFIX.length + 1)) throw new ProtocolValidationError()
  return { contextSha256: envelope.content_sha256, replayVerified: true, memoryIds: envelope.memory_ids, visibleBodies: envelope.open_disclosures.map((open) => open.body) }
}

function makeReceipt(truth: FixtureTruth, task: PairedTask, group: PlumbingGroup, seed: number, toolCalls: string[], contextSource: 'none' | 'plugin_recall', recallHash: string | null, replayVerified: boolean, retrieved: string[], opened: string[], visible: string[], result: Record<string, string | number | boolean>, failureCode: string | null, disposalClean: boolean): PlumbingRunReceipt {
  const assertionResults = task.success_assertions.map((assertion) => ({ assertion_id: assertion.assertion_id, passed: assertion.kind === 'exit_code' ? result.exit_code === assertion.expected : result[assertion.field] === assertion.expected }))
  const body = { schema_version: 1 as const, run_id: stableRunId(truth, task.task_id, group, seed), evaluation_id: truth.protocol.evaluation_id, fixture_manifest_sha256: truth.manifestHash, task_id: task.task_id, group, requested_seed: seed, seed_honored: false as const, adapter_kind: 'scripted_fixture' as const, tool_calls: toolCalls, context_source: contextSource, recall_context_sha256: recallHash, recall_replay_verified: replayVerified, retrieved_memory_ids: [...retrieved].sort(compareCodePoints), opened_memory_ids: [...opened].sort(compareCodePoints), visible_memory_ids: [...visible].sort(compareCodePoints), assertion_results: assertionResults, success: assertionResults.every((item) => item.passed), failure_code: assertionResults.every((item) => item.passed) ? null : failureCode, disposal_clean: disposalClean }
  const receipt = { ...body, content_sha256: canonicalHash(body) }
  return validatePlumbingReceipt(receipt, truth)
}

class ScriptedFixtureAdapter {
  run(_prompt: string, visible: string[]): { result: Record<string, string | number | boolean>; failureCode: string | null } {
    const text = visible.join('\n')
    const result: Record<string, string | number | boolean> = { exit_code: 1 }
    if (/targeted result|targeted rebuild/i.test(text)) result.rebuild_mode = 'targeted'
    if (/macos system alias|canonical identity/i.test(text)) result.canonical_paths_equal = true
    if (/active workspace root|workspace changes|active workspace/i.test(text)) { result.active_workspace_selected = true; result.active_workspace_preserved = true }
    if (/stable installed executable path/i.test(text)) result.executable_kind = 'stable'
    if (/input and output usage|acquisition and retrieval overhead/i.test(text)) result.token_categories_separate = true
    if (Object.keys(result).length > 1) result.exit_code = 0
    return { result, failureCode: result.exit_code === 0 ? null : 'missing_visible_memory' }
  }
}

export function runScriptedFixtureAdapter(prompt: string, visible: string[]): { result: Record<string, string | number | boolean>; failureCode: string | null } {
  return new ScriptedFixtureAdapter().run(prompt, visible)
}

async function createContext(withPlugin: boolean): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const { Context } = await import('@deepseek-ai/cordis'); const ctx = new Context(); const fibers: Array<{ dispose(): Promise<void> }> = []
  if (withPlugin) {
    try {
      const [{ default: ToolRuntime }, { default: SystemPrompt }, { apply, Config }] = await Promise.all([import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-system-prompt'), import('../index.js')])
      fibers.push(await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true }))
    } catch (error) { for (const item of fibers.reverse()) await item.dispose(); throw error }
  }
  return { ctx, dispose: async () => { for (const item of fibers.reverse()) await item.dispose() } }
}

async function executeTool(ctx: Context, name: string, args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(callId), name, arguments: args })
  if (result.isError) throw new ProtocolValidationError()
  return result.value as Record<string, unknown>
}

async function executeToolResult(ctx: Context, name: string, args: Record<string, unknown>, callId: string): Promise<import('@deepseek-ai/dsh-tools').ToolExecutionResult> {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(callId), name, arguments: args })
}

async function runOne(truth: FixtureTruth, task: PairedTask, group: PlumbingGroup, seed: number): Promise<PlumbingRunReceipt> {
  const { ctx, dispose } = await createContext(group !== 'no_memory')
  const toolCalls: string[] = []; const retrieved: string[] = []; const opened: string[] = []; const visible: string[] = []; let source: 'none' | 'plugin_recall' = 'none'; let failure: string | null = null; let recallHash: string | null = null; let replayVerified = false
  let receipt: PlumbingRunReceipt
  let disposalClean = false
  try {
    if (group === 'no_memory') {
      const outcome = new ScriptedFixtureAdapter().run(task.prompt, [])
      receipt = makeReceipt(truth, task, group, seed, toolCalls, source, null, false, retrieved, opened, [], outcome.result, outcome.failureCode, false)
    } else {
      toolCalls.push('mnemosyne_search'); const search = await executeTool(ctx, 'mnemosyne_search', { query: task.prompt, top_k: 5 }, `${group}-${task.task_id}-${seed}-search`)
      const searchDisclosure = encodeDisclosure(search as unknown as DisclosureEnvelope)
      const searchItems = search.items as Array<Record<string, unknown>>; for (const item of searchItems) retrieved.push(item.memory_id as string)
      const opens: Record<string, unknown>[] = []
      for (const item of searchItems.slice(0, 2)) { if ((item.score_fixed as number) <= 0) continue; const open = await executeTool(ctx, 'mnemosyne_open', { retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: item.memory_id }, `${group}-${task.task_id}-${seed}-open-${item.memory_id}`); toolCalls.push('mnemosyne_open'); opens.push(open); opened.push(open.memory_id as string); if (group === 'tool_only') visible.push(open.body as string) }
      if (group === 'auto_inject') {
        const { createRecallContextTool } = await import('../recall-tool.js')
        const unregister = ctx.tools.register(createRecallContextTool())
        try {
          const execution = await executeToolResult(ctx, 'mnemosyne_eval_recall_context', { search_disclosure_json: searchDisclosure, open_disclosure_jsons: opens.map((item) => encodeDisclosure(item as unknown as DisclosureEnvelope)) }, `${group}-${task.task_id}-${seed}-recall`)
          const validated = validateRecallExecution(execution)
          recallHash = validated.contextSha256; replayVerified = validated.replayVerified; source = 'plugin_recall'; toolCalls.push('mnemosyne_eval_recall_context'); visible.push(...validated.visibleBodies)
        } finally { unregister() }
      }
      const outcome = new ScriptedFixtureAdapter().run(task.prompt, visible)
      receipt = makeReceipt(truth, task, group, seed, toolCalls, source, recallHash, replayVerified, retrieved, opened, opened, outcome.result, outcome.failureCode, false)
    }
  } catch { failure = 'retrieval_protocol_error'; receipt = makeReceipt(truth, task, group, seed, toolCalls, source, recallHash, replayVerified, retrieved, opened, source === 'plugin_recall' ? opened : [], { exit_code: 1 }, failure, false) }
  finally {
    await dispose()
    disposalClean = !ctx.tools || ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_eval_recall_context'].every((name) => ctx.tools.get(name) === undefined)
  }
  const body = { ...receipt, disposal_clean: disposalClean }; delete (body as Partial<PlumbingRunReceipt>).content_sha256
  return validatePlumbingReceipt({ ...body, content_sha256: canonicalHash(body) }, truth)
}

function deriveInvariants(receipts: PlumbingRunReceipt[], truth: FixtureTruth): PlumbingSummary['invariants'] {
  const expectedRuns = new Set(truth.tasks.flatMap((task) => GROUPS.flatMap((group) => truth.protocol.model.requested_seeds.map((seed) => stableRunId(truth, task.task_id, group, seed)))))
  const active = new Set((truth.catalog?.memories ?? []).filter((memory) => memory.lifecycle === 'active').map((memory) => memory.memory_id))
  const excluded = new Set((truth.catalog?.memories ?? []).filter((memory) => memory.lifecycle !== 'active').map((memory) => memory.memory_id))
  const groupIsolation = receipts.length === expectedRuns.size && new Set(receipts.map((receipt) => receipt.run_id)).size === expectedRuns.size && receipts.every((receipt) => expectedRuns.has(receipt.run_id)) && GROUPS.every((group) => receipts.filter((receipt) => receipt.group === group).length === truth.tasks.length * truth.protocol.model.requested_seeds.length)
  const ordering = receipts.every((receipt) => {
    const expected = receipt.group === 'no_memory' || receipt.tool_calls.length === 0 ? [] : ['mnemosyne_search', ...receipt.tool_calls.filter((item) => item === 'mnemosyne_open'), ...(receipt.tool_calls.includes('mnemosyne_eval_recall_context') ? ['mnemosyne_eval_recall_context'] : [])]
    const complete = receipt.group === 'no_memory' ? receipt.tool_calls.length === 0 : receipt.tool_calls[0] === 'mnemosyne_search' && receipt.opened_memory_ids.length >= 1 && (receipt.group !== 'auto_inject' || receipt.tool_calls.filter((item) => item === 'mnemosyne_eval_recall_context').length === 1)
    return complete && receipt.tool_calls.join('\0') === expected.join('\0')
  })
  const recall = receipts.every((receipt) => receipt.group === 'auto_inject' ? (receipt.tool_calls.filter((item) => item === 'mnemosyne_eval_recall_context').length === 1 && receipt.context_source === 'plugin_recall' && receipt.tool_calls.at(-1) === 'mnemosyne_eval_recall_context') : receipt.context_source === 'none' && !receipt.tool_calls.includes('mnemosyne_eval_recall_context'))
  const noLeak = receipts.every((receipt) => [...receipt.retrieved_memory_ids, ...receipt.opened_memory_ids, ...receipt.visible_memory_ids].every((id) => active.has(id) && !excluded.has(id)))
  const replay = receipts.every((receipt) => receipt.group !== 'auto_inject' || receipt.tool_calls.includes('mnemosyne_eval_recall_context') === Boolean(receipt.recall_context_sha256 && receipt.recall_replay_verified))
  const scriptedOutcomes = receipts.every((receipt) => receipt.group === 'no_memory' ? !receipt.success : receipt.success)
  return { group_isolation: groupIsolation, tool_ordering: ordering, recall_source: recall, replay_consistency: replay, excluded_leakage: noLeak, disposal_cleanliness: receipts.every((receipt) => receipt.disposal_clean), scripted_outcomes: scriptedOutcomes }
}

function summaryFrom(receipts: PlumbingRunReceipt[], truth: FixtureTruth): PlumbingSummary {
  const grouped = Object.fromEntries(GROUPS.map((group) => [group, receipts.filter((receipt) => receipt.group === group).sort((a, b) => compareCodePoints(a.run_id, b.run_id))])) as PlumbingSummary['receipts']
  const hashes = receipts.map((receipt) => receipt.content_sha256).sort(compareCodePoints)
  const invariants = deriveInvariants(receipts, truth)
  const base = { schema_version: 1 as const, summary_id: `plumbing_summary_${canonicalHash({ evaluation_id: truth.protocol.evaluation_id, fixture_manifest_sha256: truth.manifestHash, hashes }).slice(7, 23)}`, evaluation_id: truth.protocol.evaluation_id, fixture_manifest_sha256: truth.manifestHash, receipts: grouped, unique_receipt_hashes: hashes, invariants, status: Object.values(invariants).every(Boolean) ? 'pass' as const : 'fail' as const }
  return { ...base, content_sha256: canonicalHash(base) }
}

function validatePlumbingSummaryWithTruth(value: unknown, truth: FixtureTruth): PlumbingSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError()
  const input = value as Record<string, unknown>
  const keys = ['schema_version', 'summary_id', 'evaluation_id', 'fixture_manifest_sha256', 'receipts', 'unique_receipt_hashes', 'invariants', 'status', 'content_sha256']
  if (Object.keys(input).sort(compareCodePoints).join('\0') !== [...keys].sort(compareCodePoints).join('\0') || input.schema_version !== 1 || input.evaluation_id !== truth.protocol.evaluation_id || input.fixture_manifest_sha256 !== truth.manifestHash || typeof input.summary_id !== 'string' || !/^plumbing_summary_[a-z0-9]{16}$/.test(input.summary_id as string) || !['pass', 'fail'].includes(input.status as string)) throw new ProtocolValidationError()
  if (!input.receipts || typeof input.receipts !== 'object' || Array.isArray(input.receipts) || Object.keys(input.receipts).sort().join('\0') !== GROUPS.slice().sort().join('\0')) throw new ProtocolValidationError()
  const grouped = input.receipts as Record<string, unknown>; const all: PlumbingRunReceipt[] = []
  for (const group of GROUPS) { if (!Array.isArray(grouped[group]) || grouped[group].length !== truth.tasks.length * truth.protocol.model.requested_seeds.length) throw new ProtocolValidationError(); let previous = ''; for (const item of grouped[group] as unknown[]) { const checked = validatePlumbingReceipt(item, truth); if (checked.group !== group || (previous && compareCodePoints(previous, checked.run_id) >= 0)) throw new ProtocolValidationError(); previous = checked.run_id; all.push(checked) } }
  const hashes = all.map((item) => item.content_sha256).sort(compareCodePoints)
  if (!Array.isArray(input.unique_receipt_hashes) || input.unique_receipt_hashes.length !== all.length || new Set(input.unique_receipt_hashes as string[]).size !== all.length || JSON.stringify(input.unique_receipt_hashes) !== JSON.stringify(hashes)) throw new ProtocolValidationError()
  const expectedInvariants = deriveInvariants(all, truth)
  if (!input.invariants || typeof input.invariants !== 'object' || Object.keys(input.invariants as object).sort().join('\0') !== ['excluded_leakage', 'group_isolation', 'recall_source', 'replay_consistency', 'disposal_cleanliness', 'tool_ordering', 'scripted_outcomes'].sort().join('\0')) throw new ProtocolValidationError()
  if (JSON.stringify(input.invariants) !== JSON.stringify(expectedInvariants) || input.status !== (Object.values(expectedInvariants).every(Boolean) ? 'pass' : 'fail') || input.content_sha256 !== canonicalHash(withoutHash(input))) throw new ProtocolValidationError()
  const expectedId = `plumbing_summary_${canonicalHash({ evaluation_id: truth.protocol.evaluation_id, fixture_manifest_sha256: truth.manifestHash, hashes }).slice(7, 23)}`
  if (input.summary_id !== expectedId) throw new ProtocolValidationError()
  return input as unknown as PlumbingSummary
}

export async function summarizePlumbing(receipts: PlumbingRunReceipt[]): Promise<PlumbingSummary> {
  const truth = await loadFullTruth(await loadBaseTruth())
  return validatePlumbingSummaryWithTruth(summaryFrom(receipts.map((item) => validatePlumbingReceipt(item, truth)), truth), truth)
}

export async function validatePlumbingSummary(value: unknown): Promise<PlumbingSummary> {
  return validatePlumbingSummaryWithTruth(value, await loadFullTruth(await loadBaseTruth()))
}

export async function encodePlumbingSummary(value: PlumbingSummary): Promise<string> {
  const truth = await loadFullTruth(await loadBaseTruth())
  return canonicalBytes(validatePlumbingSummaryWithTruth(value, truth))
}

export async function runPlumbingEvaluation(): Promise<PlumbingEvaluation> {
  const base = await loadBaseTruth(); const receipts: PlumbingRunReceipt[] = []
  for (const task of base.tasks) for (const group of base.protocol.groups) for (const seed of base.protocol.model.requested_seeds) receipts.push(await runOne(group === 'no_memory' ? base : await loadFullTruth(base), task, group, seed))
  return { receipts, summary: await summarizePlumbing(receipts) }
}

export async function runNoMemoryProbe(): Promise<PlumbingRunReceipt> {
  const base = await loadBaseTruth()
  return runOne(base, base.tasks[0], 'no_memory', base.protocol.model.requested_seeds[0])
}
