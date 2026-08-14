import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalHash } from '../src/protocol/canonical.js'
import { deriveGateStatuses, deriveRecommendation, fixtureManifestHash, validateEvaluationProtocol, validateFixtureManifest, validateFixtureSet, validateMemoryCatalog, validatePairedTasks, validateRetrievalCases, validateRunResult, validateSummaryReport } from '../src/protocol/evaluation.js'

const fixtureRoot = resolve(process.cwd(), 'fixtures/m0.5/v1')
const readFixture = (name: string): unknown => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const protocol = validateEvaluationProtocol(readFixture('protocol.json'))
const fixture = validateFixtureSet({
  protocol,
  memoryCatalog: validateMemoryCatalog(readFixture('memory-catalog.json')),
  retrievalCases: validateRetrievalCases(readFixture('retrieval-cases.json')),
  pairedTasks: validatePairedTasks(readFixture('paired-tasks.json')),
  manifest: validateFixtureManifest(readFixture('fixture-manifest.json')),
})

describe('M0.5A evaluation schemas', () => {
  it('rejects threshold drift and protocol group drift', () => {
    expect(() => validateEvaluationProtocol({ ...protocol, thresholds: { ...protocol.thresholds, retrieval_latency_p95_ms_max: 1001 } })).toThrow()
    expect(() => validateEvaluationProtocol({ ...protocol, groups: ['no_memory', 'tool_only', 'tool_only'] })).toThrow()
  })
  it('requires the fixed fixture dimensions and prevents active/frozen leakage', () => {
    const retrieval = readFixture('retrieval-cases.json') as { cases: unknown[] }; const tasks = readFixture('paired-tasks.json') as { tasks: unknown[] }
    expect(() => validateRetrievalCases({ schema_version: 1, fixture_version: 1, cases: retrieval.cases.slice(0, 1) })).toThrow()
    expect(() => validatePairedTasks({ schema_version: 1, fixture_version: 1, tasks: tasks.tasks.slice(0, 2) })).toThrow()
  })
  it('requires executable structured success assertions', () => {
    const tasks = readFixture('paired-tasks.json') as { tasks: Array<Record<string, unknown>> }
    const valid = tasks.tasks
    expect(() => validatePairedTasks({ schema_version: 1, fixture_version: 1, tasks: valid.map((task) => ({ ...task, success_assertions: ['exit code is zero'] })) })).toThrow()
    expect(() => validatePairedTasks({ schema_version: 1, fixture_version: 1, tasks: valid.map((task) => ({ ...task, success_assertions: [{ assertion_id: 'assert_bad', kind: 'exit_code', expected: 0, field: 'unexpected' }] })) })).toThrow()
    expect(() => validatePairedTasks({ schema_version: 1, fixture_version: 1, tasks: valid.map((task) => ({ ...task, success_assertions: [{ assertion_id: 'assert_same', kind: 'exit_code', expected: 0 }, { assertion_id: 'assert_same', kind: 'exit_code', expected: 0 }] })) })).toThrow()
  })
  it('validates immutable manifest and rejects drift', () => {
    const manifest = validateFixtureManifest(readFixture('fixture-manifest.json'))
    expect(validateFixtureManifest(manifest)).toEqual(manifest); expect(fixtureManifestHash(manifest)).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(() => validateFixtureManifest({ ...manifest, files: [...manifest.files, manifest.files[0]] })).toThrow()
  })
})

