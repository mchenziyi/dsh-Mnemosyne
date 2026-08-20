import { mkdtemp, mkdir, realpath, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { assertHash, assertSafeText, canonicalBytes, canonicalHash, ProtocolValidationError } from '../protocol/canonical.js'
import { loadM05Dv2Fixtures, runAgentLoopEvidence, validateM05Dv2Fixtures, validateModelReceipt, validateUsage, M05DAgentTimeoutError, M05DBatchTimeoutError, ProviderIdentityMismatchError, type M05DTask, type M05DAgentAdapterFactory, type M05DAgentCallContext, type M05DGroup, type Usage, type M05DFixtures } from '../m05d/index.js'
import { validateRecallContext, validateRecallReceipt, type RecallContextEnvelope, type RecallContextReceipt } from '../protocol/recall.js'

const GROUPS = ['no_memory', 'tool_only', 'auto_inject'] as const
const EVIDENCE_KIND = 'adversarial_preflight' as const
const RUN_SEED = 101
const PLAN_LIMITS = { task_calls: 24, acquisition_calls: 6, total_calls: 30 } as const
const TIMEOUTS = { call_timeout_ms: 30_000, batch_timeout_ms: 600_000 } as const
const V2_MANIFEST_HASH = 'sha256_7462d1a97ba7207a0caece22938161c8790401460e4672fd67eb3237df40352f'
const CANARY_TASKS = ['task_build_recovery', 'task_control_format'] as const
const RESULT_FIELDS: Record<string, string[]> = { task_build_recovery: ['rebuild_mode'], task_control_format: ['controlled_field'] }
const PROVIDER_IDENTITY = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const
const REASONS = ['budget_exhausted', 'call_timeout', 'batch_timeout', 'circuit_open', 'protocol_error', 'isolation_error', 'cleanup_failed'] as const
type ReasonCode = (typeof REASONS)[number]

function invalid(): never { throw new ProtocolValidationError() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) invalid() }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(); return value as number }
function id(value: unknown, prefix: string): string { if (typeof value !== 'string' || !new RegExp(`^${prefix}[a-z0-9][a-z0-9._-]{0,63}$`).test(value)) invalid(); return value }
function strings(value: unknown, max: number): string[] { if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) invalid(); return [...value as string[]] }
function memoryIds(value: unknown): string[] { const result = strings(value, 32); if (result.some((item) => !/^memory_[a-z0-9][a-z0-9._-]{0,63}$/.test(item)) || JSON.stringify(result) !== JSON.stringify([...result].sort())) invalid(); return result }

export interface CanaryRunSpec { run_id: string; task_id: string; group: (typeof GROUPS)[number]; task_kind: M05DTask['task_kind']; requested_seed: 101; acquisition_case_id: 'novel_candidate' }
export interface CanaryPlan {
  schema_version: 1
  plan_version: 1
  evaluation_id: 'm05_v2'
  fixture_manifest_sha256: string
  runs: CanaryRunSpec[]
  provider: { provider: string; model: string }
  budget: { max_task_calls: 24; max_acquisition_calls: 6; max_total_calls: 30 }
  timeouts: { call_timeout_ms: 30_000; batch_timeout_ms: 600_000 }
  isolation_root_ref: 'temporary-root'
  plan_hash: string
}

export interface CanaryCallContext { provider: string; model: string; run_id: string; task_id: string; kind: 'task' | 'acquisition'; requested_seed: 101; sequence: number }
export type AdapterFactory = (context: CanaryCallContext) => LlmAdapter
export interface CanaryClock { now(): number }
export interface CanaryTimeouts { call_timeout_ms: number; batch_timeout_ms: number }
export interface CanaryReceipt {
  schema_version: 1
  run_id: string
  plan_hash: string
  provider: { provider: string; model: string }
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
  acquisition: { provider_calls: 1; candidate_content_sha256: string }
  duration_ms: number
  success: boolean
  canonical_hash: string
}
export interface BudgetSnapshot { task_calls_claimed: number; acquisition_calls_claimed: number; total_calls_claimed: number; completed_calls: number; failed_calls: number; consecutive_provider_or_protocol_errors: number }
export interface CanarySummary {
  status: 'canary_preflight_ready' | 'canary_aborted'
  evidence_kind: typeof EVIDENCE_KIND
  plan: CanaryPlan
  plan_hash: string
  receipts: CanaryReceipt[]
  deterministic_prefix_bytes: string
  ledger: BudgetSnapshot
  reason_code?: ReasonCode
  cleanup_clean: boolean
}

