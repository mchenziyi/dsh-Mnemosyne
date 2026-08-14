import {
  assertArray,
  assertExactKeys,
  assertEnum,
  assertHash,
  assertId,
  assertInteger,
  assertNoDuplicate,
  assertObject,
  assertSafeText,
  compareCodePoints,
  assertString,
  canonicalBytes,
  canonicalHash,
  ProtocolValidationError,
} from './canonical.js'

const GROUPS = ['no_memory', 'tool_only', 'auto_inject'] as const
const DIFFICULTIES = ['exact', 'rephrase', 'alias', 'cross_component', 'negative_control'] as const
const LIFECYCLES = ['active', 'frozen', 'excluded'] as const
const GATE_STATUSES = ['pass', 'fail', 'insufficient_evidence'] as const
const RECOMMENDATIONS = ['go', 'adjust', 'stop', 'insufficient_evidence'] as const
const MEMORY_ID = /^memory_[a-z0-9][a-z0-9._-]{0,63}$/
const RETRIEVAL_ID = /^retrieval_[a-z0-9][a-z0-9._-]{0,63}$/
const TASK_ID = /^task_[a-z0-9][a-z0-9._-]{0,63}$/
const RUN_ID = /^run_[a-z0-9][a-z0-9._-]{0,63}$/
const CONTROLLED_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const THRESHOLD_VALUES: Record<string, number> = {
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
}

function id(value: unknown, expression: RegExp): asserts value is string {
  if (typeof value !== 'string' || !expression.test(value)) throw new ProtocolValidationError()
}

function list(value: unknown, max: number, expression: RegExp = CONTROLLED_ID): string[] {
  assertArray(value, max)
  if (!value.every((item) => typeof item === 'string' && expression.test(item))) throw new ProtocolValidationError()
  const values = value as string[]
  assertNoDuplicate(values)
  return [...values].sort(compareCodePoints)
}

function textList(value: unknown, max: number, itemMax: number): string[] {
  assertArray(value, max)
  for (const item of value) assertSafeText(item, itemMax)
  const values = value as string[]
  assertNoDuplicate(values)
  return [...values].sort(compareCodePoints)
}

function hashWithout(value: Record<string, unknown>, key: string): string {
  const copy = { ...value }
  delete copy[key]
  return canonicalHash(copy)
}

function assertHashField(value: unknown, expected: string): void {
  assertHash(value)
  if (value !== expected) throw new ProtocolValidationError()
}

export interface EvaluationProtocol {
  schema_version: 1
  evaluation_id: 'm05_v1'
  fixture_version: 1
  groups: ['no_memory', 'tool_only', 'auto_inject']
  model: { provider: string; model: string; temperature: 0; requested_seeds: number[] }
  repetitions_per_task: 5
  thresholds: Record<string, number>
}

const PROTOCOL_KEYS = ['schema_version', 'evaluation_id', 'fixture_version', 'groups', 'model', 'repetitions_per_task', 'thresholds'] as const
const MODEL_KEYS = ['provider', 'model', 'temperature', 'requested_seeds'] as const
const THRESHOLD_KEYS = ['difficult_recall_at_5_min', 'context_precision_at_5_min', 'excluded_leakage_max', 'replay_consistency_min', 'wrong_memory_adoption_max', 'tool_only_success_delta_points_min', 'non_memory_regression_points_max', 'overhead_token_ratio_median_max', 'retrieval_latency_p95_ms_max', 'acquisition_critical_path_blocking_max'] as const

