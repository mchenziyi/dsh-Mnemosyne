import { lstat, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join, isAbsolute, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  assertExactKeys,
  assertHash,
  assertInteger,
  assertObject,
  assertSafeText,
  canonicalBytes,
  canonicalHash,
  containsSensitiveText,
  ProtocolValidationError,
  sha256,
  withoutHash,
} from '../protocol/canonical.js'
import {
  loadM05Dv2Fixtures,
  validateM05Dv2Fixtures,
  validateModelReceipt,
  validateUsage,
  M05DAgentTimeoutError,
  M05DBatchTimeoutError,
  type M05DTask,
  type M05DGroup,
  type Usage,
} from '../m05d/index.js'
import {
  createFixtureSearchTool,
  createFixtureOpenTool,
} from '../retrieval/fixture-tools.js'
import {
  classifyFailure,
  createSafeStreamFinishError,
  createSanitizedFailureDiagnostic,
  ModelOutputValidationError,
  resolveClaimKind,
  validateSanitizedFailureDiagnostic,
  type FailureStage,
  type SanitizedFailureDiagnostic,
} from './diagnostics.js'
import {
  RetrievalRuntime,
} from '../retrieval/runtime.js'
import {
  createRecallContext,
  createRecallReceipt,
  encodeRecallContext,
  replayRecallContext,
  validateRecallContext,
  validateRecallReceipt,
  type RecallContextEnvelope,
  type RecallContextReceipt,
} from '../protocol/recall.js'
import {
  validateOpenDisclosure,
  validateSearchDisclosure,
} from '../protocol/retrieval.js'
import { RECALL_PREFIX } from '../recall-tool.js'
import {
  BudgetLedger,
  createCanaryPlan,
  prepareIsolationRoot,
  type BudgetSnapshot,
  type CanaryClock,
  type IsolationPaths,
} from '../m05e/index.js'
import {
  assertRfc3339Utc,
  createProviderCompatibilityAudit,
  validateProviderCompatibilityAudit,
  type ProviderCompatibilityAudit,
} from '../m05f/provider-audit.js'
import {
  validateRealCanaryAuthorizationRequest,
  validateRealCanaryPlan,
  type RealCanaryAuthorizationRequest,
  type RealCanaryPlan,
} from '../m05f/authorization.js'
import {
  createRealCanaryExecutionClaim,
  validateApprovalAuthorizationBinding,
  validateRealCanaryApprovalReceipt,
  type RealCanaryApprovalReceipt,
} from './approval.js'
import {
  persistExecutionClaim,
  persistReceipt,
  persistSummary,
  verifyPersistenceRoot,
} from './persistence.js'
import {
  createRealProviderBridge,
  type RealProviderBridge,
  type CredentialSeamInstaller,
} from './provider-factory.js'

const GROUPS = ['no_memory', 'tool_only', 'auto_inject'] as const
const EVIDENCE_KIND = 'real_provider_canary' as const
const RUN_SEED = 101
const CANARY_TASKS = ['task_build_recovery', 'task_control_format'] as const
const RESULT_FIELDS: Record<string, string[]> = {
  task_build_recovery: ['rebuild_mode'],
  task_control_format: ['controlled_field'],
}
export const PLUMBING_FAIL_REASONS = [
  'protocol_error',
  'call_timeout',
  'batch_timeout',
  'budget_exhausted',
  'circuit_open',
  'credential_unavailable',
] as const

export const CANARY_ABORTED_REASONS = [
  'isolation_error',
  'cleanup_failed',
  'claim_conflict',
  'unauthorized',
  'expired',
] as const

export const REASONS: readonly [
  'protocol_error',
  'call_timeout',
  'batch_timeout',
  'budget_exhausted',
  'circuit_open',
  'credential_unavailable',
  'isolation_error',
  'cleanup_failed',
  'claim_conflict',
  'unauthorized',
  'expired',
] = [
  'protocol_error',
  'call_timeout',
  'batch_timeout',
  'budget_exhausted',
  'circuit_open',
  'credential_unavailable',
  'isolation_error',
  'cleanup_failed',
  'claim_conflict',
  'unauthorized',
  'expired',
] as const

const ALLOWED_TOOLS = ['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open'] as const
const ALLOWED_MEMORY_EVENTS = ['user_message', 'recall_user_message'] as const

export type ReasonCode = (typeof REASONS)[number]

export interface CanonicalRunSpec {
  group: (typeof GROUPS)[number]
  taskId: (typeof CANARY_TASKS)[number]
  runId: string
}

export const CANONICAL_CANARY_RUNS: readonly CanonicalRunSpec[] = GROUPS.flatMap((group) =>
  CANARY_TASKS.map((taskId) => ({
    group,
    taskId,
    runId: `run_${canonicalHash({
      evaluation_id: 'm05_v2',
      task_id: taskId,
      group,
      requested_seed: RUN_SEED,
    }).slice(7, 23)}`,
  }))
)

export interface RealCanaryAcquisitionCandidate {
  schema_version: 1
  title: string
  summary: string
  redaction_status: 'passed'
}

export interface RealCanaryReceipt {
  schema_version: 1
  run_id: string
  authorization_sha256: string
  approval_sha256: string
  plan_hash: string
  provider: { provider: 'deepseek-official'; model: string }
  evidence_kind: typeof EVIDENCE_KIND
  task_id: string
  group: (typeof GROUPS)[number]
  requested_seed: 101
  seed_honored: boolean
  claim_sequence: number[]
  tool_calls: string[]
  memory_events: string[]
  recall_source: { kind: 'plugin'; plugin: 'dsh-mnemosyne'; form: 'recall' } | null
  recall_context: RecallContextEnvelope | null
  recall_receipt: RecallContextReceipt | null
  observed_memory_ids: string[]
  retrieved_memory_ids: string[]
  opened_memory_ids: string[]
  adopted_memory_ids: string[]
  model_call_count: number
  model: ReturnType<typeof validateModelReceipt>
  usage: { model: Usage; retrieval_estimated_tokens: number; acquisition_tokens: number }
  acquisition: {
    case_id: 'novel_candidate'
    provider_calls: 1
    after_task_completed: true
    decision: 'novel_candidate'
    reason_code: 'novel_candidate'
    candidate_schema_valid: true
    candidate_content_sha256: string
  }
  duration_ms: number
  success: boolean
  canonical_hash: string
}

export interface RealCanarySummary {
  schema_version: 1
  status: 'real_provider_plumbing_pass' | 'real_provider_plumbing_fail' | 'real_provider_canary_aborted'
  authorization_sha256: string
  approval_sha256: string
  plan_hash: string
  fixture_manifest_sha256: string
  receipts: RealCanaryReceipt[]
  deterministic_prefix_bytes: string
  ledger: BudgetSnapshot
  reason_code: ReasonCode | null
  cleanup_clean: boolean
  failure_diagnostics?: SanitizedFailureDiagnostic[]
  summary_sha256: string
}

export interface ExecutionWorldInputs {
  audit: ProviderCompatibilityAudit
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
  approval: RealCanaryApprovalReceipt
  now: string
  persistence_root: string
  workspace_root: string
}

export interface ReconstructedWorldFacts {
  fixtureManifestSha256: string
  m05ePlanSha256: string
  auditSha256: string
}

export interface D2RunnerOptions {
  audit: ProviderCompatibilityAudit
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
  approval: RealCanaryApprovalReceipt
  now: string
  persistence_root: string
  isolation_root: string
  workspace_root: string
  clock?: CanaryClock
  credentialProvider?: CredentialSeamInstaller
  requiredCredentialSource?: string
}

class CircuitOpenError extends LlmError {
  constructor() {
    super('circuit breaker open', 'M05E_CIRCUIT_OPEN')
  }
}

class BudgetLimitError extends LlmError {
  constructor() {
    super('budget claim rejected', 'M05E_BUDGET_EXHAUSTED')
  }
}

function cleanUsage(usage: Usage): Usage {
  const result: Usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }
  if (usage.cacheReadTokens !== undefined) result.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) result.cacheWriteTokens = usage.cacheWriteTokens
  if (usage.reasoningTokens !== undefined) result.reasoningTokens = usage.reasoningTokens
  return result
}

function taskSucceeded(task: M05DTask, model: ReturnType<typeof validateModelReceipt>): boolean {
  return task.success_assertions.every((assertion) =>
    assertion.kind === 'exit_code'
      ? model.exit_code === assertion.expected
      : model.result[assertion.field as string] === assertion.expected
  )
}

