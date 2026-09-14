import { describe, expect, it } from 'vitest'
import { ProtocolValidationError } from '../src/protocol/canonical.js'
import { compareGovernanceEventRefsV1, createGovernanceEventV1, type GovernanceEventPayloadV1, type GovernanceEventV1, type GovernanceMemoryRecordV1 } from '../src/protocol/governance.js'
import { replayGovernanceV1, type EffectiveMemoryV1 } from '../src/governance/replay.js'

const PROJECT = `sha256_${'a'.repeat(64)}`
const HASH_A = `sha256_${'1'.repeat(64)}`
const HASH_B = `sha256_${'2'.repeat(64)}`
const HASH_C = `sha256_${'3'.repeat(64)}`
const HASH_D = `sha256_${'4'.repeat(64)}`
const A = { memory_id: 'mem_a', content_sha256: HASH_A }
const B = { memory_id: 'mem_b', content_sha256: HASH_B }
const C = { memory_id: 'mem_c', content_sha256: HASH_C }
const D = { memory_id: 'mem_d', content_sha256: HASH_D }
const memories: GovernanceMemoryRecordV1[] = [A, B, C, D].map((ref) => ({ ...ref, project_scope_id: PROJECT }))

function ledgerBuilder() {
  const events: GovernanceEventV1[] = []
  const append = (payload: GovernanceEventPayloadV1, evidence = [{ kind: 'memory' as const, ...A }]) => {
    const previous = events.at(-1)
    const event = createGovernanceEventV1({
      schema_version: 1,
      project_scope_id: PROJECT,
      sequence: events.length + 1,
      prev_event_hash: previous?.event_sha256 ?? null,
      payload,
      evidence_refs: evidence,
      reason_code: 'replay_test',
      created_at: `2026-09-10T08:00:${String(events.length).padStart(2, '0')}.000Z`,
    })
    events.push(event)
    return event
  }
  return { events, append }
}

function replay(events: readonly GovernanceEventV1[], rawMemories = memories): EffectiveMemoryV1[] {
  return replayGovernanceV1({ project_scope_id: PROJECT, memories: rawMemories, events }).effective_memories
}

function result(result: EffectiveMemoryV1[], id: string): EffectiveMemoryV1 {
  return result.find((memory) => memory.memory_ref.memory_id === id)!
}

function ref(event: GovernanceEventV1) {
  return { event_id: event.event_id, event_sha256: event.event_sha256 }
}

function sortedRefs(events: readonly GovernanceEventV1[]) {
  return events.map(ref).sort(compareGovernanceEventRefsV1)
}

