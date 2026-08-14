import { describe, expect, it } from 'vitest'
import { createCandidate, createSkipDecision } from '../src/protocol/acquisition.js'
import { createFixtureRuntime } from '../src/retrieval/runtime.js'

function candidate(title = 'Preserve targeted compiler cache', sourceEventId = 'event_m05b_registry'): ReturnType<typeof createCandidate> {
  return createCandidate({
    source_event_id: sourceEventId,
    source_kind: 'checkpoint',
    scope_id: 'scope_fixture',
    task_fingerprint: 'sha256_' + '1'.repeat(64),
    component: 'compiler',
    operation: 'build',
    title,
    summary: 'Keep the cache and run the smallest affected target first.',
    applies_when: ['compiler configuration changed'],
    failure_boundaries: ['do not infer success from a cache hit'],
    tags: ['build', 'cache'],
    aliases: ['targeted cache rebuild'],
  })
}

describe('M0.5B acquisition registry seam', () => {
  it('records eligible, exact skip, noop, conflict, and duplicate decisions', () => {
    const runtime = createFixtureRuntime()
    const first = candidate()
    expect(runtime.recordCandidate(first, createSkipDecision({ candidate_id: first.candidate_id, decision: 'eligible', basis_ids: ['basis_first'] })).status).toBe('created')
    expect(runtime.recordCandidate(first, createSkipDecision({ candidate_id: first.candidate_id, decision: 'eligible', basis_ids: ['basis_first'] })).status).toBe('noop')
    expect(runtime.recordCandidate(first, createSkipDecision({ candidate_id: first.candidate_id, decision: 'skip_exact_content', basis_ids: ['basis_skip'] })).status).toBe('skipped')

    const duplicate = candidate('Preserve targeted compiler cache (duplicate candidate)', 'event_m05b_registry_duplicate')
    expect(runtime.recordCandidate(duplicate, createSkipDecision({ candidate_id: duplicate.candidate_id, decision: 'duplicate_candidate', basis_ids: ['basis_duplicate'] })).status).toBe('created')
    expect(runtime.acquisitionAudit().overlaps[duplicate.candidate_id]).toEqual(['basis_duplicate'])
  })

  it('rejects mismatched identities and clears only the instance registry', () => {
    const runtime = createFixtureRuntime()
    const first = candidate()
    const skip = createSkipDecision({ candidate_id: first.candidate_id, decision: 'eligible', basis_ids: ['basis_first'] })
    expect(() => runtime.recordCandidate(first, { ...skip, candidate_id: 'candidate_' + '0'.repeat(16) })).toThrow()
    expect(runtime.recordCandidate(first, skip).status).toBe('created')
    const different = candidate('A different candidate from the same event')
    const beforeConflict = runtime.acquisitionAudit()
    expect(() => runtime.recordCandidate(different, createSkipDecision({ candidate_id: different.candidate_id, decision: 'eligible', basis_ids: ['basis_conflict'] }))).toThrow()
    expect(runtime.acquisitionAudit()).toEqual(beforeConflict)
    runtime.clear()
    expect(runtime.recordCandidate(first, skip).status).toBe('created')
  })

  it('serializes overlap audit keys independently of insertion order', () => {
    const first = candidate('Overlap candidate A', 'event_overlap_a')
    const second = candidate('Overlap candidate B', 'event_overlap_b')
    const record = (runtime: ReturnType<typeof createFixtureRuntime>, items: [typeof first, typeof second]) => {
      for (const item of items) runtime.recordCandidate(item, createSkipDecision({ candidate_id: item.candidate_id, decision: 'duplicate_candidate', basis_ids: ['basis_z', 'basis_a'] }))
    }
    const left = createFixtureRuntime(); const right = createFixtureRuntime()
    record(left, [first, second]); record(right, [second, first])
    expect(JSON.stringify(left.acquisitionAudit())).toBe(JSON.stringify(right.acquisitionAudit()))
  })
})
