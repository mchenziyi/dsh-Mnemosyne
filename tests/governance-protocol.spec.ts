import { describe, expect, it } from 'vitest'
import { ProtocolValidationError } from '../src/protocol/canonical.js'
import {
  canonicalizeGovernanceEventV1,
  compareGovernanceEventRefsV1,
  compareGovernanceEvidenceRefsV1,
  compareGovernanceMemoryRefsV1,
  computeGovernanceEventHashV1,
  computeGovernanceEventIdV1,
  createGovernanceEventV1,
  validateGovernanceEventReferencesV1,
  validateGovernanceEventV1,
  validateGovernanceEvidenceRefV1,
  validateGovernanceEventRefV1,
  validateGovernanceMemoryRefV1,
  type GovernanceEventDraftV1,
  type GovernanceEventV1,
  type GovernanceMemoryRecordV1,
  type GovernanceReferenceContextV1,
} from '../src/protocol/governance.js'

const PROJECT_A = `sha256_${'a'.repeat(64)}`
const PROJECT_B = `sha256_${'b'.repeat(64)}`
const HASH_1 = `sha256_${'1'.repeat(64)}`
const HASH_2 = `sha256_${'2'.repeat(64)}`
const HASH_3 = `sha256_${'3'.repeat(64)}`
const HASH_4 = `sha256_${'4'.repeat(64)}`
const CREATED_AT = '2026-09-10T08:00:00.000Z'

const MEMORY_A = { memory_id: 'mem_a', content_sha256: HASH_1 }
const MEMORY_B = { memory_id: 'mem_b', content_sha256: HASH_2 }
const MEMORY_C = { memory_id: 'mem_c', content_sha256: HASH_3 }

const RAW_MEMORIES: GovernanceMemoryRecordV1[] = [
  { ...MEMORY_A, project_scope_id: PROJECT_A },
  { ...MEMORY_B, project_scope_id: PROJECT_A },
  { ...MEMORY_C, project_scope_id: PROJECT_A },
]

function draft(
  payload: GovernanceEventDraftV1['payload'],
  overrides: Partial<Omit<GovernanceEventDraftV1, 'payload'>> = {},
): GovernanceEventDraftV1 {
  return {
    schema_version: 1,
    project_scope_id: PROJECT_A,
    sequence: 1,
    prev_event_hash: null,
    payload,
    evidence_refs: [{ kind: 'memory', ...MEMORY_A }],
    reason_code: 'governance_test',
    created_at: CREATED_AT,
    ...overrides,
  }
}

function context(
  currentHead: GovernanceReferenceContextV1['current_head'],
  events: GovernanceEventV1[] = [],
  memories: GovernanceMemoryRecordV1[] = RAW_MEMORIES,
): GovernanceReferenceContextV1 {
  return {
    project_scope_id: PROJECT_A,
    current_head: currentHead,
    memories,
    committed_events: events,
  }
}

function head(event: GovernanceEventV1) {
  return {
    sequence: event.sequence,
    event_id: event.event_id,
    event_sha256: event.event_sha256,
  }
}