export type ClaimStatus = 'pending' | 'transport_finished' | 'completed' | 'failed'

export class BudgetLedger {
  private task = 0
  private acquisition = 0
  private total = 0
  private completed = 0
  private failed = 0
  private consecutive = 0
  private circuit = false
  private claims = new Map<number, { kind: 'task' | 'acquisition'; status: ClaimStatus }>()

  claim(kind: 'task' | 'acquisition'): number {
    if (this.circuit) throw new CircuitOpenError()
    if (kind === 'task' && this.task >= PLAN_LIMITS.task_calls || kind === 'acquisition' && this.acquisition >= PLAN_LIMITS.acquisition_calls || this.total >= PLAN_LIMITS.total_calls) {
      throw new BudgetLimitError()
    }
    if (kind === 'task') this.task++
    else this.acquisition++
    this.total++
    const sequence = this.total
    this.claims.set(sequence, { kind, status: 'pending' })
    return sequence
  }

  transportFinished(sequence: number): void {
    const claim = this.claims.get(sequence)
    if (!claim || claim.status !== 'pending') {
      throw new ProtocolValidationError()
    }
    claim.status = 'transport_finished'
  }

  completeCall(sequence: number): void {
    const claim = this.claims.get(sequence)
    if (!claim || claim.status !== 'transport_finished') {
      throw new ProtocolValidationError()
    }
    claim.status = 'completed'
    this.completed++
    this.consecutive = 0
  }

  failedCall(sequence: number, _error?: unknown): void {
    const claim = this.claims.get(sequence)
    if (!claim || claim.status === 'completed' || claim.status === 'failed') {
      throw new ProtocolValidationError()
    }
    claim.status = 'failed'
    this.failed++
    if (this.consecutive < 2) {
      this.consecutive++
    }
    if (this.consecutive >= 2) this.circuit = true
  }

  assertionFailure(): void {
    this.consecutive = 0
  }

  isCircuitOpen(): boolean {
    return this.circuit
  }

  settleAllPendingAsFailed(): void {
    for (const [sequence, claim] of this.claims.entries()) {
      if (claim.status === 'pending' || claim.status === 'transport_finished') {
        this.failedCall(sequence)
      }
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      task_calls_claimed: this.task,
      acquisition_calls_claimed: this.acquisition,
      total_calls_claimed: this.total,
      completed_calls: this.completed,
      failed_calls: this.failed,
      consecutive_provider_or_protocol_errors: this.consecutive,
    }
  }
}

function validateRun(value: unknown): CanaryRunSpec {
  const run = object(value); exact(run, ['run_id', 'task_id', 'group', 'task_kind', 'requested_seed', 'acquisition_case_id'])
  id(run.run_id, 'run_'); id(run.task_id, 'task_'); if (!GROUPS.includes(run.group as (typeof GROUPS)[number]) || (run.task_kind !== 'memory_dependent' && run.task_kind !== 'non_memory_control') || run.requested_seed !== RUN_SEED || run.acquisition_case_id !== 'novel_candidate') invalid()
  return run as unknown as CanaryRunSpec
}

