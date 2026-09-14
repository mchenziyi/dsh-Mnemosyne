import { assertHash, ProtocolValidationError } from '../protocol/canonical.js'
import {
  compareGovernanceEventRefsV1,
  compareGovernanceMemoryRefsV1,
  validateGovernanceEventReferencesV1,
  validateGovernanceEventV1,
  validateGovernanceMemoryRefV1,
  type GovernanceEventRefV1,
  type GovernanceEventV1,
  type GovernanceMemoryRecordV1,
  type GovernanceMemoryRefV1,
  type GovernanceReferenceContextV1,
} from '../protocol/governance.js'

export interface EffectiveMemoryV1 {
  memory_ref: GovernanceMemoryRefV1
  lifecycle_status: 'active' | 'superseded' | 'inactive'
  superseded_by: GovernanceMemoryRefV1 | null
  inactive_by: GovernanceEventRefV1 | null
  unresolved_conflict_refs: GovernanceEventRefV1[]
  governance_event_refs: GovernanceEventRefV1[]
}

export interface GovernanceReplayInputV1 {
  project_scope_id: string
  memories: readonly GovernanceMemoryRecordV1[]
  events: readonly GovernanceEventV1[]
}

export interface GovernanceReplayResultV1 {
  effective_memories: EffectiveMemoryV1[]
}

interface MemoryState {
  readonly record: GovernanceMemoryRecordV1
  supersededBy: GovernanceMemoryRefV1 | null
  inactiveBy: GovernanceEventRefV1 | null
  directDeactivations: Set<string>
  history: Set<string>
}

interface ConflictState {
  readonly event: GovernanceEventV1
  readonly first: GovernanceMemoryRefV1
  readonly second: GovernanceMemoryRefV1
}

interface ReplayState {
  readonly memories: Map<string, MemoryState>
  readonly conflicts: Map<string, ConflictState>
}

function invalid(message: string): never {
  throw new ProtocolValidationError(message)
}

function memoryKey(ref: GovernanceMemoryRefV1): string {
  return `${ref.memory_id}\0${ref.content_sha256}`
}

function eventKey(ref: GovernanceEventRefV1): string {
  return `${ref.event_id}\0${ref.event_sha256}`
}

function refOf(event: GovernanceEventV1): GovernanceEventRefV1 {
  return { event_id: event.event_id, event_sha256: event.event_sha256 }
}

function sameMemory(left: GovernanceMemoryRefV1, right: GovernanceMemoryRefV1): boolean {
  return left.memory_id === right.memory_id && left.content_sha256 === right.content_sha256
}

function sameEvent(left: GovernanceEventRefV1, right: GovernanceEventRefV1): boolean {
  return left.event_id === right.event_id && left.event_sha256 === right.event_sha256
}

function pairKey(first: GovernanceMemoryRefV1, second: GovernanceMemoryRefV1): string {
  const refs = [first, second].sort(compareGovernanceMemoryRefsV1)
  return `${memoryKey(refs[0])}\0${memoryKey(refs[1])}`
}

function cloneMemoryRef(ref: GovernanceMemoryRefV1): GovernanceMemoryRefV1 {
  return { memory_id: ref.memory_id, content_sha256: ref.content_sha256 }
}

function cloneEventRef(ref: GovernanceEventRefV1): GovernanceEventRefV1 {
  return { event_id: ref.event_id, event_sha256: ref.event_sha256 }
}

function stateOf(state: MemoryState): 'active' | 'superseded' | 'inactive' {
  if (state.inactiveBy !== null) return 'inactive'
  if (state.supersededBy !== null) return 'superseded'
  return 'active'
}

function assertActive(state: MemoryState): void {
  if (stateOf(state) !== 'active') invalid('memory_not_active')
}

function assertNoUnresolvedConflicts(state: ReplayState, memoryId: string, except?: string): void {
  for (const [key, conflict] of state.conflicts) {
    if (key !== except && (conflict.first.memory_id === memoryId || conflict.second.memory_id === memoryId)) invalid('memory_has_unresolved_conflict')
  }
}