function goldenReceipt(receipt: RealCanaryReceipt): Record<string, unknown> {
  const { duration_ms: _duration, canonical_hash: _hash, ...body } = receipt
  return body
}

function assertSanitized(value: unknown): void {
  const json = JSON.stringify(value)
  if (containsSensitiveText(json) || /sk-[a-zA-Z0-9]{20,}/.test(json)) {
    throw new ProtocolValidationError()
  }
  const checkStrings = (obj: unknown): void => {
    if (typeof obj === 'string') {
      if (containsSensitiveText(obj) || /sk-[a-zA-Z0-9]{20,}/.test(obj)) {
        throw new ProtocolValidationError()
      }
    } else if (Array.isArray(obj)) {
      for (const item of obj) checkStrings(item)
    } else if (obj !== null && typeof obj === 'object') {
      for (const val of Object.values(obj)) checkStrings(val)
    }
  }
  checkStrings(value)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error = () => new M05DAgentTimeoutError()
): Promise<T> {
  if (timeoutMs <= 0) throw errorFactory()
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errorFactory()), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createTaskFixtureTool(taskId: string): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'm05d_task_fixture',
    description: 'Synthetic task fixture identity tool',
    parameters: { task_id: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schema_version: { type: 'integer', required: true },
          fixture_id: { type: 'string', required: true },
          task_id: { type: 'string', required: true },
        },
      } as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown) => {
      assertObject(args)
      assertExactKeys(args, ['task_id'])
      if (args.task_id !== taskId) throw new ProtocolValidationError()
      return { schema_version: 1, fixture_id: `fixture_${taskId}`, task_id: taskId }
    },
  } as never)
}

export function validateAcquisitionCandidate(text: string): {
  candidate: RealCanaryAcquisitionCandidate
  candidate_content_sha256: string
} {
  if (typeof text !== 'string') throw new ProtocolValidationError()
  const trimmed = text.trim()
  if (trimmed.startsWith('```') || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new ProtocolValidationError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ProtocolValidationError()
  }
  assertObject(parsed)
  assertExactKeys(parsed, ['schema_version', 'title', 'summary', 'redaction_status'])
  if (parsed.schema_version !== 1) throw new ProtocolValidationError()
  assertSafeText(parsed.title, 200)
  assertSafeText(parsed.summary, 1000)
  if (parsed.redaction_status !== 'passed') throw new ProtocolValidationError()
  assertSanitized(parsed)

  const candidate = parsed as unknown as RealCanaryAcquisitionCandidate
  return {
    candidate,
    candidate_content_sha256: canonicalHash(candidate),
  }
}

export async function validateExecutionWorld(
  inputs: ExecutionWorldInputs
): Promise<ReconstructedWorldFacts> {
  const audit = validateProviderCompatibilityAudit(inputs.audit)
  const plan = validateRealCanaryPlan(inputs.plan)
  const auth = validateRealCanaryAuthorizationRequest(inputs.authorization)
  const approval = validateRealCanaryApprovalReceipt(inputs.approval)
  assertRfc3339Utc(inputs.now)

  if (
    typeof inputs.workspace_root !== 'string' ||
    !isAbsolute(inputs.workspace_root) ||
    inputs.workspace_root.split(sep).includes('..')
  ) {
    throw new ProtocolValidationError()
  }

  // 1. Reconstruct Fixture Manifest from disk
  const fixtures = await loadM05Dv2Fixtures()
  const checkedFixtures = validateM05Dv2Fixtures(fixtures)
  const fixtureManifestSha256 = canonicalHash(checkedFixtures.manifest)

  // 2. Reconstruct M0.5E Plan from disk
  const m05ePlan = await createCanaryPlan()
  const m05ePlanSha256 = m05ePlan.plan_hash

  // 3. Reconstruct ProviderCompatibilityAudit from workspace package.json & lockfile
  const wsRoot = inputs.workspace_root
  const pkgContent = readFileSync(join(wsRoot, 'package.json'), 'utf8')
  const lockContent = readFileSync(join(wsRoot, 'pnpm-lock.yaml'), 'utf8')
  const rebuiltAudit = createProviderCompatibilityAudit({
    audited_at: audit.audited_at,
    package_json_content: pkgContent,
    lockfile_content: lockContent,
  })

  // 4. Audit & Plan status
  if (audit.decision !== 'compatible' || rebuiltAudit.decision !== 'compatible') {
    throw new ProtocolValidationError()
  }
  if (audit.audit_sha256 !== rebuiltAudit.audit_sha256) {
    throw new ProtocolValidationError()
  }
  if (plan.status !== 'dry_run_validated') {
    throw new ProtocolValidationError()
  }
  if (auth.status !== 'pending_user_approval') {
    throw new ProtocolValidationError()
  }
  if (approval.decision !== 'approved') {
    throw new ProtocolValidationError()
  }

  // 5. Hash bindings
  if (plan.compatibility_audit_sha256 !== audit.audit_sha256) {
    throw new ProtocolValidationError()
  }
  if (plan.fixture_manifest_sha256 !== fixtureManifestSha256) {
    throw new ProtocolValidationError()
  }
  if (plan.m05e_canary_plan_sha256 !== m05ePlanSha256) {
    throw new ProtocolValidationError()
  }
  if (auth.compatibility_audit_sha256 !== audit.audit_sha256) {
    throw new ProtocolValidationError()
  }
  if (auth.canary_plan_sha256 !== plan.plan_sha256) {
    throw new ProtocolValidationError()
  }
  if (auth.fixture_manifest_sha256 !== fixtureManifestSha256) {
    throw new ProtocolValidationError()
  }

  // 6. Runtime & Limits bindings
  if (
    auth.runtime.dsh_version !== plan.runtime.dsh_version ||
    auth.runtime.provider_package !== plan.runtime.provider_package ||
    auth.runtime.provider_package_version !== plan.runtime.provider_package_version ||
    auth.runtime.provider_route !== plan.runtime.provider_route ||
    auth.runtime.model !== plan.runtime.model
  ) {
    throw new ProtocolValidationError()
  }

  if (
    auth.limits.task_calls !== plan.limits.task_calls ||
    auth.limits.acquisition_calls !== plan.limits.acquisition_calls ||
    auth.limits.total_calls !== plan.limits.total_calls ||
    auth.limits.max_output_tokens_per_call !== plan.limits.max_output_tokens_per_call ||
    auth.limits.call_timeout_ms !== plan.limits.call_timeout_ms ||
    auth.limits.batch_timeout_ms !== plan.limits.batch_timeout_ms ||
    auth.limits.automatic_retries !== plan.limits.automatic_retries
  ) {
    throw new ProtocolValidationError()
  }

  // 7. Approval binding
  validateApprovalAuthorizationBinding(approval, auth, inputs.now)

  // 8. Persistence root hash matching
  const expectedPersistenceRootHash = sha256(resolve(inputs.persistence_root))
  if (approval.execution_root_sha256 !== expectedPersistenceRootHash) {
    throw new ProtocolValidationError()
  }

  return {
    fixtureManifestSha256,
    m05ePlanSha256,
    auditSha256: audit.audit_sha256,
  }
}