export function validateEvaluationProtocol(value: unknown): EvaluationProtocol {
  assertObject(value); assertExactKeys(value, PROTOCOL_KEYS)
  assertInteger(value.schema_version, 1, 1); assertEnum(value.evaluation_id, ['m05_v1']); assertInteger(value.fixture_version, 1, 1)
  if (!Array.isArray(value.groups) || value.groups.length !== 3 || [...value.groups].sort(compareCodePoints).join(',') !== [...GROUPS].sort(compareCodePoints).join(',')) throw new ProtocolValidationError()
  assertObject(value.model); assertExactKeys(value.model, MODEL_KEYS)
  assertSafeText(value.model.provider, 80); assertSafeText(value.model.model, 120); assertInteger(value.model.temperature, 0, 0)
  const seeds = value.model.requested_seeds
  assertArray(seeds, 5); const numericSeeds = seeds as unknown[]; if (!numericSeeds.every((seed) => Number.isSafeInteger(seed) && (seed as number) >= 0)) throw new ProtocolValidationError()
  if (new Set(numericSeeds as number[]).size !== numericSeeds.length || numericSeeds.length !== 5) throw new ProtocolValidationError()
  assertInteger(value.repetitions_per_task, 5, 5)
  assertObject(value.thresholds); assertExactKeys(value.thresholds, THRESHOLD_KEYS)
  const thresholds: Record<string, number> = {}
  for (const key of THRESHOLD_KEYS) {
    const n = value.thresholds[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n !== THRESHOLD_VALUES[key]) throw new ProtocolValidationError()
    thresholds[key] = Object.is(n, -0) ? 0 : n
  }
  return { schema_version: 1, evaluation_id: 'm05_v1', fixture_version: 1, groups: ['no_memory', 'tool_only', 'auto_inject'], model: { provider: value.model.provider, model: value.model.model, temperature: 0, requested_seeds: [...(numericSeeds as number[])].sort((a, b) => a - b) }, repetitions_per_task: 5, thresholds }
}

export interface MemoryFixture {
  memory_id: string; title: string; summary: string; component: string; operation: string; tags: string[]; aliases: string[]; body: string; lifecycle: 'active' | 'frozen' | 'excluded'; content_sha256: string
}
export interface MemoryCatalog { schema_version: 1; fixture_version: 1; memories: MemoryFixture[] }
const MEMORY_KEYS = ['memory_id', 'title', 'summary', 'component', 'operation', 'tags', 'aliases', 'body', 'lifecycle', 'content_sha256'] as const
const CATALOG_KEYS = ['schema_version', 'fixture_version', 'memories'] as const

export function validateMemoryFixture(value: unknown): MemoryFixture {
  assertObject(value); assertExactKeys(value, MEMORY_KEYS); id(value.memory_id, MEMORY_ID)
  assertSafeText(value.title, 120); assertSafeText(value.summary, 1000); if (typeof value.component !== 'string' || !CONTROLLED_ID.test(value.component) || typeof value.operation !== 'string' || !CONTROLLED_ID.test(value.operation)) throw new ProtocolValidationError()
  const tags = list(value.tags, 16); const aliases = textList(value.aliases, 16, 200); assertSafeText(value.body, 8000); assertEnum(value.lifecycle, LIFECYCLES); assertHash(value.content_sha256)
  const normalized = { memory_id: value.memory_id, title: value.title, summary: value.summary, component: value.component, operation: value.operation, tags, aliases, body: value.body, lifecycle: value.lifecycle as MemoryFixture['lifecycle'] }
  assertHashField(value.content_sha256, canonicalHash(normalized))
  return { ...normalized, content_sha256: value.content_sha256 }
}

export function validateMemoryCatalog(value: unknown): MemoryCatalog {
  assertObject(value); assertExactKeys(value, CATALOG_KEYS); assertInteger(value.schema_version, 1, 1); assertInteger(value.fixture_version, 1, 1); assertArray(value.memories, 128)
  const memories = (value.memories as unknown[]).map(validateMemoryFixture); const ids = memories.map((memory) => memory.memory_id); assertNoDuplicate(ids)
  if (memories.length === 0) throw new ProtocolValidationError()
  return { schema_version: 1, fixture_version: 1, memories: [...memories].sort((a, b) => compareCodePoints(a.memory_id, b.memory_id)) }
}

export interface RetrievalCase { case_id: string; difficulty: (typeof DIFFICULTIES)[number]; query: string; component_hint: string | null; operation_hint: string | null; expected_memory_ids: string[]; forbidden_memory_ids: string[] }
export interface RetrievalCases { schema_version: 1; fixture_version: 1; cases: RetrievalCase[] }
const CASE_KEYS = ['case_id', 'difficulty', 'query', 'component_hint', 'operation_hint', 'expected_memory_ids', 'forbidden_memory_ids'] as const
const CASES_KEYS = ['schema_version', 'fixture_version', 'cases'] as const