export function validateCanaryPlan(value: unknown): CanaryPlan {
  const plan = object(value); exact(plan, ['schema_version', 'plan_version', 'evaluation_id', 'fixture_manifest_sha256', 'runs', 'provider', 'budget', 'timeouts', 'isolation_root_ref', 'plan_hash'])
  if (plan.schema_version !== 1 || plan.plan_version !== 1 || plan.evaluation_id !== 'm05_v2' || plan.isolation_root_ref !== 'temporary-root') invalid(); assertHash(plan.fixture_manifest_sha256); assertHash(plan.plan_hash)
  if (!Array.isArray(plan.runs) || plan.runs.length !== 6) invalid(); const runs = plan.runs.map(validateRun); if (new Set(runs.map((run) => run.run_id)).size !== 6 || new Set(runs.map((run) => `${run.task_id}\0${run.group}`)).size !== 6) invalid()
  const provider = object(plan.provider); exact(provider, ['provider', 'model']); if (provider.provider !== PROVIDER_IDENTITY.provider || provider.model !== PROVIDER_IDENTITY.model) invalid(); assertSafeText(provider.provider, 120); assertSafeText(provider.model, 120)
  const budget = object(plan.budget); exact(budget, ['max_task_calls', 'max_acquisition_calls', 'max_total_calls']); if (budget.max_task_calls !== 24 || budget.max_acquisition_calls !== 6 || budget.max_total_calls !== 30) invalid()
  const timeouts = object(plan.timeouts); exact(timeouts, ['call_timeout_ms', 'batch_timeout_ms']); if (timeouts.call_timeout_ms !== 30_000 || timeouts.batch_timeout_ms !== 600_000) invalid()
  const body = { schema_version: 1 as const, plan_version: 1 as const, evaluation_id: 'm05_v2' as const, fixture_manifest_sha256: plan.fixture_manifest_sha256 as string, runs, provider: provider as CanaryPlan['provider'], budget: budget as CanaryPlan['budget'], timeouts: timeouts as CanaryPlan['timeouts'], isolation_root_ref: 'temporary-root' as const }
  if (plan.fixture_manifest_sha256 !== V2_MANIFEST_HASH || runs.some((run, index) => run.task_id !== CANARY_TASKS[index % 2] || run.group !== GROUPS[Math.floor(index / 2)] || run.task_kind !== (index % 2 === 0 ? 'memory_dependent' : 'non_memory_control'))) invalid()
  if (canonicalHash(body) !== plan.plan_hash) invalid()
  return { ...body, plan_hash: plan.plan_hash as string }
}

export async function createCanaryPlan(): Promise<CanaryPlan> {
  const fixtures = await loadM05Dv2Fixtures(); const checked = validateM05Dv2Fixtures(fixtures); if (checked.protocol.model.provider !== PROVIDER_IDENTITY.provider || checked.protocol.model.model !== PROVIDER_IDENTITY.model) invalid(); const memory = checked.tasks.find((task) => task.task_kind === 'memory_dependent'); const control = checked.tasks.find((task) => task.task_kind === 'non_memory_control'); if (!memory || !control) invalid()
  const runs: CanaryRunSpec[] = []
  for (const group of GROUPS) for (const task of [memory, control]) runs.push({ run_id: `run_${canonicalHash({ evaluation_id: checked.protocol.evaluation_id, task_id: task.task_id, group, requested_seed: RUN_SEED }).slice(7, 23)}`, task_id: task.task_id, group, task_kind: task.task_kind, requested_seed: RUN_SEED, acquisition_case_id: 'novel_candidate' })
  const body = { schema_version: 1 as const, plan_version: 1 as const, evaluation_id: 'm05_v2' as const, fixture_manifest_sha256: canonicalHash(checked.manifest), runs, provider: PROVIDER_IDENTITY, budget: { max_task_calls: 24 as const, max_acquisition_calls: 6 as const, max_total_calls: 30 as const }, timeouts: TIMEOUTS, isolation_root_ref: 'temporary-root' as const }
  return validateCanaryPlan({ ...body, plan_hash: canonicalHash(body) })
}

function sensitive(value: string): void { assertSafeText(value, 20_000); if (/(?:^|[\\/])(?:Users|home|private|var|tmp|etc)(?:[\\/])|\.\.(?:[\\/]|$)/i.test(value)) invalid() }
function receiptBody(receipt: Omit<CanaryReceipt, 'canonical_hash'>): Omit<CanaryReceipt, 'canonical_hash'> { return receipt }
function goldenReceipt(receipt: CanaryReceipt): Record<string, unknown> { const { duration_ms: _duration, canonical_hash: _hash, ...body } = receipt; return body }

function taskSucceeded(task: M05DTask, model: ReturnType<typeof validateModelReceipt>): boolean { return task.success_assertions.every((assertion) => assertion.kind === 'exit_code' ? model.exit_code === assertion.expected : model.result[assertion.field as string] === assertion.expected) }

function validateCandidate(raw: string, expected: NonNullable<ReturnType<typeof findNovel>>): string {
  let value: unknown; try { value = JSON.parse(raw) } catch { invalid() }; const candidate = object(value); exact(candidate, ['title', 'summary', 'redaction_status']); if (candidate.redaction_status !== 'passed' || typeof candidate.title !== 'string' || typeof candidate.summary !== 'string') invalid(); assertSafeText(candidate.title, 200); assertSafeText(candidate.summary, 1000)
  const hash = canonicalHash(candidate); if (hash !== canonicalHash(expected.provider_output)) invalid(); return hash
}
function findNovel(fixtures: Awaited<ReturnType<typeof loadM05Dv2Fixtures>>) { const item = fixtures.acquisitionCases.find((candidate) => candidate.case_id === 'novel_candidate'); if (!item || !item.provider_output) invalid(); return item }

