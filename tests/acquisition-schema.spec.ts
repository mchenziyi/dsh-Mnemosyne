import { describe, expect, it } from 'vitest'
import { createCandidate, createSkipDecision, encodeCandidate, type AcquisitionCandidate, validateCandidate, validateSkipDecision, skipBlocksAcquisition } from '../src/protocol/acquisition.js'

const candidate = () => createCandidate({
  source_event_id: 'event_build_1', source_kind: 'task_completed', scope_id: 'scope_fixture', task_fingerprint: `sha256_${'1'.repeat(64)}`,
  component: 'compiler', operation: 'build', title: 'Build cache repair', summary: 'Use the smallest targeted build after changing compiler configuration.',
  applies_when: ['compiler configuration changed'], failure_boundaries: ['does not apply to dependency outages'], tags: ['build', 'cache'], aliases: ['cache repair'],
})

describe('M0.5A acquisition schema', () => {
  it('constructs a self-consistent candidate and changes content identity with payload', () => {
    const value = candidate(); expect(validateCandidate(value)).toEqual(value); expect(encodeCandidate(value)).toContain(value.content_sha256)
    const changed = createCandidate({ source_event_id: value.source_event_id, source_kind: value.source_kind, scope_id: value.scope_id, task_fingerprint: value.task_fingerprint, component: value.component, operation: value.operation, title: value.title, summary: 'Use the smallest safe build after changing compiler configuration.', applies_when: value.applies_when, failure_boundaries: value.failure_boundaries, tags: value.tags, aliases: value.aliases })
    expect(changed.content_sha256).not.toBe(value.content_sha256)
    expect(changed.candidate_id).not.toBe(value.candidate_id)
    expect(() => validateCandidate({ ...value, summary: 'Use the smallest safe build after changing compiler configuration.' })).toThrow()
  })

  it('rejects unknown fields, duplicate sets, empty text, and sensitive text in every free-text list', () => {
    const value = candidate()
    expect(() => validateCandidate({ ...value, extra: true })).toThrow()
    expect(() => validateCandidate({ ...value, tags: ['build', 'build'] })).toThrow()
    expect(() => validateCandidate({ ...value, aliases: ['Bearer abcdefghijkl'] })).toThrow()
    expect(() => validateCandidate({ ...value, applies_when: ['/Users/czy/project'] })).toThrow()
    expect(() => validateCandidate({ ...value, failure_boundaries: ['password = abc'] })).toThrow()
    expect(() => validateCandidate({ ...value, title: '' })).toThrow()
  })

  it('keeps exact skip separate from approximate duplicate', () => {
    const value = candidate()
    const base = { candidate_id: value.candidate_id, basis_ids: ['event_build_1'] }
    const exact = createSkipDecision({ ...base, decision: 'skip_exact_event' }); const content = createSkipDecision({ ...base, decision: 'skip_exact_content' }); const duplicate = createSkipDecision({ ...base, decision: 'duplicate_candidate' })
    expect(skipBlocksAcquisition(exact)).toBe(true)
    expect(skipBlocksAcquisition(content)).toBe(true)
    expect(skipBlocksAcquisition(duplicate)).toBe(false)
    expect(() => validateSkipDecision({ ...exact, content_sha256: 'sha256_' + 'f'.repeat(64) })).toThrow()
    expect(() => validateSkipDecision({ ...exact, decision: 'eligible', basis_ids: [] })).toThrow()
  })
})