function validateRetrievalCase(value: unknown): RetrievalCase {
  assertObject(value); assertExactKeys(value, CASE_KEYS); id(value.case_id, RETRIEVAL_ID); assertEnum(value.difficulty, DIFFICULTIES); assertSafeText(value.query, 500)
  for (const hint of ['component_hint', 'operation_hint'] as const) if (value[hint] !== null && (typeof value[hint] !== 'string' || !CONTROLLED_ID.test(value[hint]))) throw new ProtocolValidationError()
  const expected = list(value.expected_memory_ids, 32, MEMORY_ID); const forbidden = list(value.forbidden_memory_ids, 32, MEMORY_ID)
  if (expected.some((memoryId) => forbidden.includes(memoryId))) throw new ProtocolValidationError()
  if (value.difficulty === 'negative_control' && expected.length !== 0) throw new ProtocolValidationError()
  if (value.difficulty !== 'negative_control' && expected.length === 0) throw new ProtocolValidationError()
  return { case_id: value.case_id, difficulty: value.difficulty as RetrievalCase['difficulty'], query: value.query, component_hint: value.component_hint as string | null, operation_hint: value.operation_hint as string | null, expected_memory_ids: expected, forbidden_memory_ids: forbidden }
}

export function validateRetrievalCases(value: unknown): RetrievalCases {
  assertObject(value); assertExactKeys(value, CASES_KEYS); assertInteger(value.schema_version, 1, 1); assertInteger(value.fixture_version, 1, 1); assertArray(value.cases, 128)
  const cases = (value.cases as unknown[]).map(validateRetrievalCase); assertNoDuplicate(cases.map((item) => item.case_id)); if (cases.length < 15) throw new ProtocolValidationError()
  for (const difficulty of ['rephrase', 'alias', 'cross_component'] as const) if (cases.filter((item) => item.difficulty === difficulty).length < 4) throw new ProtocolValidationError()
  return { schema_version: 1, fixture_version: 1, cases: [...cases].sort((a, b) => compareCodePoints(a.case_id, b.case_id)) }
}

export type SuccessAssertion =
  | { assertion_id: string; kind: 'exit_code'; expected: number }
  | { assertion_id: string; kind: 'result_equals'; field: string; expected: string | number | boolean | null }
export interface PairedTask { task_id: string; task_family: string; prompt: string; required_memory_ids: string[]; forbidden_memory_ids: string[]; success_assertions: SuccessAssertion[]; max_steps: number }
export interface PairedTasks { schema_version: 1; fixture_version: 1; tasks: PairedTask[] }
const TASK_KEYS = ['task_id', 'task_family', 'prompt', 'required_memory_ids', 'forbidden_memory_ids', 'success_assertions', 'max_steps'] as const
const TASKS_KEYS = ['schema_version', 'fixture_version', 'tasks'] as const
const EXIT_ASSERTION_KEYS = ['assertion_id', 'kind', 'expected'] as const
const RESULT_ASSERTION_KEYS = ['assertion_id', 'kind', 'field', 'expected'] as const

function assertJsonScalar(value: unknown): asserts value is string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') { assertSafeText(value, 300); return }
  if (typeof value === 'number' && Number.isFinite(value) && (value === 0 || (Math.abs(value) < 1e21 && Math.abs(value) >= 1e-6))) return
  throw new ProtocolValidationError()
}

function validateSuccessAssertion(value: unknown): SuccessAssertion {
  assertObject(value); assertEnum(value.kind, ['exit_code', 'result_equals']); assertId(value.assertion_id, 'assert_')
  if (value.kind === 'exit_code') {
    assertExactKeys(value, EXIT_ASSERTION_KEYS); assertInteger(value.expected, 0, 255)
    return { assertion_id: value.assertion_id, kind: 'exit_code', expected: value.expected }
  }
  assertExactKeys(value, RESULT_ASSERTION_KEYS); if (typeof value.field !== 'string' || !CONTROLLED_ID.test(value.field)) throw new ProtocolValidationError(); assertJsonScalar(value.expected)
  return { assertion_id: value.assertion_id, kind: 'result_equals', field: value.field, expected: value.expected }
}