export function validateRealCanaryReceipt(receipt: unknown): RealCanaryReceipt {
  assertObject(receipt)
  assertExactKeys(receipt, [
    'schema_version',
    'run_id',
    'authorization_sha256',
    'approval_sha256',
    'plan_hash',
    'provider',
    'evidence_kind',
    'task_id',
    'group',
    'requested_seed',
    'seed_honored',
    'claim_sequence',
    'tool_calls',
    'memory_events',
    'recall_source',
    'recall_context',
    'recall_receipt',
    'observed_memory_ids',
    'retrieved_memory_ids',
    'opened_memory_ids',
    'adopted_memory_ids',
    'model_call_count',
    'model',
    'usage',
    'acquisition',
    'duration_ms',
    'success',
    'canonical_hash',
  ])

  if (receipt.schema_version !== 1) throw new ProtocolValidationError()
  assertSafeText(receipt.run_id, 64)
  if (!/^run_[a-z0-9]{16}$/.test(receipt.run_id as string)) {
    throw new ProtocolValidationError()
  }
  assertHash(receipt.authorization_sha256)
  assertHash(receipt.approval_sha256)
  assertHash(receipt.plan_hash)
  assertHash(receipt.canonical_hash)

  if (receipt.evidence_kind !== EVIDENCE_KIND) throw new ProtocolValidationError()
  if (!GROUPS.includes(receipt.group as (typeof GROUPS)[number])) throw new ProtocolValidationError()
  if (receipt.requested_seed !== RUN_SEED || receipt.seed_honored !== false) throw new ProtocolValidationError()

  assertObject(receipt.provider)
  assertExactKeys(receipt.provider, ['provider', 'model'])
  const providerObj = receipt.provider as Record<string, unknown>
  if (providerObj.provider !== 'deepseek-official') throw new ProtocolValidationError()
  assertSafeText(providerObj.model, 64)

  const taskId = receipt.task_id as string
  if (!CANARY_TASKS.includes(taskId as (typeof CANARY_TASKS)[number])) throw new ProtocolValidationError()
  const fields = RESULT_FIELDS[taskId]
  if (!fields) throw new ProtocolValidationError()

  const expectedRunId = `run_${canonicalHash({
    evaluation_id: 'm05_v2',
    task_id: taskId,
    group: receipt.group,
    requested_seed: RUN_SEED,
  }).slice(7, 23)}`
  if (receipt.run_id !== expectedRunId) throw new ProtocolValidationError()

  // Claim sequence validation: non-empty, strictly contiguous ascending, correct length
  assertInteger(receipt.model_call_count, 1, 4)
  if (
    !Array.isArray(receipt.claim_sequence) ||
    receipt.claim_sequence.length !== (receipt.model_call_count as number) + 1 ||
    receipt.claim_sequence.length > 5
  ) {
    throw new ProtocolValidationError()
  }
  for (let i = 0; i < receipt.claim_sequence.length; i++) {
    const seq = receipt.claim_sequence[i]
    assertInteger(seq, 1, 30)
    if (i > 0 && seq !== (receipt.claim_sequence[i - 1] as number) + 1) {
      throw new ProtocolValidationError()
    }
  }

  // Tool calls & Memory events validation
  if (!Array.isArray(receipt.tool_calls) || !Array.isArray(receipt.memory_events)) {
    throw new ProtocolValidationError()
  }
  for (const tc of receipt.tool_calls) {
    if (!ALLOWED_TOOLS.includes(tc as (typeof ALLOWED_TOOLS)[number])) {
      throw new ProtocolValidationError()
    }
  }
  for (const me of receipt.memory_events) {
    if (!ALLOWED_MEMORY_EVENTS.includes(me as (typeof ALLOWED_MEMORY_EVENTS)[number])) {
      throw new ProtocolValidationError()
    }
  }

  // Memory IDs validation
  const validateMemoryIdList = (list: unknown): string[] => {
    if (!Array.isArray(list)) throw new ProtocolValidationError()
    for (const item of list) {
      if (typeof item !== 'string' || !/^memory_[a-z0-9][a-z0-9._-]{0,63}$/.test(item)) {
        throw new ProtocolValidationError()
      }
    }
    const copy = [...list] as string[]
    copy.sort()
    for (let i = 1; i < copy.length; i++) {
      if (copy[i] === copy[i - 1]) throw new ProtocolValidationError()
    }
    return list as string[]
  }

  const observed = validateMemoryIdList(receipt.observed_memory_ids)
  const retrieved = validateMemoryIdList(receipt.retrieved_memory_ids)
  const opened = validateMemoryIdList(receipt.opened_memory_ids)
  const adopted = validateMemoryIdList(receipt.adopted_memory_ids)

  if (
    JSON.stringify(receipt.observed_memory_ids) !== JSON.stringify([...observed].sort()) ||
    JSON.stringify(receipt.retrieved_memory_ids) !== JSON.stringify([...retrieved].sort()) ||
    JSON.stringify(receipt.opened_memory_ids) !== JSON.stringify([...opened].sort()) ||
    JSON.stringify(receipt.adopted_memory_ids) !== JSON.stringify([...adopted].sort())
  ) {
    throw new ProtocolValidationError()
  }

  // Subsets check: adopted subset of opened subset of retrieved subset of observed
  for (const id of adopted) {
    if (!opened.includes(id)) throw new ProtocolValidationError()
  }
  for (const id of opened) {
    if (!retrieved.includes(id)) throw new ProtocolValidationError()
  }
  for (const id of retrieved) {
    if (!observed.includes(id)) throw new ProtocolValidationError()
  }

  // Forbidden memory IDs check:
  if (taskId === 'task_control_format') {
    if (observed.length !== 0 || retrieved.length !== 0 || opened.length !== 0 || adopted.length !== 0) {
      throw new ProtocolValidationError()
    }
  } else {
    for (const memList of [observed, retrieved, opened, adopted]) {
      if (memList.includes('memory_unverified_hook')) throw new ProtocolValidationError()
    }
  }

  // Group & Task behavior locking (Requirement 2 & 3)
  if (receipt.group === 'no_memory') {
    if (
      JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) ||
      receipt.memory_events.includes('recall_user_message') ||
      receipt.memory_events.length === 0 ||
      observed.length !== 0 ||
      retrieved.length !== 0 ||
      opened.length !== 0 ||
      adopted.length !== 0 ||
      receipt.recall_source !== null ||
      receipt.recall_context !== null ||
      receipt.recall_receipt !== null
    ) {
      throw new ProtocolValidationError()
    }
  } else if (receipt.group === 'tool_only') {
    if (taskId === 'task_control_format') {
      if (
        JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) ||
        receipt.memory_events.includes('recall_user_message') ||
        receipt.memory_events.length === 0 ||
        observed.length !== 0 ||
        retrieved.length !== 0 ||
        opened.length !== 0 ||
        adopted.length !== 0 ||
        receipt.recall_source !== null ||
        receipt.recall_context !== null ||
        receipt.recall_receipt !== null
      ) {
        throw new ProtocolValidationError()
      }
    } else {
      // task_build_recovery in tool_only
      if (
        JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']) ||
        receipt.memory_events.includes('recall_user_message') ||
        receipt.memory_events.length === 0 ||
        receipt.recall_source !== null ||
        receipt.recall_context !== null ||
        receipt.recall_receipt !== null ||
        retrieved.length === 0 ||
        opened.length === 0 ||
        observed.length === 0
      ) {
        throw new ProtocolValidationError()
      }
    }
  } else if (receipt.group === 'auto_inject') {
    if (taskId === 'task_control_format') {
      if (
        JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) ||
        receipt.memory_events.includes('recall_user_message') ||
        receipt.memory_events.length === 0 ||
        observed.length !== 0 ||
        retrieved.length !== 0 ||
        opened.length !== 0 ||
        adopted.length !== 0 ||
        receipt.recall_source !== null ||
        receipt.recall_context !== null ||
        receipt.recall_receipt !== null
      ) {
        throw new ProtocolValidationError()
      }
    } else {
      // task_build_recovery in auto_inject
      if (
        JSON.stringify(receipt.tool_calls) !== JSON.stringify(['m05d_task_fixture']) ||
        receipt.memory_events.filter((e) => e === 'recall_user_message').length !== 1 ||
        !receipt.memory_events.includes('user_message')
      ) {
        throw new ProtocolValidationError()
      }
      const rs = receipt.recall_source as Record<string, unknown> | null
      if (!rs || rs.kind !== 'plugin' || rs.plugin !== 'dsh-mnemosyne' || rs.form !== 'recall') {
        throw new ProtocolValidationError()
      }
      if (!receipt.recall_context || !receipt.recall_receipt) {
        throw new ProtocolValidationError()
      }
      const ctx = validateRecallContext(receipt.recall_context)
      const rct = validateRecallReceipt(receipt.recall_receipt)

      // Exact closure of recall context, receipt, and memory arrays (Requirement 3)
      if (rct.context_content_sha256 !== ctx.content_sha256) throw new ProtocolValidationError()
      if (JSON.stringify(rct.memory_ids) !== JSON.stringify(ctx.memory_ids)) throw new ProtocolValidationError()
      const contextRetrieved = [...new Set(ctx.search_disclosure.items.map((i) => i.memory_id))].sort()
      const contextOpened = [...new Set(ctx.open_disclosures.map((i) => i.memory_id))].sort()
      if (JSON.stringify(retrieved) !== JSON.stringify(contextRetrieved)) throw new ProtocolValidationError()
      if (JSON.stringify(opened) !== JSON.stringify(contextOpened)) throw new ProtocolValidationError()
      if (JSON.stringify(observed) !== JSON.stringify([...new Set([...contextRetrieved, ...contextOpened])].sort())) {
        throw new ProtocolValidationError()
      }
      if (ctx.memory_ids.some((id) => id === 'memory_unverified_hook')) throw new ProtocolValidationError()
    }
  }

  // Model receipt & Usage validation
  assertObject(receipt.model)
  validateModelReceipt(JSON.stringify(receipt.model), observed, fields, taskId)
  if (JSON.stringify(receipt.model.adopted_memory_ids) !== JSON.stringify(adopted)) {
    throw new ProtocolValidationError()
  }

  assertObject(receipt.usage)
  assertExactKeys(receipt.usage, ['model', 'retrieval_estimated_tokens', 'acquisition_tokens'])
  const usageObj = receipt.usage as Record<string, unknown>
  validateUsage(usageObj.model as Usage)
  assertInteger(usageObj.retrieval_estimated_tokens, 0, 1000000)
  assertInteger(usageObj.acquisition_tokens, 0, 1000000)

  // Acquisition validation
  assertObject(receipt.acquisition)
  assertExactKeys(receipt.acquisition, [
    'case_id',
    'provider_calls',
    'after_task_completed',
    'decision',
    'reason_code',
    'candidate_schema_valid',
    'candidate_content_sha256',
  ])
  const acq = receipt.acquisition as Record<string, unknown>
  if (
    acq.case_id !== 'novel_candidate' ||
    acq.provider_calls !== 1 ||
    acq.after_task_completed !== true ||
    acq.decision !== 'novel_candidate' ||
    acq.reason_code !== 'novel_candidate' ||
    acq.candidate_schema_valid !== true
  ) {
    throw new ProtocolValidationError()
  }
  assertHash(acq.candidate_content_sha256)

  assertInteger(receipt.duration_ms, 0, 600000)
  if (typeof receipt.success !== 'boolean') throw new ProtocolValidationError()

  // Requirement 1: Recompute expectedSuccess from task success assertions and model receipt
  const modelObj = receipt.model as { exit_code: number; result: Record<string, unknown>; failure_code: string | null }
  let expectedSuccess = false
  if (taskId === 'task_build_recovery') {
    expectedSuccess = modelObj.exit_code === 0 && modelObj.failure_code === null && modelObj.result.rebuild_mode === 'targeted'
  } else if (taskId === 'task_control_format') {
    expectedSuccess = modelObj.exit_code === 0 && modelObj.failure_code === null && modelObj.result.controlled_field === 'alpha'
  }
  if (receipt.success !== expectedSuccess) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(receipt, 'canonical_hash'))
  if (receipt.canonical_hash !== expectedHash) {
    throw new ProtocolValidationError()
  }

  // Sanitization check (Requirement 4)
  assertSanitized(receipt)

  return receipt as unknown as RealCanaryReceipt
}