function assertInvariant(state: ReplayState): void {
  for (const memory of state.memories.values()) {
    const hasConflict = [...state.conflicts.values()].some((conflict) => conflict.first.memory_id === memory.record.memory_id || conflict.second.memory_id === memory.record.memory_id)
    if (hasConflict && stateOf(memory) !== 'active') invalid('unresolved_conflict_requires_active_memory')
  }
}

function assertNoSupersedeCycle(state: ReplayState, replacedId: string, replacementId: string): void {
  const seen = new Set<string>()
  let current: string | null = replacementId
  while (current !== null) {
    if (current === replacedId) invalid('supersede_cycle')
    if (seen.has(current)) invalid('supersede_cycle')
    seen.add(current)
    current = state.memories.get(current)?.supersededBy?.memory_id ?? null
  }
}

function resolveMemory(state: ReplayState, ref: GovernanceMemoryRefV1): MemoryState {
  const memory = state.memories.get(ref.memory_id)
  if (!memory || !sameMemory(memory.record, ref)) invalid('memory_reference_unresolved')
  return memory
}

function applySupersede(state: ReplayState, replacementRef: GovernanceMemoryRefV1, replacedRef: GovernanceMemoryRefV1, conflictToClose: string | undefined, event: GovernanceEventV1): void {
  if (sameMemory(replacementRef, replacedRef)) invalid('self_supersede')
  const replacement = resolveMemory(state, replacementRef)
  const replaced = resolveMemory(state, replacedRef)
  assertActive(replacement)
  assertActive(replaced)
  assertNoUnresolvedConflicts(state, replacement.record.memory_id, conflictToClose)
  assertNoUnresolvedConflicts(state, replaced.record.memory_id, conflictToClose)
  if (replaced.supersededBy !== null) invalid('multiple_direct_replacement')
  assertNoSupersedeCycle(state, replaced.record.memory_id, replacement.record.memory_id)
  replaced.supersededBy = cloneMemoryRef(replacementRef)
  replaced.history.add(event.event_id)
  replacement.history.add(event.event_id)
  assertInvariant(state)
}

function applyDeactivate(state: ReplayState, memoryRef: GovernanceMemoryRefV1, event: GovernanceEventV1, conflictToClose?: string): void {
  const memory = resolveMemory(state, memoryRef)
  if (stateOf(memory) === 'inactive') invalid('memory_already_inactive')
  if (stateOf(memory) !== 'active' && stateOf(memory) !== 'superseded') invalid('memory_not_deactivatable')
  assertNoUnresolvedConflicts(state, memory.record.memory_id, conflictToClose)
  const eventRef = refOf(event)
  memory.inactiveBy = eventRef
  memory.directDeactivations.add(event.event_id)
  memory.history.add(event.event_id)
  assertInvariant(state)
}