function validateTask(value: unknown): PairedTask {
  assertObject(value); assertExactKeys(value, TASK_KEYS); id(value.task_id, TASK_ID); if (typeof value.task_family !== 'string' || !CONTROLLED_ID.test(value.task_family)) throw new ProtocolValidationError(); assertSafeText(value.prompt, 1000)
  const required = list(value.required_memory_ids, 32, MEMORY_ID); const forbidden = list(value.forbidden_memory_ids, 32, MEMORY_ID); if (required.some((item) => forbidden.includes(item))) throw new ProtocolValidationError()
  assertArray(value.success_assertions, 16); const assertions = (value.success_assertions as unknown[]).map(validateSuccessAssertion); assertNoDuplicate(assertions.map((item) => item.assertion_id)); if (!assertions.length) throw new ProtocolValidationError(); assertInteger(value.max_steps, 1, 100)
  assertions.sort((left, right) => compareCodePoints(left.assertion_id, right.assertion_id))
  return { task_id: value.task_id, task_family: value.task_family, prompt: value.prompt, required_memory_ids: required, forbidden_memory_ids: forbidden, success_assertions: assertions, max_steps: value.max_steps }
}

export function validatePairedTasks(value: unknown): PairedTasks {
  assertObject(value); assertExactKeys(value, TASKS_KEYS); assertInteger(value.schema_version, 1, 1); assertInteger(value.fixture_version, 1, 1); assertArray(value.tasks, 64)
  const tasks = (value.tasks as unknown[]).map(validateTask); assertNoDuplicate(tasks.map((item) => item.task_id)); if (tasks.length < 6 || new Set(tasks.map((item) => item.task_family)).size < 3) throw new ProtocolValidationError()
  return { schema_version: 1, fixture_version: 1, tasks: [...tasks].sort((a, b) => compareCodePoints(a.task_id, b.task_id)) }
}

export interface FixtureManifestEntry { relative_name: string; content_sha256: string }
export interface FixtureManifest { schema_version: 1; fixture_version: 1; files: FixtureManifestEntry[] }
const MANIFEST_KEYS = ['schema_version', 'fixture_version', 'files'] as const
const MANIFEST_ENTRY_KEYS = ['relative_name', 'content_sha256'] as const
const FIXTURE_NAMES = ['memory-catalog.json', 'paired-tasks.json', 'protocol.json', 'retrieval-cases.json'] as const

export function createFixtureManifest(protocol: EvaluationProtocol, catalog: MemoryCatalog, cases: RetrievalCases, tasks: PairedTasks): FixtureManifest {
  protocol = validateEvaluationProtocol(protocol)
  catalog = validateMemoryCatalog(catalog)
  cases = validateRetrievalCases(cases)
  tasks = validatePairedTasks(tasks)
  const manifest: FixtureManifest = { schema_version: 1, fixture_version: 1, files: [
    { relative_name: 'protocol.json', content_sha256: canonicalHash(protocol) },
    { relative_name: 'memory-catalog.json', content_sha256: canonicalHash(catalog) },
    { relative_name: 'retrieval-cases.json', content_sha256: canonicalHash(cases) },
    { relative_name: 'paired-tasks.json', content_sha256: canonicalHash(tasks) },
  ] }
  return validateFixtureManifest(manifest)
}

export function validateFixtureManifest(value: unknown): FixtureManifest {
  assertObject(value); assertExactKeys(value, MANIFEST_KEYS); assertInteger(value.schema_version, 1, 1); assertInteger(value.fixture_version, 1, 1); assertArray(value.files, 4)
  const files = (value.files as unknown[]).map((file) => { assertObject(file); assertExactKeys(file, MANIFEST_ENTRY_KEYS); assertEnum(file.relative_name, FIXTURE_NAMES); assertHash(file.content_sha256); return { relative_name: file.relative_name as string, content_sha256: file.content_sha256 as string } })
  assertNoDuplicate(files.map((file) => file.relative_name)); if (files.length !== 4 || files.some((file) => !FIXTURE_NAMES.includes(file.relative_name as (typeof FIXTURE_NAMES)[number]))) throw new ProtocolValidationError()
  return { schema_version: 1, fixture_version: 1, files: [...files].sort((a, b) => compareCodePoints(a.relative_name, b.relative_name)) }
}