describe('Governance Replay Slice 2', () => {
  it('projects an empty ledger deterministically and does not mutate input', () => {
    const input = memories.map((memory) => ({ ...memory }))
    const before = structuredClone(input)
    const output = replay([], input)
    expect(output.map((memory) => memory.memory_ref.memory_id)).toEqual(['mem_a', 'mem_b', 'mem_c', 'mem_d'])
    expect(output.every((memory) => memory.lifecycle_status === 'active')).toBe(true)
    expect(output.every((memory) => memory.superseded_by === null && memory.inactive_by === null && memory.unresolved_conflict_refs.length === 0 && memory.governance_event_refs.length === 0)).toBe(true)
    expect(input).toEqual(before)
  })

  it('rejects out-of-order, broken, cross-project, and tampered chains', () => {
    const ledger = ledgerBuilder()
    const first = ledger.append({ action: 'deactivate', memory: A })
    const second = ledger.append({ action: 'reactivate', memory: A, deactivate_event: ref(first) })
    expect(() => replay([first, second, first])).toThrow(ProtocolValidationError)
    expect(() => replay([{ ...first, sequence: 2 }])).toThrow(ProtocolValidationError)
    expect(() => replay([{ ...first, event_sha256: HASH_D }])).toThrow(ProtocolValidationError)
    expect(() => replay([{ ...first, project_scope_id: `sha256_${'b'.repeat(64)}` }])).toThrow(ProtocolValidationError)
    expect(() => replay([first, { ...second, prev_event_hash: HASH_D }])).toThrow(ProtocolValidationError)
  })

  it('supports direct supersede chains without flattening', () => {
    const ledger = ledgerBuilder()
    ledger.append({ action: 'supersede', replacement: B, replaced: A })
    ledger.append({ action: 'supersede', replacement: C, replaced: B })
    const output = replay(ledger.events)
    expect(result(output, 'mem_a')).toMatchObject({ lifecycle_status: 'superseded', superseded_by: B })
    expect(result(output, 'mem_b')).toMatchObject({ lifecycle_status: 'superseded', superseded_by: C })
    expect(result(output, 'mem_c')).toMatchObject({ lifecycle_status: 'active', superseded_by: null })
  })

  it('rejects supersede cycles, duplicate direct replacement, and conflicted members', () => {
    const cycle = ledgerBuilder()
    cycle.append({ action: 'supersede', replacement: B, replaced: A })
    cycle.append({ action: 'supersede', replacement: A, replaced: B })
    expect(() => replay(cycle.events)).toThrow(ProtocolValidationError)

    const duplicate = ledgerBuilder()
    duplicate.append({ action: 'supersede', replacement: B, replaced: A })
    duplicate.append({ action: 'supersede', replacement: C, replaced: A })
    expect(() => replay(duplicate.events)).toThrow(ProtocolValidationError)

    const conflict = ledgerBuilder()
    conflict.append({ action: 'add_conflict', first: A, second: B })
    conflict.append({ action: 'supersede', replacement: C, replaced: A })
    expect(() => replay(conflict.events)).toThrow(ProtocolValidationError)
  })

  it('keeps conflicts active, resolves dismiss atomically, and preserves history', () => {
    const ledger = ledgerBuilder()
    const conflict = ledger.append({ action: 'add_conflict', first: B, second: A })
    const resolve = ledger.append({ action: 'resolve_conflict', conflict_event: ref(conflict), resolution: { kind: 'dismiss' } })
    const output = replay(ledger.events)
    expect(result(output, 'mem_a')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [] })
    expect(result(output, 'mem_b')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [] })
    expect(result(output, 'mem_a').governance_event_refs).toEqual([ref(conflict), ref(resolve)])
    expect(result(output, 'mem_b').governance_event_refs).toEqual([ref(conflict), ref(resolve)])
  })

  it('applies resolve supersede and resolve deactivate atomically', () => {
    const supersede = ledgerBuilder()
    const conflict = supersede.append({ action: 'add_conflict', first: A, second: B })
    supersede.append({ action: 'resolve_conflict', conflict_event: ref(conflict), resolution: { kind: 'supersede', replacement: B, replaced: A } })
    const superseded = replay(supersede.events)
    expect(result(superseded, 'mem_a')).toMatchObject({ lifecycle_status: 'superseded', unresolved_conflict_refs: [] })
    expect(result(superseded, 'mem_b')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [] })

    const deactivate = ledgerBuilder()
    const conflict2 = deactivate.append({ action: 'add_conflict', first: A, second: B })
    deactivate.append({ action: 'resolve_conflict', conflict_event: ref(conflict2), resolution: { kind: 'deactivate', memory: A } })
    const deactivated = replay(deactivate.events)
    expect(result(deactivated, 'mem_a')).toMatchObject({ lifecycle_status: 'inactive', unresolved_conflict_refs: [] })
    expect(result(deactivated, 'mem_b')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [] })
  })

  it('enforces the multi-conflict lifecycle invariant for resolution', () => {
    const rejectSupersede = ledgerBuilder()
    const ab = rejectSupersede.append({ action: 'add_conflict', first: A, second: B })
    rejectSupersede.append({ action: 'add_conflict', first: A, second: C })
    rejectSupersede.append({ action: 'resolve_conflict', conflict_event: ref(ab), resolution: { kind: 'supersede', replacement: B, replaced: A } })
    expect(() => replay(rejectSupersede.events)).toThrow(ProtocolValidationError)

    const rejectDeactivate = ledgerBuilder()
    const ab2 = rejectDeactivate.append({ action: 'add_conflict', first: A, second: B })
    rejectDeactivate.append({ action: 'add_conflict', first: A, second: C })
    rejectDeactivate.append({ action: 'resolve_conflict', conflict_event: ref(ab2), resolution: { kind: 'deactivate', memory: A } })
    expect(() => replay(rejectDeactivate.events)).toThrow(ProtocolValidationError)

    const allowDeactivate = ledgerBuilder()
    const ab3 = allowDeactivate.append({ action: 'add_conflict', first: A, second: B })
    allowDeactivate.append({ action: 'add_conflict', first: B, second: C })
    allowDeactivate.append({ action: 'resolve_conflict', conflict_event: ref(ab3), resolution: { kind: 'deactivate', memory: A } })
    const output = replay(allowDeactivate.events)
    expect(result(output, 'mem_a').lifecycle_status).toBe('inactive')
    expect(result(output, 'mem_b')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [ref(allowDeactivate.events[1])] })
  })

  it('allows dismiss of one conflict while another remains unresolved', () => {
    const ledger = ledgerBuilder()
    const ab = ledger.append({ action: 'add_conflict', first: A, second: B })
    const ac = ledger.append({ action: 'add_conflict', first: A, second: C })
    ledger.append({ action: 'resolve_conflict', conflict_event: ref(ab), resolution: { kind: 'dismiss' } })
    const output = replay(ledger.events)
    expect(result(output, 'mem_a')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [ref(ac)] })
    expect(result(output, 'mem_b').unresolved_conflict_refs).toEqual([])
  })

  it('handles deactivate/reactivate and restores prior superseded status', () => {
    const ledger = ledgerBuilder()
    const supersede = ledger.append({ action: 'supersede', replacement: B, replaced: A })
    const deactivate = ledger.append({ action: 'deactivate', memory: A })
    const reactivate = ledger.append({ action: 'reactivate', memory: A, deactivate_event: ref(deactivate) })
    const output = replay(ledger.events)
    expect(result(output, 'mem_a')).toMatchObject({ lifecycle_status: 'superseded', superseded_by: B, inactive_by: null })
    expect(result(output, 'mem_a').governance_event_refs).toEqual(sortedRefs([supersede, deactivate, reactivate]))

    const invalid = ledgerBuilder()
    const conflict = invalid.append({ action: 'add_conflict', first: A, second: B })
    const resolve = invalid.append({ action: 'resolve_conflict', conflict_event: ref(conflict), resolution: { kind: 'deactivate', memory: A } })
    invalid.append({ action: 'reactivate', memory: A, deactivate_event: ref(resolve) })
    expect(() => replay(invalid.events)).toThrow(ProtocolValidationError)
  })

  it('reverts business and atomic resolution events by full replay', () => {
    const supersede = ledgerBuilder()
    const e1 = supersede.append({ action: 'supersede', replacement: B, replaced: A })
    supersede.append({ action: 'revert', target_event: ref(e1) })
    expect(result(replay(supersede.events), 'mem_a').lifecycle_status).toBe('active')

    const conflict = ledgerBuilder()
    const e2 = conflict.append({ action: 'add_conflict', first: A, second: B })
    const e3 = conflict.append({ action: 'resolve_conflict', conflict_event: ref(e2), resolution: { kind: 'supersede', replacement: B, replaced: A } })
    const e4 = conflict.append({ action: 'revert', target_event: ref(e3) })
    const output = replay(conflict.events)
    expect(result(output, 'mem_a')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [ref(e2)] })
    expect(result(output, 'mem_b')).toMatchObject({ lifecycle_status: 'active', unresolved_conflict_refs: [ref(e2)] })
    expect(result(output, 'mem_a').governance_event_refs).toEqual(sortedRefs([e2, e3, e4]))

    const addThenDismiss = ledgerBuilder()
    const add = addThenDismiss.append({ action: 'add_conflict', first: A, second: B })
    const dismiss = addThenDismiss.append({ action: 'resolve_conflict', conflict_event: ref(add), resolution: { kind: 'dismiss' } })
    addThenDismiss.append({ action: 'revert', target_event: ref(dismiss) })
    expect(result(replay(addThenDismiss.events), 'mem_a').unresolved_conflict_refs).toEqual([ref(add)])

    const addThenRevert = ledgerBuilder()
    const add2 = addThenRevert.append({ action: 'add_conflict', first: A, second: B })
    const dismiss2 = addThenRevert.append({ action: 'resolve_conflict', conflict_event: ref(add2), resolution: { kind: 'dismiss' } })
    addThenRevert.append({ action: 'revert', target_event: ref(dismiss2) })
    addThenRevert.append({ action: 'revert', target_event: ref(add2) })
    expect(result(replay(addThenRevert.events), 'mem_a').unresolved_conflict_refs).toEqual([])
  })

  it('reverts deactivate/reactivate and rejects dependent or duplicate reverts', () => {
    const ledger = ledgerBuilder()
    const deactivate = ledger.append({ action: 'deactivate', memory: A })
    const reactivate = ledger.append({ action: 'reactivate', memory: A, deactivate_event: ref(deactivate) })
    ledger.append({ action: 'revert', target_event: ref(reactivate) })
    expect(result(replay(ledger.events), 'mem_a').lifecycle_status).toBe('inactive')

    const duplicate = ledgerBuilder()
    const target = duplicate.append({ action: 'deactivate', memory: A })
    duplicate.append({ action: 'revert', target_event: ref(target) })
    duplicate.append({ action: 'revert', target_event: ref(target) })
    expect(() => replay(duplicate.events)).toThrow(ProtocolValidationError)

    const dependent = ledgerBuilder()
    const target2 = dependent.append({ action: 'add_conflict', first: A, second: B })
    dependent.append({ action: 'resolve_conflict', conflict_event: ref(target2), resolution: { kind: 'dismiss' } })
    dependent.append({ action: 'revert', target_event: ref(target2) })
    expect(() => replay(dependent.events)).toThrow(ProtocolValidationError)
  })

  it('keeps complete semantic history and ignores evidence-only memory references', () => {
    const ledger = ledgerBuilder()
    const evidenceOnly = ledger.append({ action: 'deactivate', memory: A }, [{ kind: 'memory', ...D }])
    const output = replay(ledger.events)
    expect(result(output, 'mem_a').governance_event_refs).toEqual([ref(evidenceOnly)])
    expect(result(output, 'mem_d').governance_event_refs).toEqual([])

    const conflict = ledgerBuilder()
    const add = conflict.append({ action: 'add_conflict', first: A, second: B })
    const resolve = conflict.append({ action: 'resolve_conflict', conflict_event: ref(add), resolution: { kind: 'dismiss' } })
    const reverted = conflict.append({ action: 'revert', target_event: ref(resolve) })
    const output2 = replay(conflict.events)
    expect(result(output2, 'mem_a').governance_event_refs).toEqual(sortedRefs([add, resolve, reverted]))
  })

  it('is deterministic across repeated replay', () => {
    const ledger = ledgerBuilder()
    const conflict = ledger.append({ action: 'add_conflict', first: A, second: B })
    ledger.append({ action: 'resolve_conflict', conflict_event: ref(conflict), resolution: { kind: 'dismiss' } })
    const first = replay(ledger.events)
    expect(replay(ledger.events)).toEqual(first)
    expect(replay(ledger.events)).toEqual(structuredClone(first))
  })
})