export function validateRealCanarySummary(summary: unknown): RealCanarySummary {
  assertObject(summary)
  const isLegacy = !('failure_diagnostics' in summary)
  if (isLegacy) {
    assertExactKeys(summary, [
      'schema_version',
      'status',
      'authorization_sha256',
      'approval_sha256',
      'plan_hash',
      'fixture_manifest_sha256',
      'receipts',
      'deterministic_prefix_bytes',
      'ledger',
      'reason_code',
      'cleanup_clean',
      'summary_sha256',
    ])
  } else {
    assertExactKeys(summary, [
      'schema_version',
      'status',
      'authorization_sha256',
      'approval_sha256',
      'plan_hash',
      'fixture_manifest_sha256',
      'receipts',
      'deterministic_prefix_bytes',
      'ledger',
      'reason_code',
      'cleanup_clean',
      'failure_diagnostics',
      'summary_sha256',
    ])
  }

  if (summary.schema_version !== 1) throw new ProtocolValidationError()
  const STATUSES = ['real_provider_plumbing_pass', 'real_provider_plumbing_fail', 'real_provider_canary_aborted'] as const
  if (!STATUSES.includes(summary.status as (typeof STATUSES)[number])) {
    throw new ProtocolValidationError()
  }

  assertHash(summary.authorization_sha256)
  assertHash(summary.approval_sha256)
  assertHash(summary.plan_hash)
  assertHash(summary.fixture_manifest_sha256)
  assertHash(summary.summary_sha256)

  if (typeof summary.cleanup_clean !== 'boolean') throw new ProtocolValidationError()

  // Ledger validation
  assertObject(summary.ledger)
  assertExactKeys(summary.ledger, [
    'task_calls_claimed',
    'acquisition_calls_claimed',
    'total_calls_claimed',
    'completed_calls',
    'failed_calls',
    'consecutive_provider_or_protocol_errors',
  ])

  const ledger = summary.ledger as Record<string, unknown>
  assertInteger(ledger.total_calls_claimed, 0, 30)
  assertInteger(ledger.task_calls_claimed, 0, 24)
  assertInteger(ledger.acquisition_calls_claimed, 0, 6)
  assertInteger(ledger.completed_calls, 0, 30)
  assertInteger(ledger.failed_calls, 0, 30)
  assertInteger(ledger.consecutive_provider_or_protocol_errors, 0, 30)

  if (ledger.total_calls_claimed !== (ledger.task_calls_claimed as number) + (ledger.acquisition_calls_claimed as number)) {
    throw new ProtocolValidationError()
  }
  // Requirement 6: Zero pending calls (completed + failed === total_claimed) across all statuses
  if ((ledger.completed_calls as number) + (ledger.failed_calls as number) !== (ledger.total_calls_claimed as number)) {
    throw new ProtocolValidationError()
  }
  // Requirement 4: Basic ledger consistency
  if ((ledger.consecutive_provider_or_protocol_errors as number) > (ledger.failed_calls as number)) {
    throw new ProtocolValidationError()
  }
  if (summary.reason_code === 'circuit_open') {
    if (
      (ledger.failed_calls as number) < 2 ||
      (ledger.consecutive_provider_or_protocol_errors as number) !== 2
    ) {
      throw new ProtocolValidationError()
    }
  }

  if (!Array.isArray(summary.receipts) || summary.receipts.length > 6) {
    throw new ProtocolValidationError()
  }
  const checkedReceipts = summary.receipts.map(validateRealCanaryReceipt)

  // Failure diagnostics validation
  let validatedDiagnostics: SanitizedFailureDiagnostic[] | undefined
  if (!isLegacy) {
    if (!Array.isArray(summary.failure_diagnostics)) throw new ProtocolValidationError()
    if (summary.failure_diagnostics.length !== (ledger.failed_calls as number)) {
      throw new ProtocolValidationError()
    }
    validatedDiagnostics = summary.failure_diagnostics.map(validateSanitizedFailureDiagnostic)

    // Sequence invariants: exactly completed_calls + 1 .. total_calls_claimed
    const startSeq = (ledger.completed_calls as number) + 1
    for (let i = 0; i < validatedDiagnostics.length; i++) {
      const d = validatedDiagnostics[i]
      if (d.sequence !== startSeq + i) {
        throw new ProtocolValidationError()
      }
    }

    // Call kind invariants derived from receipts
    const completedTaskCalls = checkedReceipts.reduce((sum, r) => sum + r.model_call_count, 0)
    const completedAcqCalls = checkedReceipts.length
    const expectedFailedTaskCalls = (ledger.task_calls_claimed as number) - completedTaskCalls
    const expectedFailedAcqCalls = (ledger.acquisition_calls_claimed as number) - completedAcqCalls

    const taskDiags = validatedDiagnostics.filter((d) => d.call_kind === 'task')
    const acqDiags = validatedDiagnostics.filter((d) => d.call_kind === 'acquisition')

    if (taskDiags.length !== expectedFailedTaskCalls) {
      throw new ProtocolValidationError()
    }
    if (acqDiags.length !== expectedFailedAcqCalls) {
      throw new ProtocolValidationError()
    }

    if (expectedFailedAcqCalls > 1) {
      throw new ProtocolValidationError()
    }
    if (acqDiags.length > 0) {
      const lastDiag = validatedDiagnostics[validatedDiagnostics.length - 1]
      if (lastDiag.call_kind !== 'acquisition' || lastDiag.sequence !== (ledger.total_calls_claimed as number)) {
        throw new ProtocolValidationError()
      }
    }

    if (summary.status === 'real_provider_plumbing_pass' && validatedDiagnostics.length !== 0) {
      throw new ProtocolValidationError()
    }
  }

  // Requirement 2: All receipts in non-empty summary must have byte-for-byte identical provider.model
  if (checkedReceipts.length > 0) {
    const firstModel = checkedReceipts[0].provider.model
    for (let i = 1; i < checkedReceipts.length; i++) {
      if (checkedReceipts[i].provider.model !== firstModel) {
        throw new ProtocolValidationError()
      }
    }
  }

  // Status & Reason Code Matrix (Requirement 7)
  if (summary.status === 'real_provider_plumbing_pass') {
    if (summary.reason_code !== null) throw new ProtocolValidationError()
    if (summary.cleanup_clean !== true) throw new ProtocolValidationError()
    if (checkedReceipts.length !== 6) throw new ProtocolValidationError()
    if ((ledger.completed_calls as number) !== (ledger.total_calls_claimed as number)) throw new ProtocolValidationError()
    if ((ledger.failed_calls as number) !== 0) throw new ProtocolValidationError()
    if ((ledger.consecutive_provider_or_protocol_errors as number) !== 0) throw new ProtocolValidationError()
    if ((ledger.acquisition_calls_claimed as number) !== 6) throw new ProtocolValidationError()
    const sumTaskCalls = checkedReceipts.reduce((sum, r) => sum + r.model_call_count, 0)
    if ((ledger.task_calls_claimed as number) !== sumTaskCalls) throw new ProtocolValidationError()
    if ((ledger.total_calls_claimed as number) !== sumTaskCalls + 6) throw new ProtocolValidationError()
  } else if (summary.status === 'real_provider_plumbing_fail') {
    if (summary.reason_code === null || !PLUMBING_FAIL_REASONS.includes(summary.reason_code as (typeof PLUMBING_FAIL_REASONS)[number])) {
      throw new ProtocolValidationError()
    }
  } else if (summary.status === 'real_provider_canary_aborted') {
    if (summary.reason_code === null || !CANARY_ABORTED_REASONS.includes(summary.reason_code as (typeof CANARY_ABORTED_REASONS)[number])) {
      throw new ProtocolValidationError()
    }
  }

  // Canonical run ordering & field consistency (Requirement 5 & 8)
  for (let i = 0; i < checkedReceipts.length; i++) {
    const r = checkedReceipts[i]
    const expected = CANONICAL_CANARY_RUNS[i]
    if (r.group !== expected.group || r.task_id !== expected.taskId || r.run_id !== expected.runId) {
      throw new ProtocolValidationError()
    }
    if (
      r.authorization_sha256 !== summary.authorization_sha256 ||
      r.approval_sha256 !== summary.approval_sha256 ||
      r.plan_hash !== summary.plan_hash
    ) {
      throw new ProtocolValidationError()
    }
  }

  // Claim sequence global chaining across receipts (Requirement 1: persistedCompletedSequences must be 1..N)
  const persistedCompletedSequences = checkedReceipts.flatMap((r) => r.claim_sequence)
  const n = persistedCompletedSequences.length
  for (let i = 0; i < n; i++) {
    if (persistedCompletedSequences[i] !== i + 1) {
      throw new ProtocolValidationError()
    }
  }
  if ((ledger.completed_calls as number) !== n) {
    throw new ProtocolValidationError()
  }
  if ((ledger.failed_calls as number) !== (ledger.total_calls_claimed as number) - n) {
    throw new ProtocolValidationError()
  }

  // Validate deterministic prefix bytes
  const expectedPrefixBytes = canonicalBytes(checkedReceipts.map(goldenReceipt))
  if (summary.deterministic_prefix_bytes !== expectedPrefixBytes) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(summary, 'summary_sha256'))
  if (summary.summary_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  // Sanitization check (Requirement 4)
  assertSanitized(summary)

  if (isLegacy) {
    return summary as unknown as RealCanarySummary
  }

  return {
    ...summary,
    failure_diagnostics: validatedDiagnostics,
  } as unknown as RealCanarySummary
}