export function fixtureManifestHash(manifest: FixtureManifest): string
export function fixtureManifestHash(protocol: EvaluationProtocol, catalog: MemoryCatalog, cases: RetrievalCases, tasks: PairedTasks): string
export function fixtureManifestHash(first: FixtureManifest | EvaluationProtocol, catalog?: MemoryCatalog, cases?: RetrievalCases, tasks?: PairedTasks): string {
  const manifest = catalog && cases && tasks ? createFixtureManifest(first as EvaluationProtocol, catalog, cases, tasks) : validateFixtureManifest(first as FixtureManifest)
  return canonicalHash(manifest)
}

export interface FixtureSet { protocol: EvaluationProtocol; memoryCatalog: MemoryCatalog; retrievalCases: RetrievalCases; pairedTasks: PairedTasks; manifest: FixtureManifest }

export function validateFixtureSet(value: unknown): FixtureSet {
  assertObject(value); assertExactKeys(value, ['protocol', 'memoryCatalog', 'retrievalCases', 'pairedTasks', 'manifest'])
  const protocol = validateEvaluationProtocol(value.protocol); const memoryCatalog = validateMemoryCatalog(value.memoryCatalog); const retrievalCases = validateRetrievalCases(value.retrievalCases); const pairedTasks = validatePairedTasks(value.pairedTasks); const manifest = validateFixtureManifest(value.manifest)
  const expectedFiles = createFixtureManifest(protocol, memoryCatalog, retrievalCases, pairedTasks).files
  if (manifest.files.some((file) => expectedFiles.find((expected) => expected.relative_name === file.relative_name)?.content_sha256 !== file.content_sha256)) throw new ProtocolValidationError()
  const memoryIds = new Set(memoryCatalog.memories.map((item) => item.memory_id))
  const referenced = new Set<string>(); const positiveReferenced = new Set<string>(); const forbidden = new Set<string>()
  for (const item of retrievalCases.cases) { item.expected_memory_ids.forEach((id) => { referenced.add(id); positiveReferenced.add(id) }); item.forbidden_memory_ids.forEach((id) => { referenced.add(id); forbidden.add(id) }) }
  for (const item of pairedTasks.tasks) { item.required_memory_ids.forEach((id) => { referenced.add(id); positiveReferenced.add(id) }); item.forbidden_memory_ids.forEach((id) => { referenced.add(id); forbidden.add(id) }) }
  for (const item of retrievalCases.cases) if ([...item.expected_memory_ids, ...item.forbidden_memory_ids].some((memoryId) => !memoryIds.has(memoryId))) throw new ProtocolValidationError()
  for (const item of pairedTasks.tasks) if ([...item.required_memory_ids, ...item.forbidden_memory_ids].some((memoryId) => !memoryIds.has(memoryId))) throw new ProtocolValidationError()
  for (const memory of memoryCatalog.memories) {
    if (memory.lifecycle === 'active' && !positiveReferenced.has(memory.memory_id)) throw new ProtocolValidationError()
    if ((memory.lifecycle === 'frozen' || memory.lifecycle === 'excluded') && !forbidden.has(memory.memory_id)) throw new ProtocolValidationError()
  }
  for (const item of [...retrievalCases.cases.flatMap((item) => item.expected_memory_ids), ...pairedTasks.tasks.flatMap((item) => item.required_memory_ids)]) {
    const memory = memoryCatalog.memories.find((candidate) => candidate.memory_id === item)
    if (!memory || memory.lifecycle !== 'active') throw new ProtocolValidationError()
  }
  return { protocol, memoryCatalog, retrievalCases, pairedTasks, manifest }
}