function applyEvent(state: ReplayState, event: GovernanceEventV1, eventIndex: Map<string, GovernanceEventV1>, masked: ReadonlySet<string>, targetOwner: ReadonlyMap<string, string>): void {
  if (event.payload.action === 'revert') {
    const targetId = event.payload.target_event.event_id
    const owner = targetOwner.get(targetId)
    if (owner !== undefined && owner !== event.event_id) invalid('revert_dependency_violation')
    const target = eventIndex.get(targetId)
    if (!target || target.sequence >= event.sequence || target.payload.action === 'revert') invalid('invalid_revert_target')
    return
  }
  if (masked.has(event.event_id)) return

  const payload = event.payload
  if (payload.action === 'supersede') applySupersede(state, payload.replacement, payload.replaced, undefined, event)
  else if (payload.action === 'add_conflict') {
    const first = resolveMemory(state, payload.first)
    const second = resolveMemory(state, payload.second)
    assertActive(first)
    assertActive(second)
    const key = pairKey(payload.first, payload.second)
    if (state.conflicts.has(key)) invalid('duplicate_unresolved_conflict')
    const conflict = { event, first: cloneMemoryRef(payload.first), second: cloneMemoryRef(payload.second) }
    state.conflicts.set(key, conflict)
    first.history.add(event.event_id)
    second.history.add(event.event_id)
  } else if (payload.action === 'resolve_conflict') {
    const target = eventIndex.get(payload.conflict_event.event_id)
    if (!target || target.payload.action !== 'add_conflict') invalid('conflict_event_unresolved')
    const key = pairKey(target.payload.first, target.payload.second)
    const conflict = state.conflicts.get(key)
    if (!conflict || !sameEvent(refOf(conflict.event), payload.conflict_event)) invalid('conflict_already_resolved')
    state.conflicts.delete(key)
    if (payload.resolution.kind === 'dismiss') {
      resolveMemory(state, conflict.first).history.add(event.event_id)
      resolveMemory(state, conflict.second).history.add(event.event_id)
    } else if (payload.resolution.kind === 'supersede') {
      applySupersede(state, payload.resolution.replacement, payload.resolution.replaced, key, event)
    } else {
      applyDeactivate(state, payload.resolution.memory, event, key)
    }
    resolveMemory(state, conflict.first).history.add(event.event_id)
    resolveMemory(state, conflict.second).history.add(event.event_id)
  } else if (payload.action === 'deactivate') applyDeactivate(state, payload.memory, event)
  else if (payload.action === 'reactivate') {
    const memory = resolveMemory(state, payload.memory)
    const target = eventIndex.get(payload.deactivate_event.event_id)
    if (!target || target.payload.action !== 'deactivate' || !sameMemory(target.payload.memory, payload.memory)) invalid('invalid_reactivate_target')
    if (!memory.directDeactivations.has(target.event_id) || !sameEvent(memory.inactiveBy!, payload.deactivate_event)) invalid('deactivate_event_not_active')
    memory.directDeactivations.delete(target.event_id)
    memory.inactiveBy = null
    memory.history.add(event.event_id)
  }
  assertInvariant(state)
}

function collectFootprint(event: GovernanceEventV1, events: ReadonlyMap<string, GovernanceEventV1>, seen = new Set<string>()): string[] {
  if (seen.has(event.event_id)) return []
  seen.add(event.event_id)
  const payload = event.payload
  if (payload.action === 'supersede') return [payload.replacement.memory_id, payload.replaced.memory_id]
  if (payload.action === 'add_conflict') return [payload.first.memory_id, payload.second.memory_id]
  if (payload.action === 'deactivate' || payload.action === 'reactivate') return [payload.memory.memory_id]
  if (payload.action === 'resolve_conflict') {
    const target = events.get(payload.conflict_event.event_id)
    return target ? collectFootprint(target, events, seen) : []
  }
  const target = events.get(payload.target_event.event_id)
  return target ? collectFootprint(target, events, seen) : []
}

function createState(memories: readonly GovernanceMemoryRecordV1[], projectScopeId: string): ReplayState {
  const map = new Map<string, MemoryState>()
  for (const raw of memories) {
    const memory = resolveMemoryRecord(raw)
    if (memory.project_scope_id !== projectScopeId) invalid('memory_project_scope_mismatch')
    if (map.has(memory.memory_id)) invalid('duplicate_memory_id')
    map.set(memory.memory_id, { record: memory, supersededBy: null, inactiveBy: null, directDeactivations: new Set(), history: new Set() })
  }
  return { memories: map, conflicts: new Map() }
}

function resolveMemoryRecord(raw: GovernanceMemoryRecordV1): GovernanceMemoryRecordV1 {
  const ref = validateGovernanceMemoryRefV1({ memory_id: raw.memory_id, content_sha256: raw.content_sha256 })
  if (typeof raw.project_scope_id !== 'string') invalid('invalid_memory_project')
  return { ...ref, project_scope_id: raw.project_scope_id }
}