interface RunnerTimeoutState {
  callTimedOut: boolean
  batchTimedOut: boolean
  protocolError?: unknown
}

function checkRunnerFailFast(state: RunnerTimeoutState): void {
  if (state.batchTimedOut) {
    throw new M05DBatchTimeoutError()
  }
  if (state.callTimedOut) {
    throw new M05DAgentTimeoutError()
  }
  if (state.protocolError) {
    throw state.protocolError instanceof Error ? state.protocolError : new ProtocolValidationError()
  }
}

interface RunSingleTaskOptions {
  task: M05DTask
  group: (typeof GROUPS)[number]
  catalog: ReturnType<typeof validateM05Dv2Fixtures>['catalog']
  bridge: RealProviderBridge & { status: 'ready' }
  runId: string
  modelName: string
  callTimeoutMs: number
  getBatchRemaining: () => number
  ledger: BudgetLedger
  onClaim: (kind: 'task' | 'acquisition') => number
  onTransportFinished: (seq: number) => void
  onComplete: (seq: number) => void
  onFail: (seq: number, err: unknown, fallbackStage: FailureStage) => void
}

async function runRealCanarySingleRun(
  options: RunSingleTaskOptions
): Promise<{
  toolCalls: string[]
  memoryEvents: string[]
  recallSource: RealCanaryReceipt['recall_source']
  recallContext: RecallContextEnvelope | null
  recallReceipt: RecallContextReceipt | null
  observedMemoryIds: string[]
  retrievedMemoryIds: string[]
  openedMemoryIds: string[]
  taskCalls: number
  modelReceipt: ReturnType<typeof validateModelReceipt>
  usage: Usage
  acquisitionCandidateHash: string
  acquisitionTokens: number
  retrievalEstimatedTokens: number
  taskSuccess: boolean
  durationMs: number
  claimSequence: number[]
}> {
  const runStarted = performance.now()
  const ctx = new Context()
  const fibers = [] as Array<{ dispose(): Promise<void> }>
  const registrations = [] as Array<() => void>

  let recallContext: RecallContextEnvelope | null = null
  let recallReceipt: RecallContextReceipt | null = null
  let recallSource: RealCanaryReceipt['recall_source'] = null
  const claimSequence: number[] = []
  let taskCallCount = 0
  let finalTaskSequence: number | undefined
  const timeoutState: RunnerTimeoutState = { callTimedOut: false, batchTimedOut: false, protocolError: undefined }

  try {
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime]) {
      fibers.push(await ctx.plugin(plugin))
    }
    fibers.push(await ctx.plugin(SessionProjection))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))

    // Register fixture tool
    registrations.push(ctx.tools.register(createTaskFixtureTool(options.task.task_id)))

    // Retrieval runtime setup
    const runtime = options.group === 'no_memory' ? undefined : new RetrievalRuntime(options.catalog)
    if (options.group === 'tool_only' && options.task.task_kind === 'memory_dependent' && runtime !== undefined) {
      registrations.push(
        ctx.tools.register(createFixtureSearchTool(runtime)),
        ctx.tools.register(createFixtureOpenTool(runtime))
      )
    }

    // Delegating claiming adapter for task calls (delegates ONLY to bridge.adapter)
    class ClaimingTaskAdapter extends LlmAdapter {
      providerInfo(p: string) {
        return options.bridge.adapter.providerInfo(p)
      }
      providerRetryPolicy(p: string) {
        return options.bridge.adapter.providerRetryPolicy(p)
      }
      async *stream(genOpts: GenerateOptions): AsyncIterable<StreamChunk> {
        checkRunnerFailFast(timeoutState)

        const remainingBatch = options.getBatchRemaining()
        if (remainingBatch <= 0) {
          timeoutState.batchTimedOut = true
          throw new M05DBatchTimeoutError()
        }
        if (options.ledger.isCircuitOpen()) throw new CircuitOpenError()
        if (taskCallCount >= 4) throw new BudgetLimitError()

        const seq = options.onClaim('task')
        taskCallCount++
        claimSequence.push(seq)
        finalTaskSequence = seq

        let settledFail = false
        let isCallTimeout = false
        let isBatchTimeout = false
        const controller = new AbortController()

        const effectiveTimeoutMs = Math.min(options.callTimeoutMs, remainingBatch)
        const isBatchExpiringFirst = remainingBatch < options.callTimeoutMs

        let timeoutTimer: NodeJS.Timeout | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            if (isBatchExpiringFirst) {
              isBatchTimeout = true
              timeoutState.batchTimedOut = true
              const err = new M05DBatchTimeoutError()
              controller.abort(err)
              reject(err)
            } else {
              isCallTimeout = true
              timeoutState.callTimedOut = true
              const err = new M05DAgentTimeoutError()
              controller.abort(err)
              reject(err)
            }
          }, effectiveTimeoutMs)
        })

        const onParentAbort = () => {
          controller.abort(genOpts.signal?.reason ?? new Error('aborted by parent signal'))
        }
        if (genOpts.signal) {
          if (genOpts.signal.aborted) {
            onParentAbort()
          } else {
            genOpts.signal.addEventListener('abort', onParentAbort, { once: true })
          }
        }

        let iterator: AsyncIterator<StreamChunk> | undefined
        try {
          const streamIterable = options.bridge.adapter.stream({
            ...genOpts,
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
            if (
              (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
              (chunk.type === 'finish' && chunk.reason.kind === 'tool-calls') ||
              (chunk.type === 'block-end' && (chunk.block as any)?.type === 'tool-call')
            ) {
              isToolCall = true
            }
            if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              const streamErr = createSafeStreamFinishError(chunk.reason)
              settledFail = true
              timeoutState.protocolError = streamErr
              options.onFail(seq, streamErr, 'provider_stream')
              throw streamErr
            }
            yield chunk
          }
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (!settledFail && !isCallTimeout && !isBatchTimeout) {
            options.onTransportFinished(seq)
          }
        } catch (err) {
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (!settledFail) {
            settledFail = true
            if (err instanceof M05DBatchTimeoutError) {
              timeoutState.batchTimedOut = true
            } else if (err instanceof M05DAgentTimeoutError) {
              timeoutState.callTimedOut = true
            } else if (err instanceof ProtocolValidationError) {
              timeoutState.protocolError = err
            } else {
              timeoutState.protocolError = err
            }
            options.onFail(seq, err, 'provider_stream')
          }
          if (iterator?.return) {
            try {
              void Promise.race([
                iterator.return(),
                new Promise((resolve) => setTimeout(resolve, 10)),
              ]).catch(() => {})
            } catch {}
          }
          throw err
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (genOpts.signal) {
            genOpts.signal.removeEventListener('abort', onParentAbort)
          }
          controller.abort()
        }
      }
    }

    registrations.push(ctx.llm.registerAdapter(['deepseek-official'], new ClaimingTaskAdapter()))

    const agent = (ctx as Context & { agentLoop: AgentLoop }).agentLoop.create(
      SessionId(`d2-${options.group}-${options.task.task_id}`),
      { provider: 'deepseek-official', model: options.modelName }
    )

    if (options.group === 'auto_inject' && options.task.task_kind === 'memory_dependent') {
      if (runtime === undefined) throw new ProtocolValidationError()
      const search = runtime.search({ query: options.task.prompt, top_k: 5 })
      const opens = search.items
        .slice(0, 2)
        .filter((item) => item.score_fixed > 0)
        .map((item) =>
          runtime.open({
            retrieval_id: search.retrieval_ref,
            search_disclosure_sha256: search.content_sha256,
            memory_id: item.memory_id,
          })
        )
      if (opens.length === 0) throw new ProtocolValidationError()
      const context = createRecallContext(search, opens)
      const receipt = createRecallReceipt(context)
      recallContext = context
      recallReceipt = receipt
      recallSource = { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' }
      agent.inject(
        createUserMessage({
          content: [{ type: 'text', text: `${RECALL_PREFIX}\n${encodeRecallContext(context)}` }],
          source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' },
        })
      )
    }

    const resultFields = options.task.success_assertions
      .filter((assertion) => assertion.kind === 'result_equals')
      .map((assertion) => assertion.field as string)
    agent.inject(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: `M05D_TASK_SHAPE\n${JSON.stringify({ task_id: options.task.task_id, result_fields: resultFields })}`,
          },
        ],
        source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice', summary: 'offline task fixture' },
      })
    )
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: `task_id:${options.task.task_id}\n${options.task.prompt}` }],
        source: { kind: 'user' },
      })
    )

    const batchRemainingNow = options.getBatchRemaining()
    if (batchRemainingNow <= 0) throw new M05DBatchTimeoutError()
    await withTimeout(agent.whenIdle(), batchRemainingNow, () => new M05DBatchTimeoutError())

    checkRunnerFailFast(timeoutState)

    if (taskCallCount < 1 || taskCallCount > 4) throw new ProtocolValidationError()

    const events = agent.session.events
    const toolCalls = events
      .filter((event: any) => event.type === 'tool/call')
      .map((event: any) => event.data.name as string)
    const memoryEvents = events
      .filter((event: any) => event.type === 'user/message')
      .map((event: any) =>
        event.data.source.kind === 'plugin' && event.data.source.form === 'recall'
          ? 'recall_user_message'
          : 'user_message'
      )
    const assistant = [...events]
      .reverse()
      .find(
        (event: any) =>
          event.type === 'assistant/message' &&
          event.data?.message?.content?.length === 1 &&
          event.data?.message?.content[0]?.type === 'text'
      ) as { data: { message: { content: [{ type: 'text'; text: string }] } } } | undefined

    const textMemoryIds = (text: string) => [...text.matchAll(/"memory_id":"(memory_[a-z0-9][a-z0-9._-]{0,63})"/g)].map((m) => m[1])
    const recallTexts = events
      .filter((event: any) => event.type === 'user/message')
      .flatMap((event: any) => (event.data.source.kind === 'plugin' && event.data.source.form === 'recall' ? event.data.content.flatMap((c: any) => (c.type === 'text' ? [c.text] : [])) : []))
    const recallContexts = recallTexts.map((text: string) => text.startsWith(RECALL_PREFIX) ? replayRecallContext(text.slice(RECALL_PREFIX.length).trimStart()) : (() => { throw new ProtocolValidationError() })())
    const recallMemoryIds = recallTexts.flatMap((t: string) => textMemoryIds(t))

    const toolResultTexts = events
      .filter((event: any) => event.type === 'tool/result')
      .flatMap((event: any) => event.data.message.content.flatMap((c: any) => (c.type === 'tool-result' ? c.content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])) : [])))
    const toolMemoryIds = toolResultTexts.flatMap((t: string) => textMemoryIds(t))
    const toolResultValues = toolResultTexts.map((text: string) => {
      try {
        return JSON.parse(text)
      } catch {
        throw new ProtocolValidationError()
      }
    })
    const searchDisclosures = toolResultValues.filter((val: any) => Array.isArray(val?.items)).map(validateSearchDisclosure)
    const openDisclosures = toolResultValues.filter((val: any) => typeof val?.body === 'string').map(validateOpenDisclosure)

    const retrievedMemoryIds = [...new Set(toolCalls.includes('mnemosyne_search') ? searchDisclosures.flatMap((d) => d.items.map((i) => i.memory_id)) : recallContexts.flatMap((c) => c.search_disclosure.items.map((i) => i.memory_id)))].sort()
    const openedMemoryIds = [...new Set(toolCalls.includes('mnemosyne_open') ? openDisclosures.map((d) => d.memory_id) : recallContexts.flatMap((c) => c.open_disclosures.map((i) => i.memory_id)))].sort()
    const observed = [...new Set([...recallMemoryIds, ...toolMemoryIds])].sort()

    let modelReceipt: ReturnType<typeof validateModelReceipt>
    let usage: Usage
    try {
      const usageEvents = events
        .filter((event: any) => event.type === 'assistant/message')
        .flatMap((event: any) => {
          if (event.data?.usage) {
            try {
              return [validateUsage(event.data.usage)]
            } catch {
              throw new ModelOutputValidationError('task_output_validation')
            }
          }
          return []
        })
      if (usageEvents.length === 0) throw new ModelOutputValidationError('task_output_validation')

      usage = usageEvents.reduce(
        (total, item) => ({
          inputTokens: total.inputTokens + item.inputTokens,
          outputTokens: total.outputTokens + item.outputTokens,
          ...(total.cacheReadTokens !== undefined || item.cacheReadTokens !== undefined
            ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (item.cacheReadTokens ?? 0) }
            : {}),
          ...(total.cacheWriteTokens !== undefined || item.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (item.cacheWriteTokens ?? 0) }
            : {}),
          ...(total.reasoningTokens !== undefined || item.reasoningTokens !== undefined
            ? { reasoningTokens: (total.reasoningTokens ?? 0) + (item.reasoningTokens ?? 0) }
            : {}),
        }),
        { inputTokens: 0, outputTokens: 0 } as Usage
      )

      if (!assistant) throw new ModelOutputValidationError('task_output_validation')
      modelReceipt = validateModelReceipt(
        assistant.data.message.content[0].text,
        observed,
        resultFields,
        options.task.task_id
      )
    } catch (valErr) {
      if (!timeoutState.protocolError && finalTaskSequence !== undefined) {
        const wrappedErr = new ModelOutputValidationError('task_output_validation')
        timeoutState.protocolError = wrappedErr
        options.onFail(finalTaskSequence, wrappedErr, 'task_output_validation')
      }
      throw valErr
    }

    const retrievalEstimatedTokens = [...toolResultTexts, ...recallTexts].reduce((total, text: string) => total + Math.max(1, text.trim().split(/\s+/).length), 0)

    // 2. D2 Real Acquisition Step (Section 2.1 & 2.2: uses the SAME official bridge)
    const acqBatchRemaining = options.getBatchRemaining()
    if (acqBatchRemaining <= 0) throw new M05DBatchTimeoutError()
    if (options.ledger.isCircuitOpen()) throw new CircuitOpenError()

    const acqSeq = options.onClaim('acquisition')
    claimSequence.push(acqSeq)

    let acquisitionTokens = 0
    let candidateHash = ''

    let acqSettledFail = false
    let isAcqCallTimeout = false
    let isAcqBatchTimeout = false
    const acqController = new AbortController()

    const effectiveAcqTimeoutMs = Math.min(options.callTimeoutMs, acqBatchRemaining)
    const isAcqBatchExpiringFirst = acqBatchRemaining < options.callTimeoutMs

    let acqTimer: NodeJS.Timeout | undefined
    const acqTimeoutPromise = new Promise<never>((_, reject) => {
      acqTimer = setTimeout(() => {
        if (isAcqBatchExpiringFirst) {
          isAcqBatchTimeout = true
          timeoutState.batchTimedOut = true
          const err = new M05DBatchTimeoutError()
          acqController.abort(err)
          reject(err)
        } else {
          isAcqCallTimeout = true
          timeoutState.callTimedOut = true
          const err = new M05DAgentTimeoutError()
          acqController.abort(err)
          reject(err)
        }
      }, effectiveAcqTimeoutMs)
    })

    let acqIterator: AsyncIterator<StreamChunk> | undefined
    try {
      const acqPrompt = JSON.stringify({
        task_id: options.task.task_id,
        prompt: options.task.prompt,
        result: modelReceipt.result,
        exit_code: modelReceipt.exit_code,
      })

      const acqMessages = [
        createUserMessage({
          content: [{ type: 'text', text: `Acquisition Request:\n${acqPrompt}` }],
          source: { kind: 'user' },
        }),
      ]

      const chunks: StreamChunk[] = []
      const streamIterable = options.bridge.adapter.stream({
        provider: 'deepseek-official',
        model: options.modelName,
        messages: acqMessages,
        signal: acqController.signal,
      })
      acqIterator = streamIterable[Symbol.asyncIterator]()

      while (true) {
        const nextResult = await Promise.race([
          acqIterator.next(),
          acqTimeoutPromise,
        ])
        if (nextResult.done) {
          break
        }
        if (isAcqBatchTimeout) {
          throw new M05DBatchTimeoutError()
        }
        if (isAcqCallTimeout) {
          throw new M05DAgentTimeoutError()
        }
        const chunk = nextResult.value
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const err = createSafeStreamFinishError(chunk.reason)
          throw err
        }
        chunks.push(chunk)
      }
      if (acqTimer) clearTimeout(acqTimer)

      let acqUsages: Usage[]
      try {
        acqUsages = chunks
          .filter((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
          .map((c) => validateUsage(c.usage))
        if (acqUsages.length !== 1) throw new ModelOutputValidationError('acquisition_output_validation')
      } catch {
        throw new ModelOutputValidationError('acquisition_output_validation')
      }

      const acqText = chunks
        .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
        .map((c) => c.text)
        .join('')
      let validatedCandidate: ReturnType<typeof validateAcquisitionCandidate>
      try {
        validatedCandidate = validateAcquisitionCandidate(acqText)
      } catch {
        throw new ModelOutputValidationError('acquisition_output_validation')
      }
      candidateHash = validatedCandidate.candidate_content_sha256
      acquisitionTokens =
        acqUsages[0].inputTokens +
        acqUsages[0].outputTokens +
        (acqUsages[0].cacheReadTokens ?? 0) +
        (acqUsages[0].cacheWriteTokens ?? 0)

      options.onTransportFinished(acqSeq)
    } catch (acqErr) {
      if (acqTimer) clearTimeout(acqTimer)
      if (!acqSettledFail) {
        acqSettledFail = true
        const fallbackStage: FailureStage =
          acqErr instanceof ModelOutputValidationError
            ? 'acquisition_output_validation'
            : 'provider_stream'
        options.onFail(acqSeq, acqErr, fallbackStage)
      }
      if (acqIterator?.return) {
        try {
          void Promise.race([
            acqIterator.return(),
            new Promise((resolve) => setTimeout(resolve, 10)),
          ]).catch(() => {})
        } catch {}
      }
      throw acqErr
    } finally {
      if (acqTimer) clearTimeout(acqTimer)
      acqController.abort()
    }

    const taskSuccess = taskSucceeded(options.task, modelReceipt)
    options.ledger.assertionFailure()

    return {
      toolCalls,
      memoryEvents,
      recallSource,
      recallContext,
      recallReceipt,
      observedMemoryIds: observed,
      retrievedMemoryIds,
      openedMemoryIds,
      taskCalls: taskCallCount,
      modelReceipt,
      usage,
      acquisitionCandidateHash: candidateHash,
      acquisitionTokens,
      retrievalEstimatedTokens,
      taskSuccess,
      durationMs: Math.max(0, Math.round(performance.now() - runStarted)),
      claimSequence,
    }
  } finally {
    for (const reg of registrations.reverse()) reg()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

export async function runRealCanaryD2(options: D2RunnerOptions): Promise<RealCanarySummary> {
  // 1. Cross-object execution world reconstruction & validation before Claim or side effects
  const worldFacts = await validateExecutionWorld({
    audit: options.audit,
    plan: options.plan,
    authorization: options.authorization,
    approval: options.approval,
    now: options.now,
    persistence_root: options.persistence_root,
    workspace_root: options.workspace_root,
  })

  // 2. Verify Persistence Root
  const normalizedPersistenceRoot = await verifyPersistenceRoot(
    options.persistence_root,
    options.approval.execution_root_sha256
  )

  // 3. Publish Execution Claim atomically (no-overwrite) BEFORE any credential resolve / bridge
  const claim = createRealCanaryExecutionClaim({
    authorization_sha256: options.authorization.authorization_sha256,
    approval_sha256: options.approval.approval_sha256,
    execution_root_sha256: options.approval.execution_root_sha256,
    claimed_at: options.now,
  })
  await persistExecutionClaim(normalizedPersistenceRoot, claim)

  // 4. Create temporary isolation root
  const paths: IsolationPaths = await prepareIsolationRoot(options.isolation_root)
  let cleanupClean = false
  let bridgeDisposed = false
  let reasonCode: ReasonCode | null = null

  // 5. Connect official provider bridge
  const bridge = await createRealProviderBridge({
    plan: options.plan,
    authorization: options.authorization,
    dsh_home: paths.dsh_home,
    workspace: paths.workspace,
    credentialProvider: options.credentialProvider,
    requiredCredentialSource: options.requiredCredentialSource,
  })

  const ledger = new BudgetLedger()
  const receipts: RealCanaryReceipt[] = []
  const diagnosticsMap = new Map<number, SanitizedFailureDiagnostic>()
  const claimKinds = new Map<number, 'task' | 'acquisition'>()

  const clock = options.clock ?? { now: () => performance.now() }
  const batchStart = clock.now()
  const CALL_TIMEOUT_MS = 30_000
  const BATCH_TIMEOUT_MS = 600_000
  const batchDeadline = batchStart + BATCH_TIMEOUT_MS
  const getBatchRemaining = () => batchDeadline - clock.now()

  try {
    if (bridge.status === 'blocked') {
      reasonCode = 'credential_unavailable'
    } else {
      const fixtures = await loadM05Dv2Fixtures()
      const checked = validateM05Dv2Fixtures(fixtures)
      const tasks = new Map(checked.tasks.map((task) => [task.task_id, task]))

      for (const group of GROUPS) {
        for (const taskId of CANARY_TASKS) {
          const remainingBatch = getBatchRemaining()
          if (remainingBatch <= 0) {
            reasonCode = 'batch_timeout'
            break
          }
          if (ledger.isCircuitOpen()) {
            reasonCode = 'circuit_open'
            break
          }

          const task = tasks.get(taskId)
          if (!task) {
            reasonCode = 'protocol_error'
            break
          }

          const runId = `run_${canonicalHash({
            evaluation_id: 'm05_v2',
            task_id: task.task_id,
            group,
            requested_seed: RUN_SEED,
          }).slice(7, 23)}`

          const onClaim = (kind: 'task' | 'acquisition'): number => {
            if (ledger.isCircuitOpen()) throw new CircuitOpenError()
            const seq = ledger.claim(kind)
            claimKinds.set(seq, kind)
            return seq
          }

          const onTransportFinished = (seq: number): void => {
            ledger.transportFinished(seq)
          }
          const onComplete = (seq: number): void => {
            ledger.completeCall(seq)
          }
          const onFail = (
            seq: number,
            error: unknown,
            fallbackStage: FailureStage
          ): void => {
            const callKind = resolveClaimKind(claimKinds, seq)
            const classification = classifyFailure(error, fallbackStage)
            const diag = createSanitizedFailureDiagnostic({
              sequence: seq,
              call_kind: callKind,
              stage: classification.stage,
              category: classification.category,
              provider_code: classification.provider_code,
            })
            ledger.failedCall(seq, error)
            diagnosticsMap.set(seq, diag)
          }

          try {
            const runResult = await runRealCanarySingleRun({
              task,
              group,
              catalog: checked.catalog,
              bridge,
              runId,
              modelName: options.authorization.runtime.model,
              callTimeoutMs: CALL_TIMEOUT_MS,
              getBatchRemaining,
              ledger,
              onClaim,
              onTransportFinished,
              onComplete,
              onFail,
            })

            const receiptBody = {
              schema_version: 1 as const,
              run_id: runId,
              authorization_sha256: options.authorization.authorization_sha256,
              approval_sha256: options.approval.approval_sha256,
              plan_hash: options.plan.plan_sha256,
              provider: {
                provider: 'deepseek-official' as const,
                model: options.authorization.runtime.model,
              },
              evidence_kind: EVIDENCE_KIND,
              task_id: task.task_id,
              group,
              requested_seed: RUN_SEED as 101,
              seed_honored: false as const,
              claim_sequence: runResult.claimSequence,
              tool_calls: runResult.toolCalls,
              memory_events: runResult.memoryEvents,
              recall_source: runResult.recallSource,
              recall_context: runResult.recallContext,
              recall_receipt: runResult.recallReceipt,
              observed_memory_ids: runResult.observedMemoryIds,
              retrieved_memory_ids: runResult.retrievedMemoryIds,
              opened_memory_ids: runResult.openedMemoryIds,
              adopted_memory_ids: runResult.modelReceipt.adopted_memory_ids,
              model_call_count: runResult.taskCalls,
              model: runResult.modelReceipt,
              usage: {
                model: cleanUsage(runResult.usage),
                retrieval_estimated_tokens: runResult.retrievalEstimatedTokens,
                acquisition_tokens: runResult.acquisitionTokens,
              },
              acquisition: {
                case_id: 'novel_candidate' as const,
                provider_calls: 1 as const,
                after_task_completed: true as const,
                decision: 'novel_candidate' as const,
                reason_code: 'novel_candidate' as const,
                candidate_schema_valid: true as const,
                candidate_content_sha256: runResult.acquisitionCandidateHash,
              },
              duration_ms: runResult.durationMs,
              success: runResult.taskSuccess,
            }

            const receipt: RealCanaryReceipt = {
              ...receiptBody,
              canonical_hash: canonicalHash(receiptBody),
            }

            validateRealCanaryReceipt(receipt)
            // Section 2.6: Receipt is added to memory prefix ONLY after successful persistence
            await persistReceipt(normalizedPersistenceRoot, options.approval.execution_root_sha256, receipt)
            receipts.push(receipt)
            for (const seq of runResult.claimSequence) {
              onComplete(seq)
            }
          } catch (error) {
            ledger.settleAllPendingAsFailed()
            const totalClaimed = ledger.snapshot().total_calls_claimed
            for (let seq = 1; seq <= totalClaimed; seq++) {
              if (!diagnosticsMap.has(seq)) {
                const isCompleted = receipts.some((r) => r.claim_sequence.includes(seq))
                if (!isCompleted) {
                  const kind = resolveClaimKind(claimKinds, seq)
                  const diag = createSanitizedFailureDiagnostic({
                    sequence: seq,
                    call_kind: kind,
                    stage: 'runner_protocol',
                    category: 'runner_protocol_error',
                    provider_code: null,
                  })
                  diagnosticsMap.set(seq, diag)
                }
              }
            }

            if (error instanceof CircuitOpenError) {
              reasonCode = 'circuit_open'
              break
            }
            if (error instanceof BudgetLimitError || (error instanceof LlmError && error.code === 'M05E_BUDGET_EXHAUSTED')) {
              reasonCode = 'budget_exhausted'
              break
            }
            if (error instanceof M05DBatchTimeoutError) {
              reasonCode = 'batch_timeout'
              break
            }
            if (error instanceof M05DAgentTimeoutError) {
              reasonCode = 'call_timeout'
              break
            }
            if (ledger.isCircuitOpen()) {
              reasonCode = 'circuit_open'
              break
            }
            reasonCode = 'protocol_error'
            break
          }
        }
        if (
          reasonCode === 'circuit_open' ||
          reasonCode === 'batch_timeout' ||
          reasonCode === 'call_timeout' ||
          reasonCode === 'budget_exhausted' ||
          reasonCode === 'protocol_error'
        ) {
          break
        }
      }
    }
  } finally {
    // Dispose provider bridge (P0-2 & Section 2.7: sanitized error)
    try {
      await bridge.dispose()
      bridgeDisposed = true
    } catch {
      bridgeDisposed = false
      if (!reasonCode) reasonCode = 'cleanup_failed'
    }

    // Cleanup temporary isolation root
    try {
      await rm(paths.root, { recursive: true, force: false })
      const exists = await lstat(paths.root).catch(() => null)
      if (exists || !bridgeDisposed) {
        cleanupClean = false
        if (!reasonCode) reasonCode = 'cleanup_failed'
      } else {
        cleanupClean = true
      }
    } catch {
      cleanupClean = false
      if (!reasonCode) reasonCode = 'cleanup_failed'
    }
  }

  const runnerStatus: RealCanarySummary['status'] =
    receipts.length === 6 && reasonCode === null && cleanupClean
      ? 'real_provider_plumbing_pass'
      : reasonCode && (CANARY_ABORTED_REASONS as readonly string[]).includes(reasonCode)
      ? 'real_provider_canary_aborted'
      : 'real_provider_plumbing_fail'

  const deterministicPrefixBytes = canonicalBytes(receipts.map(goldenReceipt))
  const failureDiagnostics = Array.from(diagnosticsMap.values()).sort((a, b) => a.sequence - b.sequence)

  const summaryBody = {
    schema_version: 1 as const,
    status: runnerStatus,
    authorization_sha256: options.authorization.authorization_sha256,
    approval_sha256: options.approval.approval_sha256,
    plan_hash: options.plan.plan_sha256,
    fixture_manifest_sha256: worldFacts.fixtureManifestSha256,
    receipts,
    deterministic_prefix_bytes: deterministicPrefixBytes,
    ledger: ledger.snapshot(),
    reason_code: reasonCode ?? null,
    cleanup_clean: cleanupClean,
    failure_diagnostics: failureDiagnostics,
  }

  const summary: RealCanarySummary = {
    ...summaryBody,
    summary_sha256: canonicalHash(summaryBody),
  }

  validateRealCanarySummary(summary)
  await persistSummary(normalizedPersistenceRoot, options.approval.execution_root_sha256, summary)

  return summary
}