export interface RunResult {
  schema_version: 1; run_id: string; evaluation_id: string; task_id: string; group: (typeof GROUPS)[number]; requested_seed: number; seed_honored: boolean; model_provider: string; model_id: string; started_at: string; duration_ms: number; success: boolean; failure_code: string | null; retrieved_memory_ids: string[]; opened_memory_ids: string[]; adopted_memory_ids: string[]; input_tokens: number; output_tokens: number; acquisition_tokens: number; retrieval_tokens: number; retrieval_latency_ms: number; disclosure_sha256: string | null; content_sha256: string
}
const RUN_KEYS = ['schema_version', 'run_id', 'evaluation_id', 'task_id', 'group', 'requested_seed', 'seed_honored', 'model_provider', 'model_id', 'started_at', 'duration_ms', 'success', 'failure_code', 'retrieved_memory_ids', 'opened_memory_ids', 'adopted_memory_ids', 'input_tokens', 'output_tokens', 'acquisition_tokens', 'retrieval_tokens', 'retrieval_latency_ms', 'disclosure_sha256', 'content_sha256'] as const

export function validateRunResult(value: unknown, fixture: FixtureSet): RunResult {
  const checkedFixture = validateFixtureSet(fixture)
  assertObject(value); assertExactKeys(value, RUN_KEYS); assertInteger(value.schema_version, 1, 1); id(value.run_id, RUN_ID); assertEnum(value.evaluation_id, ['m05_v1']); id(value.task_id, TASK_ID); assertEnum(value.group, GROUPS); assertInteger(value.requested_seed, 0); if (typeof value.seed_honored !== 'boolean') throw new ProtocolValidationError(); assertSafeText(value.model_provider, 80); assertSafeText(value.model_id, 120); assertString(value.started_at, 64); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.started_at) || Number.isNaN(Date.parse(value.started_at))) throw new ProtocolValidationError(); const parsed = new Date(value.started_at).toISOString(); if (parsed !== value.started_at && parsed.replace('.000Z', 'Z') !== value.started_at) throw new ProtocolValidationError()
  assertInteger(value.duration_ms, 0); if (typeof value.success !== 'boolean') throw new ProtocolValidationError(); if (value.success ? value.failure_code !== null : (typeof value.failure_code !== 'string' || !CONTROLLED_ID.test(value.failure_code))) throw new ProtocolValidationError()
  const retrieved = list(value.retrieved_memory_ids, 128, MEMORY_ID); const opened = list(value.opened_memory_ids, 128, MEMORY_ID); const adopted = list(value.adopted_memory_ids, 128, MEMORY_ID)
  if (opened.some((memoryId) => !retrieved.includes(memoryId)) || adopted.some((memoryId) => !opened.includes(memoryId))) throw new ProtocolValidationError()
  if (value.group === 'no_memory' && (retrieved.length !== 0 || opened.length !== 0 || adopted.length !== 0 || value.disclosure_sha256 !== null)) throw new ProtocolValidationError()
  for (const key of ['input_tokens', 'output_tokens', 'acquisition_tokens', 'retrieval_tokens', 'retrieval_latency_ms'] as const) assertInteger(value[key], 0)
  if (value.disclosure_sha256 !== null) assertHash(value.disclosure_sha256); assertHash(value.content_sha256)
  const task = checkedFixture.pairedTasks.tasks.find((item) => item.task_id === value.task_id)
  if (!task || value.evaluation_id !== checkedFixture.protocol.evaluation_id || value.model_provider !== checkedFixture.protocol.model.provider || value.model_id !== checkedFixture.protocol.model.model || !checkedFixture.protocol.model.requested_seeds.includes(value.requested_seed) || [...retrieved, ...opened, ...adopted].some((memoryId) => !checkedFixture.memoryCatalog.memories.some((item) => item.memory_id === memoryId))) throw new ProtocolValidationError()
  const normalized: Omit<RunResult, 'content_sha256'> = { schema_version: 1, run_id: value.run_id, evaluation_id: value.evaluation_id, task_id: value.task_id, group: value.group as RunResult['group'], requested_seed: value.requested_seed as number, seed_honored: value.seed_honored, model_provider: value.model_provider, model_id: value.model_id, started_at: value.started_at, duration_ms: value.duration_ms as number, success: value.success, failure_code: value.failure_code as string | null, retrieved_memory_ids: retrieved, opened_memory_ids: opened, adopted_memory_ids: adopted, input_tokens: value.input_tokens as number, output_tokens: value.output_tokens as number, acquisition_tokens: value.acquisition_tokens as number, retrieval_tokens: value.retrieval_tokens as number, retrieval_latency_ms: value.retrieval_latency_ms as number, disclosure_sha256: value.disclosure_sha256 as string | null }
  if (canonicalHash(normalized) !== value.content_sha256) throw new ProtocolValidationError(); return { ...normalized, content_sha256: value.content_sha256 }
}