function validateReceipt(receipt: CanaryReceipt): CanaryReceipt {
  const value = object(receipt)
  exact(value, ['schema_version', 'run_id', 'plan_hash', 'provider', 'evidence_kind', 'task_id', 'group', 'requested_seed', 'seed_honored', 'claim_sequence', 'tool_calls', 'memory_events', 'recall_source', 'recall_context', 'recall_receipt', 'observed_memory_ids', 'retrieved_memory_ids', 'opened_memory_ids', 'adopted_memory_ids', 'model_call_count', 'model', 'usage', 'acquisition', 'duration_ms', 'success', 'canonical_hash'])
  assertHash(value.plan_hash); assertHash(value.canonical_hash); id(value.run_id, 'run_'); const taskId = id(value.task_id, 'task_')
  if (value.schema_version !== 1 || value.evidence_kind !== EVIDENCE_KIND || !GROUPS.includes(value.group as (typeof GROUPS)[number]) || value.requested_seed !== RUN_SEED || value.seed_honored !== false) invalid()
  const provider = object(value.provider); exact(provider, ['provider', 'model']); if (provider.provider !== PROVIDER_IDENTITY.provider || provider.model !== PROVIDER_IDENTITY.model) invalid()
  const fields = RESULT_FIELDS[taskId]; if (!fields) invalid()
  const toolCalls = strings(value.tool_calls, 8); if (!Array.isArray(value.memory_events) || value.memory_events.length > 8 || value.memory_events.some((event) => typeof event !== 'string')) invalid(); const memoryEvents = [...value.memory_events as string[]]; if (memoryEvents.some((event) => event !== 'user_message' && event !== 'recall_user_message')) invalid()
  const observed = memoryIds(value.observed_memory_ids); const retrieved = memoryIds(value.retrieved_memory_ids); const opened = memoryIds(value.opened_memory_ids); const adopted = memoryIds(value.adopted_memory_ids)
  let model: ReturnType<typeof validateModelReceipt>; model = validateModelReceipt(JSON.stringify(object(value.model)), observed, fields, taskId)
  for (const item of Object.values(model.result)) if (typeof item === 'string') sensitive(item)
  if ([...retrieved, ...opened, ...adopted].some((memoryId) => !observed.includes(memoryId)) || opened.some((memoryId) => !retrieved.includes(memoryId)) || adopted.some((memoryId) => !opened.includes(memoryId))) invalid()
  const modelCallCount = integer(value.model_call_count, 1, 4); const claimSequence = value.claim_sequence; if (!Array.isArray(claimSequence) || claimSequence.length !== modelCallCount + 1 || claimSequence.some((item) => !Number.isSafeInteger(item) || item < 1) || new Set(claimSequence).size !== claimSequence.length || JSON.stringify(claimSequence) !== JSON.stringify([...claimSequence].sort((a, b) => (a as number) - (b as number)))) invalid()
  const usage = object(value.usage); exact(usage, ['model', 'retrieval_estimated_tokens', 'acquisition_tokens']); validateUsage(usage.model); integer(usage.retrieval_estimated_tokens); integer(usage.acquisition_tokens)
  const acquisition = object(value.acquisition); exact(acquisition, ['case_id', 'provider_calls', 'after_task_completed', 'decision', 'reason_code', 'candidate_content_sha256']); if (acquisition.case_id !== 'novel_candidate' || acquisition.provider_calls !== 1 || acquisition.after_task_completed !== true || acquisition.decision !== 'novel_candidate' || acquisition.reason_code !== 'novel_candidate') invalid(); assertHash(acquisition.candidate_content_sha256)
  let recallContext: RecallContextEnvelope | null = null
  if (value.recall_source !== null || value.recall_context !== null || value.recall_receipt !== null) { const source = object(value.recall_source); exact(source, ['kind', 'plugin', 'form']); if (source.kind !== 'plugin' || source.plugin !== 'dsh-mnemosyne' || source.form !== 'recall' || value.recall_context === null || value.recall_receipt === null) invalid(); recallContext = validateRecallContext(value.recall_context); const recallReceipt = validateRecallReceipt(value.recall_receipt); if (recallReceipt.context_content_sha256 !== recallContext.content_sha256) invalid() }
  if (value.group === 'no_memory' && (JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']) || observed.length !== 0 || retrieved.length !== 0 || opened.length !== 0 || adopted.length !== 0 || memoryEvents.includes('recall_user_message') || value.recall_source !== null || value.recall_context !== null || value.recall_receipt !== null)) invalid()
  if (value.group === 'tool_only' && taskId === 'task_build_recovery' && JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open'])) invalid()
  if (value.group === 'tool_only' && taskId === 'task_control_format' && JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture'])) invalid()
  if (value.group === 'tool_only' && (value.recall_source !== null || value.recall_context !== null || value.recall_receipt !== null || memoryEvents.includes('recall_user_message'))) invalid()
  if (taskId === 'task_control_format' && (observed.length !== 0 || retrieved.length !== 0 || opened.length !== 0 || adopted.length !== 0)) invalid()
  if (value.group === 'auto_inject' && taskId === 'task_build_recovery' && (JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']) || value.recall_source === null || value.recall_context === null || value.recall_receipt === null)) invalid()
  if (value.group === 'auto_inject' && taskId === 'task_build_recovery' && recallContext !== null) { const contextRetrieved = recallContext.search_disclosure.items.map((item) => item.memory_id).sort(); const contextOpened = recallContext.open_disclosures.map((item) => item.memory_id).sort(); const contextMemoryIds = recallContext.memory_ids.slice().sort(); const expectedObserved = [...new Set([...contextRetrieved, ...contextOpened])].sort(); if (JSON.stringify(contextRetrieved) !== JSON.stringify(retrieved) || JSON.stringify(contextOpened) !== JSON.stringify(opened) || JSON.stringify(contextMemoryIds) !== JSON.stringify(opened) || JSON.stringify(expectedObserved) !== JSON.stringify(observed)) invalid() }
  if (value.group === 'auto_inject' && taskId === 'task_control_format' && (JSON.stringify(toolCalls) !== JSON.stringify(['m05d_task_fixture']) || value.recall_source !== null || value.recall_context !== null || value.recall_receipt !== null)) invalid()
  integer(value.duration_ms, 0, 600_000); if (typeof value.success !== 'boolean') invalid(); const body = { ...value }; delete body.canonical_hash; if (canonicalHash(body) !== value.canonical_hash) invalid()
  return { ...receipt, tool_calls: toolCalls, memory_events: memoryEvents, observed_memory_ids: observed, retrieved_memory_ids: retrieved, opened_memory_ids: opened, adopted_memory_ids: adopted, model_call_count: modelCallCount, model }
}

export interface IsolationPaths { root: string; dsh_home: string; workspace: string; receipts: string }
function rejectPath(rootPath: string): void { if (!isAbsolute(rootPath) || rootPath.split(sep).includes('..') || normalize(rootPath).split(sep).includes('..')) invalid() }
export async function prepareIsolationRoot(rootPath: string): Promise<IsolationPaths> {
  rejectPath(rootPath)
  const normalized = normalize(resolve(rootPath))
  const segments = normalized.split(sep).filter(Boolean)
  let curr = normalized.startsWith(sep) ? sep : ''
  for (let i = 0; i < segments.length; i++) {
    curr = join(curr, segments[i])
    const isLast = i === segments.length - 1
    try {
      const st = await lstat(curr)
      if (st.isSymbolicLink() || !st.isDirectory()) invalid()
      if (isLast) invalid()
    } catch (err) {
      if (err instanceof ProtocolValidationError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') invalid()
      await mkdir(curr)
      const st = await lstat(curr)
      if (st.isSymbolicLink() || !st.isDirectory()) invalid()
    }
  }
  const root = normalized
  const paths = { root, dsh_home: join(root, 'dsh-home'), workspace: join(root, 'workspace'), receipts: join(root, 'receipts') }
  for (const child of [paths.dsh_home, paths.workspace, paths.receipts]) {
    await mkdir(child)
    const st = await lstat(child)
    if (st.isSymbolicLink() || !st.isDirectory()) invalid()
  }
  return paths
}
async function createIsolationRoot(): Promise<IsolationPaths> { const base = await realpath(tmpdir()); const root = await mkdtemp(join(base, 'dsh-m05e-')); const paths = { root, dsh_home: join(root, 'dsh-home'), workspace: join(root, 'workspace'), receipts: join(root, 'receipts') }; await mkdir(paths.dsh_home); await mkdir(paths.workspace); await mkdir(paths.receipts); return paths }

function clockDefault(): CanaryClock { return { now: () => performance.now() } }
function timeoutValues(value: CanaryTimeouts | undefined): CanaryTimeouts { const result = { call_timeout_ms: value?.call_timeout_ms ?? TIMEOUTS.call_timeout_ms, batch_timeout_ms: value?.batch_timeout_ms ?? TIMEOUTS.batch_timeout_ms }; if (!Number.isSafeInteger(result.call_timeout_ms) || result.call_timeout_ms < 0 || !Number.isSafeInteger(result.batch_timeout_ms) || result.batch_timeout_ms < 0) invalid(); return result }

class CircuitOpenError extends LlmError { constructor() { super('circuit breaker open', 'M05E_CIRCUIT_OPEN') } }
class BudgetLimitError extends LlmError { constructor() { super('budget claim rejected', 'M05E_BUDGET_EXHAUSTED') } }

export async function runCanaryPreflight(factory: AdapterFactory, options: { clock?: CanaryClock; timeouts?: CanaryTimeouts } = {}): Promise<CanarySummary> {
  const fixtures = await loadM05Dv2Fixtures(); const checkedPlan = validateCanaryPlan(await createCanaryPlan()); const ledger = new BudgetLedger(); const clock = options.clock ?? clockDefault(); const timeout = timeoutValues(options.timeouts); const started = clock.now(); const receipts: CanaryReceipt[] = []; let reason: ReasonCode | undefined; let paths: IsolationPaths | undefined; let cleanup = true
  try { paths = await createIsolationRoot() } catch {
    const summary: CanarySummary = { status: 'canary_aborted', evidence_kind: EVIDENCE_KIND, plan: checkedPlan, plan_hash: checkedPlan.plan_hash, receipts, deterministic_prefix_bytes: canonicalBytes(receipts.map(goldenReceipt)), ledger: ledger.snapshot(), reason_code: 'isolation_error', cleanup_clean: false }
    validateCanarySummary(summary, fixtures)
    return summary
  }
  try {
    const tasks = new Map(fixtures.tasks.map((task) => [task.task_id, task])); const novel = findNovel(fixtures)
    const batchDeadline = started + timeout.batch_timeout_ms
    const getBatchRemaining = () => batchDeadline - clock.now()
    for (const run of checkedPlan.runs) {
      const remainingBatch = getBatchRemaining()
      if (remainingBatch <= 0) { reason = 'batch_timeout'; break }
      if (ledger.isCircuitOpen()) { reason = 'circuit_open'; break }
      const task = tasks.get(run.task_id); if (!task) { reason = 'protocol_error'; break }
      let taskCalls = 0; let acquisitionCalls = 0; let budgetRejected = false; const claimSequence: number[] = []
      const claim = (kind: 'task' | 'acquisition', _context: Omit<M05DAgentCallContext, 'sequence'>): number => {
        if (ledger.isCircuitOpen()) throw new CircuitOpenError()
        if (kind === 'task' && taskCalls >= 4 || kind === 'acquisition' && acquisitionCalls >= 1) { budgetRejected = true; throw new BudgetLimitError() }
        const sequence = ledger.claim(kind); if (kind === 'task') taskCalls++; else acquisitionCalls++; claimSequence.push(sequence); return sequence
      }
      const onTransportFinished = (sequence: number): void => { ledger.transportFinished(sequence) }
      const onComplete = (sequence: number): void => { ledger.completeCall(sequence) }
      const onFail = (sequence: number, error: unknown): void => { ledger.failedCall(sequence, error) }
      try {
        const evidence = await runAgentLoopEvidence(task, run.group as M05DGroup, fixtures.catalog, novel, timeout.call_timeout_ms, { adapterFactory: factory as M05DAgentAdapterFactory, claim, onTransportFinished, onComplete, onFail, run_id: run.run_id, requested_seed: RUN_SEED, provider: checkedPlan.provider.provider, model: checkedPlan.provider.model, batchTimeoutMs: remainingBatch, getBatchRemaining })
        const success = taskSucceeded(task, evidence.receipt); ledger.assertionFailure(); const candidateHash = evidence.acquisition.candidate_content_sha256; if (candidateHash === null) invalid()
        const body = { schema_version: 1 as const, run_id: run.run_id, plan_hash: checkedPlan.plan_hash, provider: checkedPlan.provider, evidence_kind: EVIDENCE_KIND, task_id: run.task_id, group: run.group, requested_seed: RUN_SEED as 101, seed_honored: false, claim_sequence: claimSequence, tool_calls: evidence.toolCalls, memory_events: evidence.memoryEvents, recall_source: evidence.recallSource, recall_context: evidence.recallContext, recall_receipt: evidence.recallReceipt, observed_memory_ids: evidence.observedMemoryIds, retrieved_memory_ids: evidence.retrievedMemoryIds, opened_memory_ids: evidence.openedMemoryIds, adopted_memory_ids: evidence.receipt.adopted_memory_ids, model_call_count: evidence.modelCallCount, model: evidence.receipt, usage: { model: evidence.usage, retrieval_estimated_tokens: evidence.retrievalEstimatedTokens, acquisition_tokens: evidence.acquisitionTokens }, acquisition: { ...evidence.acquisition, provider_calls: 1 as const, candidate_content_sha256: candidateHash }, duration_ms: evidence.duration_ms, success }
        const receipt = { ...body, canonical_hash: canonicalHash(body) }; validateReceipt(receipt); await writeFile(join(paths.receipts, `${run.run_id}.json`), canonicalBytes(receipt), { flag: 'wx' }); receipts.push(receipt)
      } catch (error) {
        ledger.settleAllPendingAsFailed()
        if (error instanceof CircuitOpenError || ledger.isCircuitOpen()) { reason = 'circuit_open'; break }
        if (budgetRejected || error instanceof BudgetLimitError || (error instanceof LlmError && error.code === 'M05E_BUDGET_EXHAUSTED')) { reason = 'budget_exhausted'; break }
        if (error instanceof M05DBatchTimeoutError) {
          reason = 'batch_timeout'
          break
        }
        if (error instanceof M05DAgentTimeoutError) {
          reason = 'call_timeout'
          break
        }
        if (error instanceof ProviderIdentityMismatchError) {
          reason = 'protocol_error'
          break
        }
        reason = ledger.isCircuitOpen() ? 'circuit_open' : 'protocol_error'
        break
      }
    }
    ledger.settleAllPendingAsFailed()
    if (!reason) { const { plan_hash: _planHash, ...body } = checkedPlan; if (canonicalHash(body) !== checkedPlan.plan_hash) reason = 'protocol_error' }
    if (!reason && receipts.length === checkedPlan.runs.length) {
      try { await rm(paths.root, { recursive: true, force: false }) } catch { cleanup = false; reason = 'cleanup_failed' }
      if (!reason) {
        const readySummary: CanarySummary = { status: 'canary_preflight_ready', evidence_kind: EVIDENCE_KIND, plan: checkedPlan, plan_hash: checkedPlan.plan_hash, receipts, deterministic_prefix_bytes: canonicalBytes(receipts.map(goldenReceipt)), ledger: ledger.snapshot(), cleanup_clean: cleanup }
        validateCanarySummary(readySummary, fixtures)
        return readySummary
      }
    }
    if (!reason) reason = ledger.isCircuitOpen() ? 'circuit_open' : 'protocol_error'
  } catch {
    ledger.settleAllPendingAsFailed()
    reason = reason ?? 'protocol_error'
  }
  try { if (paths) await rm(paths.root, { recursive: true, force: false }) } catch { cleanup = false }
  const abortedSummary: CanarySummary = { status: 'canary_aborted', evidence_kind: EVIDENCE_KIND, plan: checkedPlan, plan_hash: checkedPlan.plan_hash, receipts, deterministic_prefix_bytes: canonicalBytes(receipts.map(goldenReceipt)), ledger: ledger.snapshot(), reason_code: reason, cleanup_clean: cleanup }
  validateCanarySummary(abortedSummary, fixtures)
  return abortedSummary
}

export function validateCanarySummary(value: unknown, fixtures: M05DFixtures): CanarySummary {
  const checked = validateM05Dv2Fixtures(fixtures); const summary = object(value); const keys = Object.keys(summary).sort(); const baseKeys = ['status', 'evidence_kind', 'plan', 'plan_hash', 'receipts', 'deterministic_prefix_bytes', 'ledger', 'cleanup_clean'].sort(); const reasonKeys = [...baseKeys, 'reason_code'].sort(); if (keys.join('\0') !== baseKeys.join('\0') && keys.join('\0') !== reasonKeys.join('\0')) invalid(); const plan = validateCanaryPlan(summary.plan); assertHash(summary.plan_hash); if (canonicalHash(checked.manifest) !== plan.fixture_manifest_sha256 || summary.plan_hash !== plan.plan_hash || summary.evidence_kind !== EVIDENCE_KIND || (summary.status !== 'canary_preflight_ready' && summary.status !== 'canary_aborted') || !Array.isArray(summary.receipts) || typeof summary.deterministic_prefix_bytes !== 'string' || typeof summary.cleanup_clean !== 'boolean') invalid()
  const ledger = object(summary.ledger); exact(ledger, ['task_calls_claimed', 'acquisition_calls_claimed', 'total_calls_claimed', 'completed_calls', 'failed_calls', 'consecutive_provider_or_protocol_errors']); const taskClaims = integer(ledger.task_calls_claimed, 0, 24); const acquisitionClaims = integer(ledger.acquisition_calls_claimed, 0, 6); const totalClaims = integer(ledger.total_calls_claimed, 0, 30); const completedCalls = integer(ledger.completed_calls, 0, 30); const failedCalls = integer(ledger.failed_calls, 0, 30); const consecutiveErrors = integer(ledger.consecutive_provider_or_protocol_errors, 0, 2); if (totalClaims !== taskClaims + acquisitionClaims || completedCalls + failedCalls !== totalClaims) invalid()
  if (consecutiveErrors > failedCalls || consecutiveErrors < 0) invalid()
  const taskById = new Map(checked.tasks.map((task) => [task.task_id, task])); const forbidden = new Set([...checked.tasks.flatMap((task) => task.forbidden_memory_ids), ...checked.catalog.memories.filter((memory) => memory.lifecycle !== 'active').map((memory) => memory.memory_id)]); const receipts = summary.receipts.map((receipt) => validateReceipt(receipt)); if (receipts.length > 6) invalid()
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index]; const task = taskById.get(receipt.task_id); if (!task || receipt.run_id !== plan.runs[index]?.run_id || receipt.plan_hash !== plan.plan_hash || JSON.stringify(receipt.provider) !== JSON.stringify(plan.provider) || receipt.task_id !== plan.runs[index]?.task_id || receipt.group !== plan.runs[index]?.group || task.task_kind !== plan.runs[index]?.task_kind || [...receipt.observed_memory_ids, ...receipt.retrieved_memory_ids, ...receipt.opened_memory_ids, ...receipt.adopted_memory_ids].some((memoryId) => forbidden.has(memoryId))) invalid()
    const recomputedSuccess = task.success_assertions.every((assertion) => assertion.kind === 'exit_code' ? receipt.model.exit_code === assertion.expected : receipt.model.result[assertion.field as string] === assertion.expected); if (receipt.success !== recomputedSuccess) invalid()
  }
  const allSequences = receipts.flatMap((r) => r.claim_sequence)
  for (let i = 0; i < allSequences.length; i++) { if (allSequences[i] !== i + 1) invalid() }
  if (allSequences.length > totalClaims) invalid()
  if (summary.status === 'canary_preflight_ready') {
    if (receipts.length !== 6 || summary.reason_code !== undefined || !summary.cleanup_clean || failedCalls !== 0 || completedCalls !== totalClaims || consecutiveErrors !== 0 || acquisitionClaims !== 6 || allSequences.length !== totalClaims) invalid()
    const taskCalls = receipts.reduce((total, receipt) => total + receipt.model_call_count, 0); if (taskClaims !== taskCalls) invalid()
  }
  if (summary.status === 'canary_aborted') {
    if (!REASONS.includes(summary.reason_code as ReasonCode) || !summary.reason_code) invalid()
    if (summary.reason_code === 'circuit_open' && consecutiveErrors !== 2) invalid()
    if (summary.reason_code === 'call_timeout' && failedCalls < 1) invalid()
  }
  if (summary.deterministic_prefix_bytes !== canonicalBytes(receipts.map(goldenReceipt))) invalid()
  return summary as unknown as CanarySummary
}