function validateChain(input: GovernanceReplayInputV1): GovernanceEventV1[] {
  if (!Array.isArray(input.events)) invalid('events_must_be_array')
  const events: GovernanceEventV1[] = []
  let previous: GovernanceEventV1 | null = null
  for (const raw of input.events) {
    const event = validateGovernanceEventV1(raw)
    const context: GovernanceReferenceContextV1 = { project_scope_id: input.project_scope_id, current_head: previous ? { sequence: previous.sequence, event_id: previous.event_id, event_sha256: previous.event_sha256 } : null, memories: input.memories, committed_events: events }
    validateGovernanceEventReferencesV1(event, context)
    if (previous && (event.sequence !== previous.sequence + 1 || event.prev_event_hash !== previous.event_sha256)) invalid('invalid_chain_link')
    events.push(event)
    previous = event
  }
  return events
}

function replayWithMask(input: GovernanceReplayInputV1, events: readonly GovernanceEventV1[], masked: ReadonlySet<string>, targetOwner: ReadonlyMap<string, string>): ReplayState {
  const state = createState(input.memories, input.project_scope_id)
  const index = new Map(events.map((event) => [event.event_id, event]))
  for (const event of events) applyEvent(state, event, index, masked, targetOwner)
  return state
}

export function replayGovernanceV1(input: GovernanceReplayInputV1): GovernanceReplayResultV1 {
  if (typeof input !== 'object' || input === null || typeof input.project_scope_id !== 'string') invalid('invalid_replay_input')
  assertHash(input.project_scope_id)
  if (!Array.isArray(input.memories)) invalid('memories_must_be_array')
  const events = validateChain(input)
  const targetOwner = new Map<string, string>()
  const masks = new Set<string>()
  const allEvents = new Map(events.map((event) => [event.event_id, event]))
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.payload.action !== 'revert') continue
    const targetId = event.payload.target_event.event_id
    if (targetOwner.has(targetId)) invalid('duplicate_revert')
    if (targetId === event.event_id) invalid('revert_of_revert')
    const target = allEvents.get(targetId)
    if (!target || target.sequence >= event.sequence || target.payload.action === 'revert') invalid('invalid_revert_target')
    targetOwner.set(targetId, event.event_id)
    masks.add(targetId)
    try { replayWithMask(input, events.slice(0, index + 1), masks, targetOwner) } catch (error) {
      targetOwner.delete(targetId)
      masks.delete(targetId)
      throw error
    }
  }
  const state = replayWithMask(input, events, masks, targetOwner)
  const footprintEvents = new Map<string, Set<string>>()
  for (const event of events) {
    for (const memoryId of collectFootprint(event, allEvents)) {
      let set = footprintEvents.get(memoryId)
      if (!set) { set = new Set(); footprintEvents.set(memoryId, set) }
      set.add(event.event_id)
    }
  }
  const output = [...state.memories.values()].sort((left, right) => compareGovernanceMemoryRefsV1(left.record, right.record)).map((memory) => {
    const unresolved = [...state.conflicts.values()].filter((conflict) => conflict.first.memory_id === memory.record.memory_id || conflict.second.memory_id === memory.record.memory_id).map((conflict) => refOf(conflict.event)).sort(compareGovernanceEventRefsV1)
    const history = [...(footprintEvents.get(memory.record.memory_id) ?? [])].map((id) => refOf(allEvents.get(id)!)).sort(compareGovernanceEventRefsV1)
    return {
      memory_ref: { memory_id: memory.record.memory_id, content_sha256: memory.record.content_sha256 },
      lifecycle_status: stateOf(memory),
      superseded_by: memory.supersededBy ? cloneMemoryRef(memory.supersededBy) : null,
      inactive_by: memory.inactiveBy ? cloneEventRef(memory.inactiveBy) : null,
      unresolved_conflict_refs: unresolved.map(cloneEventRef),
      governance_event_refs: history.map(cloneEventRef),
    }
  })
  return { effective_memories: output }
}

export const replayGovernance: typeof replayGovernanceV1 = replayGovernanceV1

export function projectEffectiveMemoryV1(input: GovernanceReplayInputV1): EffectiveMemoryV1[] {
  return replayGovernanceV1(input).effective_memories
}

export const replayGovernanceEventsV1: typeof replayGovernanceV1 = replayGovernanceV1