export interface SummaryReport { schema_version: 1; evaluation_id: string; fixture_manifest_sha256: string; environment: { runtime: string; plugin_version: string }; sample_counts: Record<string, number>; metrics: Record<string, number | null>; gates: Record<string, (typeof GATE_STATUSES)[number]>; run_result_hashes: string[]; recommendation: (typeof RECOMMENDATIONS)[number] }
const REPORT_KEYS = ['schema_version', 'evaluation_id', 'fixture_manifest_sha256', 'environment', 'sample_counts', 'metrics', 'gates', 'run_result_hashes', 'recommendation'] as const
const REPORT_METRIC_KEYS = ['difficult_recall_at_5', 'context_precision_at_5', 'excluded_leakage', 'replay_consistency', 'wrong_memory_adoption', 'tool_only_success_delta_points', 'non_memory_regression_points', 'overhead_token_ratio_median', 'retrieval_latency_p95_ms', 'acquisition_critical_path_blocking'] as const
const METRIC_LIMITS: Record<string, readonly [number, number]> = {
  difficult_recall_at_5: [0, 1], context_precision_at_5: [0, 1], excluded_leakage: [0, 1], replay_consistency: [0, 1], wrong_memory_adoption: [0, 1],
  tool_only_success_delta_points: [-100, 100], non_memory_regression_points: [0, 100], overhead_token_ratio_median: [0, 10], retrieval_latency_p95_ms: [0, 60_000], acquisition_critical_path_blocking: [0, 1],
}
const METRIC_THRESHOLDS: Record<string, { threshold: string; direction: 'min' | 'max' }> = {
  difficult_recall_at_5: { threshold: 'difficult_recall_at_5_min', direction: 'min' }, context_precision_at_5: { threshold: 'context_precision_at_5_min', direction: 'min' }, excluded_leakage: { threshold: 'excluded_leakage_max', direction: 'max' }, replay_consistency: { threshold: 'replay_consistency_min', direction: 'min' }, wrong_memory_adoption: { threshold: 'wrong_memory_adoption_max', direction: 'max' }, tool_only_success_delta_points: { threshold: 'tool_only_success_delta_points_min', direction: 'min' }, non_memory_regression_points: { threshold: 'non_memory_regression_points_max', direction: 'max' }, overhead_token_ratio_median: { threshold: 'overhead_token_ratio_median_max', direction: 'max' }, retrieval_latency_p95_ms: { threshold: 'retrieval_latency_p95_ms_max', direction: 'max' }, acquisition_critical_path_blocking: { threshold: 'acquisition_critical_path_blocking_max', direction: 'max' },
}
const HARD_SAFETY_GATES = new Set(['excluded_leakage', 'replay_consistency', 'wrong_memory_adoption', 'non_memory_regression_points', 'acquisition_critical_path_blocking'])

export function deriveGateStatuses(metrics: Record<string, number | null>, thresholds: Record<string, number> = THRESHOLD_VALUES): Record<string, (typeof GATE_STATUSES)[number]> {
  const result: Record<string, (typeof GATE_STATUSES)[number]> = {}
  for (const key of REPORT_METRIC_KEYS) {
    const metric = metrics[key]; if (metric === null || metric === undefined) { result[key] = 'insufficient_evidence'; continue }
    const rule = METRIC_THRESHOLDS[key]; const threshold = thresholds[rule.threshold]; result[key] = rule.direction === 'min' ? (metric >= threshold ? 'pass' : 'fail') : (metric <= threshold ? 'pass' : 'fail')
  }
  return result
}