describe('Governance Foundation Slice 1 protocol', () => {
  it('creates, validates, and canonically encodes all six payload variants', () => {
    const conflict = createGovernanceEventV1(draft({
      action: 'add_conflict',
      first: MEMORY_A,
      second: MEMORY_B,
    }))
    const deactivate = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))

    const cases: GovernanceEventDraftV1[] = [
      draft({ action: 'supersede', replacement: MEMORY_B, replaced: MEMORY_A }),
      draft({ action: 'add_conflict', first: MEMORY_A, second: MEMORY_B }),
      draft({
        action: 'resolve_conflict',
        conflict_event: { event_id: conflict.event_id, event_sha256: conflict.event_sha256 },
        resolution: { kind: 'dismiss' },
      }),
      draft({ action: 'deactivate', memory: MEMORY_A }),
      draft({
        action: 'reactivate',
        memory: MEMORY_A,
        deactivate_event: { event_id: deactivate.event_id, event_sha256: deactivate.event_sha256 },
      }),
      draft({
        action: 'revert',
        target_event: { event_id: deactivate.event_id, event_sha256: deactivate.event_sha256 },
      }),
    ]

    for (const item of cases) {
      const event = createGovernanceEventV1(item)
      expect(event.event_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
      expect(event.event_id).toBe(`gov_${event.event_sha256.slice('sha256_'.length)}`)
      expect(validateGovernanceEventV1(event)).toEqual(event)
      expect(JSON.parse(canonicalizeGovernanceEventV1(event))).toEqual(event)
    }
  })

  it('validates every strong payload branch, including conflict resolutions', () => {
    const conflictEvent = createGovernanceEventV1(draft({ action: 'add_conflict', first: MEMORY_A, second: MEMORY_B }))
    const conflictRef = { event_id: conflictEvent.event_id, event_sha256: conflictEvent.event_sha256 }

    for (const resolution of [
      { kind: 'dismiss' as const },
      { kind: 'supersede' as const, replacement: MEMORY_B, replaced: MEMORY_A },
      { kind: 'deactivate' as const, memory: MEMORY_A },
    ]) {
      expect(createGovernanceEventV1(draft({
        action: 'resolve_conflict',
        conflict_event: conflictRef,
        resolution,
      })).payload).toEqual({ action: 'resolve_conflict', conflict_event: conflictRef, resolution })
    }
  })

  it('enforces exact keys at the envelope, payload, resolution, and ref levels', () => {
    const valid = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))
    expect(() => validateGovernanceEventV1({ ...valid, extra: true })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1(draft({ action: 'deactivate', memory: { ...MEMORY_A, extra: true } } as never))).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A, extra: true } as never))).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1(draft({
      action: 'resolve_conflict',
      conflict_event: { event_id: valid.event_id, event_sha256: valid.event_sha256 },
      resolution: { kind: 'dismiss', extra: true } as never,
    }))).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), evidence_refs: [{ kind: 'memory', ...MEMORY_A, extra: true }] } as never)).toThrow(ProtocolValidationError)
  })

  it('validates Memory, Event, and Evidence refs independently', () => {
    const event = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))
    expect(validateGovernanceMemoryRefV1(MEMORY_A)).toEqual(MEMORY_A)
    expect(validateGovernanceEventRefV1({ event_id: event.event_id, event_sha256: event.event_sha256 })).toEqual({ event_id: event.event_id, event_sha256: event.event_sha256 })
    expect(validateGovernanceEvidenceRefV1({ kind: 'memory', ...MEMORY_A })).toEqual({ kind: 'memory', ...MEMORY_A })
    expect(validateGovernanceEvidenceRefV1({ kind: 'governance_event', event_id: event.event_id, event_sha256: event.event_sha256 })).toEqual({ kind: 'governance_event', event_id: event.event_id, event_sha256: event.event_sha256 })
    expect(() => validateGovernanceMemoryRefV1({ memory_id: '../mem_a', content_sha256: HASH_1 })).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventRefV1({ event_id: 'gov_bad', event_sha256: HASH_1 })).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEvidenceRefV1({ kind: 'other', ...MEMORY_A })).toThrow(ProtocolValidationError)
  })

  it('uses the frozen lexicographic full-identity comparators', () => {
    expect(compareGovernanceMemoryRefsV1(MEMORY_A, MEMORY_B)).toBeLessThan(0)
    expect(compareGovernanceMemoryRefsV1(MEMORY_A, { ...MEMORY_A, content_sha256: HASH_2 })).toBeLessThan(0)

    const eventA = { event_id: `gov_${'1'.repeat(64)}`, event_sha256: HASH_1 }
    const eventB = { event_id: `gov_${'2'.repeat(64)}`, event_sha256: HASH_2 }
    expect(compareGovernanceEventRefsV1(eventA, eventB)).toBeLessThan(0)
    expect(compareGovernanceEventRefsV1(eventA, { ...eventA, event_sha256: HASH_2 })).toBeLessThan(0)

    expect(compareGovernanceEvidenceRefsV1(
      { kind: 'governance_event', ...eventA },
      { kind: 'memory', ...MEMORY_A },
    )).toBeLessThan(0)
    expect(compareGovernanceEvidenceRefsV1(
      { kind: 'memory', ...MEMORY_A },
      { kind: 'memory', ...MEMORY_B },
    )).toBeLessThan(0)
    expect(compareGovernanceEvidenceRefsV1(
      { kind: 'governance_event', ...eventA },
      { kind: 'governance_event', ...eventB },
    )).toBeLessThan(0)
  })

  it('normalizes every unordered ref collection before hashing', () => {
    const eventRef = { event_id: `gov_${'4'.repeat(64)}`, event_sha256: HASH_4 }
    const evidence = [
      { kind: 'memory' as const, ...MEMORY_B },
      { kind: 'governance_event' as const, ...eventRef },
      { kind: 'memory' as const, ...MEMORY_A },
    ]
    const left = createGovernanceEventV1(draft(
      { action: 'add_conflict', first: MEMORY_B, second: MEMORY_A },
      { evidence_refs: evidence },
    ))
    const right = createGovernanceEventV1(draft(
      { action: 'add_conflict', first: MEMORY_A, second: MEMORY_B },
      { evidence_refs: [...evidence].reverse() },
    ))

    expect(left).toEqual(right)
    expect(left.payload).toEqual({ action: 'add_conflict', first: MEMORY_A, second: MEMORY_B })
    expect(left.evidence_refs.map((ref) => ref.kind)).toEqual(['governance_event', 'memory', 'memory'])
    expect(computeGovernanceEventHashV1(draft(
      { action: 'add_conflict', first: MEMORY_B, second: MEMORY_A },
      { evidence_refs: evidence },
    ))).toBe(right.event_sha256)

    const noncanonical = { ...left, evidence_refs: [...left.evidence_refs].reverse() }
    expect(() => validateGovernanceEventV1(noncanonical)).toThrow(ProtocolValidationError)
    const reversedConflict = { ...left, payload: { action: 'add_conflict', first: MEMORY_B, second: MEMORY_A } }
    expect(() => validateGovernanceEventV1(reversedConflict)).toThrow(ProtocolValidationError)
  })

  it('rejects duplicate refs and same-id/different-hash identity conflicts', () => {
    expect(() => createGovernanceEventV1({
      ...draft({ action: 'deactivate', memory: MEMORY_A }),
      evidence_refs: [],
    })).toThrow(ProtocolValidationError)

    expect(() => createGovernanceEventV1(draft(
      { action: 'deactivate', memory: MEMORY_A },
      { evidence_refs: [{ kind: 'memory', ...MEMORY_A }, { kind: 'memory', ...MEMORY_A }] },
    ))).toThrow(ProtocolValidationError)

    expect(() => createGovernanceEventV1(draft(
      { action: 'deactivate', memory: MEMORY_A },
      { evidence_refs: [{ kind: 'memory', memory_id: MEMORY_A.memory_id, content_sha256: HASH_2 }] },
    ))).toThrow(ProtocolValidationError)

    expect(() => createGovernanceEventV1(draft({ action: 'add_conflict', first: MEMORY_A, second: MEMORY_A }))).toThrow(ProtocolValidationError)
  })

  it('enforces sequence, parent hash, reason code, and timestamp structure', () => {
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), sequence: 0 })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), sequence: 1, prev_event_hash: HASH_1 })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), sequence: 2, prev_event_hash: null })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), reason_code: 'free form reason' })).toThrow(ProtocolValidationError)
    expect(() => createGovernanceEventV1({ ...draft({ action: 'deactivate', memory: MEMORY_A }), created_at: 'not-a-time' })).toThrow(ProtocolValidationError)
  })

  it('detects tampered event hashes and IDs', () => {
    const golden = createGovernanceEventV1(draft({ action: 'supersede', replacement: MEMORY_B, replaced: MEMORY_A }))
    expect(golden.event_sha256).toBe('sha256_a47fb5f2ed3452bbdb3ab9fac6ba2ad1467cbec0f1c0b1d65ebb58a72452a852')
    expect(golden.event_id).toBe('gov_a47fb5f2ed3452bbdb3ab9fac6ba2ad1467cbec0f1c0b1d65ebb58a72452a852')

    const event = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))
    expect(computeGovernanceEventIdV1(event.event_sha256)).toBe(event.event_id)
    expect(() => validateGovernanceEventV1({ ...event, event_sha256: HASH_4 })).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventV1({ ...event, event_id: `gov_${'4'.repeat(64)}` })).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventV1({ ...event, payload: { action: 'deactivate', memory: MEMORY_B } })).toThrow(ProtocolValidationError)
  })

  it('validates genesis refs and rejects unknown, mismatched, cross-project, or orphan refs', () => {
    const event = createGovernanceEventV1(draft({ action: 'supersede', replacement: MEMORY_B, replaced: MEMORY_A }))
    expect(validateGovernanceEventReferencesV1(event, context(null))).toEqual(event)

    expect(() => validateGovernanceEventReferencesV1(event, context(null, [], RAW_MEMORIES.slice(0, 1)))).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventReferencesV1(event, context(null, [], [
      RAW_MEMORIES[0],
      { ...RAW_MEMORIES[1], content_sha256: HASH_4 },
    ]))).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventReferencesV1(event, context(null, [], [
      RAW_MEMORIES[0],
      { ...RAW_MEMORIES[1], project_scope_id: PROJECT_B },
    ]))).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventReferencesV1(event, { ...context(null), project_scope_id: PROJECT_B })).toThrow(ProtocolValidationError)

    const orphanRef = { event_id: `gov_${'4'.repeat(64)}`, event_sha256: HASH_4 }
    const withOrphanEvidence = createGovernanceEventV1(draft(
      { action: 'deactivate', memory: MEMORY_A },
      { evidence_refs: [{ kind: 'governance_event', ...orphanRef }] },
    ))
    expect(() => validateGovernanceEventReferencesV1(withOrphanEvidence, context(null))).toThrow(ProtocolValidationError)

    const foreignParent = createGovernanceEventV1({
      ...draft({ action: 'deactivate', memory: MEMORY_A }),
      project_scope_id: PROJECT_B,
    })
    const foreignRef = { event_id: foreignParent.event_id, event_sha256: foreignParent.event_sha256 }
    const crossProjectEventRef = createGovernanceEventV1(draft(
      { action: 'revert', target_event: foreignRef },
      { sequence: 2, prev_event_hash: foreignParent.event_sha256 },
    ))
    expect(() => validateGovernanceEventReferencesV1(crossProjectEventRef, context(head(foreignParent), [foreignParent]))).toThrow(ProtocolValidationError)
  })

  it('requires a non-genesis event to be the current committed head direct child', () => {
    const parent = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))
    const child = createGovernanceEventV1(draft(
      { action: 'reactivate', memory: MEMORY_A, deactivate_event: { event_id: parent.event_id, event_sha256: parent.event_sha256 } },
      {
        sequence: 2,
        prev_event_hash: parent.event_sha256,
        evidence_refs: [{ kind: 'governance_event', event_id: parent.event_id, event_sha256: parent.event_sha256 }],
      },
    ))

    expect(validateGovernanceEventReferencesV1(child, context(head(parent), [parent]))).toEqual(child)
    expect(() => validateGovernanceEventReferencesV1(child, context(null, [parent]))).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventReferencesV1(child, context({ ...head(parent), event_sha256: HASH_4 }, [parent]))).toThrow(ProtocolValidationError)
    expect(() => validateGovernanceEventReferencesV1({ ...child, sequence: 3 }, context(head(parent), [parent]))).toThrow(ProtocolValidationError)

    const nonEarlier = createGovernanceEventV1(draft(
      { action: 'deactivate', memory: MEMORY_B },
      { sequence: 2, prev_event_hash: HASH_4 },
    ))
    const futureEvidence = createGovernanceEventV1(draft(
      { action: 'reactivate', memory: MEMORY_A, deactivate_event: { event_id: parent.event_id, event_sha256: parent.event_sha256 } },
      {
        sequence: 2,
        prev_event_hash: parent.event_sha256,
        evidence_refs: [{ kind: 'governance_event', event_id: nonEarlier.event_id, event_sha256: nonEarlier.event_sha256 }],
      },
    ))
    expect(() => validateGovernanceEventReferencesV1(futureEvidence, context(head(parent), [parent, nonEarlier]))).toThrow(ProtocolValidationError)
  })

  it('checks typed target refs without implementing Replay state', () => {
    const conflict = createGovernanceEventV1(draft({ action: 'add_conflict', first: MEMORY_A, second: MEMORY_B }))
    const conflictRef = { event_id: conflict.event_id, event_sha256: conflict.event_sha256 }
    const resolve = createGovernanceEventV1(draft(
      {
        action: 'resolve_conflict',
        conflict_event: conflictRef,
        resolution: { kind: 'supersede', replacement: MEMORY_B, replaced: MEMORY_A },
      },
      { sequence: 2, prev_event_hash: conflict.event_sha256, evidence_refs: [{ kind: 'governance_event', ...conflictRef }] },
    ))
    expect(validateGovernanceEventReferencesV1(resolve, context(head(conflict), [conflict]))).toEqual(resolve)

    const wrongPair = createGovernanceEventV1(draft(
      {
        action: 'resolve_conflict',
        conflict_event: conflictRef,
        resolution: { kind: 'deactivate', memory: MEMORY_C },
      },
      { sequence: 2, prev_event_hash: conflict.event_sha256, evidence_refs: [{ kind: 'governance_event', ...conflictRef }] },
    ))
    expect(() => validateGovernanceEventReferencesV1(wrongPair, context(head(conflict), [conflict]))).toThrow(ProtocolValidationError)

    const deactivate = createGovernanceEventV1(draft({ action: 'deactivate', memory: MEMORY_A }))
    const invalidReactivation = createGovernanceEventV1(draft(
      {
        action: 'reactivate',
        memory: MEMORY_B,
        deactivate_event: { event_id: deactivate.event_id, event_sha256: deactivate.event_sha256 },
      },
      { sequence: 2, prev_event_hash: deactivate.event_sha256 },
    ))
    expect(() => validateGovernanceEventReferencesV1(invalidReactivation, context(head(deactivate), [deactivate]))).toThrow(ProtocolValidationError)

    const revert = createGovernanceEventV1(draft(
      { action: 'revert', target_event: { event_id: deactivate.event_id, event_sha256: deactivate.event_sha256 } },
      { sequence: 2, prev_event_hash: deactivate.event_sha256 },
    ))
    const revertOfRevert = createGovernanceEventV1(draft(
      { action: 'revert', target_event: { event_id: revert.event_id, event_sha256: revert.event_sha256 } },
      { sequence: 3, prev_event_hash: revert.event_sha256, evidence_refs: [{ kind: 'governance_event', event_id: revert.event_id, event_sha256: revert.event_sha256 }] },
    ))
    expect(() => validateGovernanceEventReferencesV1(revertOfRevert, context(head(revert), [deactivate, revert]))).toThrow(ProtocolValidationError)

    const wrongConflictTarget = createGovernanceEventV1(draft(
      {
        action: 'resolve_conflict',
        conflict_event: { event_id: deactivate.event_id, event_sha256: deactivate.event_sha256 },
        resolution: { kind: 'dismiss' },
      },
      { sequence: 2, prev_event_hash: deactivate.event_sha256 },
    ))
    expect(() => validateGovernanceEventReferencesV1(wrongConflictTarget, context(head(deactivate), [deactivate]))).toThrow(ProtocolValidationError)
  })
})