describe('M0.5A result/report privacy and identity', () => {
  it('rejects result prompt/path leakage and unknown fixture identity', () => {
    expect(() => validateRunResult({ schema_version: 1, run_id: 'run_1', evaluation_id: 'm05_v1', task_id: 'task_build_recovery', group: 'auto_inject', requested_seed: 101, seed_honored: true, model_provider: 'deepseek-official', model_id: 'deepseek-v4-flash', started_at: '2026-01-01T00:00:00Z', duration_ms: 1, success: true, failure_code: null, retrieved_memory_ids: [], opened_memory_ids: [], adopted_memory_ids: [], input_tokens: 1, output_tokens: 1, acquisition_tokens: 0, retrieval_tokens: 0, retrieval_latency_ms: 1, disclosure_sha256: null, content_sha256: 'sha256_' + '0'.repeat(64), prompt: '/Users/czy/private' } as never, fixture)).toThrow()
  })

  it('requires exact metric and gate key sets', () => {
    const base = { schema_version: 1, evaluation_id: 'm05_v1', fixture_manifest_sha256: 'sha256_' + '0'.repeat(64), environment: { runtime: 'node', plugin_version: '0.0.0-dev' }, sample_counts: { no_memory: 0, tool_only: 0, auto_inject: 0 }, metrics: {}, gates: {}, run_result_hashes: [], recommendation: 'insufficient_evidence' }
    expect(() => validateSummaryReport(base as never)).toThrow()
  })

  it('enforces run result relationships and the no-memory privacy boundary', () => {
    const body = { schema_version: 1 as const, run_id: 'run_1', evaluation_id: 'm05_v1', task_id: 'task_build_recovery', group: 'auto_inject' as const, requested_seed: 101, seed_honored: true, model_provider: 'deepseek-official', model_id: 'deepseek-v4-flash', started_at: '2026-01-01T00:00:00Z', duration_ms: 1, success: true, failure_code: null, retrieved_memory_ids: ['memory_build_cache'], opened_memory_ids: ['memory_build_cache'], adopted_memory_ids: [], input_tokens: 1, output_tokens: 1, acquisition_tokens: 0, retrieval_tokens: 0, retrieval_latency_ms: 1, disclosure_sha256: null }
    const valid = { ...body, content_sha256: canonicalHash(body) }
    expect(validateRunResult(valid, fixture)).toMatchObject(body)
    expect(() => validateRunResult({ ...valid, success: false }, fixture)).toThrow()
    expect(() => validateRunResult({ ...valid, opened_memory_ids: [], adopted_memory_ids: ['memory_build_cache'], content_sha256: canonicalHash({ ...body, opened_memory_ids: [], adopted_memory_ids: ['memory_build_cache'] }) }, fixture)).toThrow()
    expect(() => validateRunResult({ ...valid, group: 'no_memory', retrieved_memory_ids: ['memory_build_cache'], content_sha256: canonicalHash({ ...body, group: 'no_memory', retrieved_memory_ids: ['memory_build_cache'] }) }, fixture)).toThrow()
    expect(() => validateRunResult({ ...valid, started_at: '2026-02-30T00:00:00Z' }, fixture)).toThrow()
  })

  it('requires fixture-known task and memory references', () => {
    const body = { schema_version: 1 as const, run_id: 'run_2', evaluation_id: 'm05_v1', task_id: 'task_build_recovery', group: 'auto_inject' as const, requested_seed: 101, seed_honored: true, model_provider: 'deepseek-official', model_id: 'deepseek-v4-flash', started_at: '2026-01-01T00:00:00Z', duration_ms: 1, success: true, failure_code: null, retrieved_memory_ids: ['memory_build_cache'], opened_memory_ids: ['memory_build_cache'], adopted_memory_ids: [], input_tokens: 1, output_tokens: 1, acquisition_tokens: 0, retrieval_tokens: 0, retrieval_latency_ms: 1, disclosure_sha256: null }
    const valid = { ...body, content_sha256: canonicalHash(body) }
    expect(() => validateRunResult({ ...valid, task_id: 'task_unknown', content_sha256: canonicalHash({ ...body, task_id: 'task_unknown' }) }, fixture)).toThrow()
    expect(() => validateRunResult({ ...valid, retrieved_memory_ids: ['memory_unknown'], opened_memory_ids: ['memory_unknown'], content_sha256: canonicalHash({ ...body, retrieved_memory_ids: ['memory_unknown'], opened_memory_ids: ['memory_unknown'] }) }, fixture)).toThrow()
    expect(() => validateRunResult(valid, { ...fixture, manifest: { ...fixture.manifest, files: [] } } as never)).toThrow()
  })

  it('derives report gates and recommendation deterministically', () => {
    const metrics = { difficult_recall_at_5: 0.8, context_precision_at_5: 0.7, excluded_leakage: 0, replay_consistency: 1, wrong_memory_adoption: 0, tool_only_success_delta_points: 10, non_memory_regression_points: 0, overhead_token_ratio_median: 0.15, retrieval_latency_p95_ms: 1000, acquisition_critical_path_blocking: 0 }
    const gates = deriveGateStatuses(metrics); expect(deriveRecommendation(gates)).toBe('go')
    expect(deriveRecommendation({ ...gates, excluded_leakage: 'fail' })).toBe('stop')
    expect(deriveRecommendation({ ...gates, context_precision_at_5: 'fail' })).toBe('adjust')
    expect(deriveRecommendation({ ...gates, context_precision_at_5: 'insufficient_evidence' })).toBe('insufficient_evidence')
    const hashes = ['sha256_' + '1'.repeat(64), 'sha256_' + '2'.repeat(64), 'sha256_' + '3'.repeat(64)]
    expect(validateSummaryReport({ schema_version: 1, evaluation_id: 'm05_v1', fixture_manifest_sha256: 'sha256_' + '0'.repeat(64), environment: { runtime: 'node', plugin_version: '0.0.0-dev' }, sample_counts: { no_memory: 1, tool_only: 1, auto_inject: 1 }, metrics, gates, run_result_hashes: hashes, recommendation: 'go' })).toBeTruthy()
    expect(() => validateSummaryReport({ schema_version: 1, evaluation_id: 'm05_v1', fixture_manifest_sha256: 'sha256_' + '0'.repeat(64), environment: { runtime: 'node', plugin_version: '0.0.0-dev' }, sample_counts: { no_memory: 1, tool_only: 1, auto_inject: 1 }, metrics: { ...metrics, context_precision_at_5: null }, gates, run_result_hashes: hashes, recommendation: 'go' })).toThrow()
    const negativeDelta = { ...metrics, tool_only_success_delta_points: -10 }
    const negativeGates = deriveGateStatuses(negativeDelta)
    expect(negativeGates.tool_only_success_delta_points).toBe('fail')
    expect(deriveRecommendation(negativeGates)).toBe('adjust')
    expect(validateSummaryReport({ schema_version: 1, evaluation_id: 'm05_v1', fixture_manifest_sha256: 'sha256_' + '0'.repeat(64), environment: { runtime: 'node', plugin_version: '0.0.0-dev' }, sample_counts: { no_memory: 1, tool_only: 1, auto_inject: 1 }, metrics: negativeDelta, gates: negativeGates, run_result_hashes: hashes, recommendation: 'adjust' })).toBeTruthy()
  })
})