export function deriveRecommendation(gates: Record<string, (typeof GATE_STATUSES)[number]>): (typeof RECOMMENDATIONS)[number] {
  if (REPORT_METRIC_KEYS.some((key) => gates[key] === 'insufficient_evidence')) return 'insufficient_evidence'
  if ([...HARD_SAFETY_GATES].some((key) => gates[key] === 'fail')) return 'stop'
  if (REPORT_METRIC_KEYS.some((key) => gates[key] === 'fail')) return 'adjust'
  return 'go'
}

export function validateSummaryReport(value: unknown): SummaryReport {
  assertObject(value); assertExactKeys(value, REPORT_KEYS); assertInteger(value.schema_version, 1, 1); assertEnum(value.evaluation_id, ['m05_v1']); assertHash(value.fixture_manifest_sha256)
  assertObject(value.environment); assertExactKeys(value.environment, ['runtime', 'plugin_version']); assertSafeText(value.environment.runtime, 80); assertSafeText(value.environment.plugin_version, 80)
  assertObject(value.sample_counts); const sampleCounts: Record<string, number> = {}; assertExactKeys(value.sample_counts, GROUPS); for (const [key, n] of Object.entries(value.sample_counts)) { if (!Number.isSafeInteger(n) || (n as number) < 0) throw new ProtocolValidationError(); sampleCounts[key] = n as number }
  assertObject(value.metrics); assertExactKeys(value.metrics, REPORT_METRIC_KEYS); const metrics: Record<string, number | null> = {}; for (const [key, n] of Object.entries(value.metrics)) { const limits = METRIC_LIMITS[key]; if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < limits[0] || n > limits[1])) throw new ProtocolValidationError(); metrics[key] = n as number | null }
  assertObject(value.gates); assertExactKeys(value.gates, REPORT_METRIC_KEYS); const gates: Record<string, SummaryReport['gates'][string]> = {}; for (const [key, status] of Object.entries(value.gates)) { assertEnum(status, GATE_STATUSES); gates[key] = status as SummaryReport['gates'][string] }
  const expectedGates = deriveGateStatuses(metrics); for (const key of REPORT_METRIC_KEYS) if (gates[key] !== expectedGates[key]) throw new ProtocolValidationError()
  const hashes = list(value.run_result_hashes, 2048, /^sha256_[0-9a-f]{64}$/); const sampleTotal = Object.values(sampleCounts).reduce((sum, count) => sum + count, 0); if (hashes.length !== sampleTotal) throw new ProtocolValidationError(); const recommendation = deriveRecommendation(gates); if (value.recommendation !== recommendation) throw new ProtocolValidationError()
  return { schema_version: 1, evaluation_id: 'm05_v1', fixture_manifest_sha256: value.fixture_manifest_sha256, environment: { runtime: value.environment.runtime, plugin_version: value.environment.plugin_version }, sample_counts: Object.fromEntries(Object.entries(sampleCounts).sort(([a], [b]) => compareCodePoints(a, b))), metrics: Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => compareCodePoints(a, b))), gates: Object.fromEntries(Object.entries(gates).sort(([a], [b]) => compareCodePoints(a, b))), run_result_hashes: hashes, recommendation }
}

export function encodeProtocol(value: EvaluationProtocol): string { return canonicalBytes(validateEvaluationProtocol(value)) }
export function encodeMemoryCatalog(value: MemoryCatalog): string { return canonicalBytes(validateMemoryCatalog(value)) }
export function encodeRetrievalCases(value: RetrievalCases): string { return canonicalBytes(validateRetrievalCases(value)) }
export function encodePairedTasks(value: PairedTasks): string { return canonicalBytes(validatePairedTasks(value)) }
export function encodeRunResult(value: RunResult, fixture: FixtureSet): string { return canonicalBytes(validateRunResult(value, fixture)) }
export function encodeSummaryReport(value: SummaryReport): string { return canonicalBytes(validateSummaryReport(value)) }
