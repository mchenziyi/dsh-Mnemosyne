import { assertExactKeys, assertHash, assertInteger, canonicalBytes, canonicalHash, compareCodePoints, ProtocolValidationError } from './canonical.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { validateMemoryId } from '../memory-store-path.js'

const EVENT_ID = /^gov_[0-9a-f]{64}$/
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/

const MEMORY_REF_KEYS = ['memory_id', 'content_sha256'] as const
const EVENT_REF_KEYS = ['event_id', 'event_sha256'] as const
const MEMORY_EVIDENCE_KEYS = ['kind', 'memory_id', 'content_sha256'] as const
const EVENT_EVIDENCE_KEYS = ['kind', 'event_id', 'event_sha256'] as const
const EVENT_KEYS = ['schema_version', 'event_id', 'event_sha256', 'project_scope_id', 'sequence', 'prev_event_hash', 'payload', 'evidence_refs', 'reason_code', 'created_at'] as const
const EVENT_DRAFT_KEYS = ['schema_version', 'project_scope_id', 'sequence', 'prev_event_hash', 'payload', 'evidence_refs', 'reason_code', 'created_at'] as const
const HEAD_KEYS = ['sequence', 'event_id', 'event_sha256'] as const
const MEMORY_RECORD_KEYS = ['memory_id', 'content_sha256', 'project_scope_id'] as const

export interface GovernanceMemoryRefV1 {
  memory_id: string
  content_sha256: string
}

export interface GovernanceEventRefV1 {
  event_id: string
  event_sha256: string
}

export type GovernanceEvidenceRefV1 =
  | ({ kind: 'memory' } & GovernanceMemoryRefV1)
  | ({ kind: 'governance_event' } & GovernanceEventRefV1)

export interface SupersedePayloadV1 {
  action: 'supersede'
  replacement: GovernanceMemoryRefV1
  replaced: GovernanceMemoryRefV1
}

export interface AddConflictPayloadV1 {
  action: 'add_conflict'
  first: GovernanceMemoryRefV1
  second: GovernanceMemoryRefV1
}

export type ConflictResolutionV1 =
  | { kind: 'dismiss' }
  | { kind: 'supersede'; replacement: GovernanceMemoryRefV1; replaced: GovernanceMemoryRefV1 }
  | { kind: 'deactivate'; memory: GovernanceMemoryRefV1 }

export interface ResolveConflictPayloadV1 {
  action: 'resolve_conflict'
  conflict_event: GovernanceEventRefV1
  resolution: ConflictResolutionV1
}

export interface DeactivatePayloadV1 {
  action: 'deactivate'
  memory: GovernanceMemoryRefV1
}

export interface ReactivatePayloadV1 {
  action: 'reactivate'
  memory: GovernanceMemoryRefV1
  deactivate_event: GovernanceEventRefV1
}

export interface RevertPayloadV1 {
  action: 'revert'
  target_event: GovernanceEventRefV1
}

export type GovernanceEventPayloadV1 =
  | SupersedePayloadV1
  | AddConflictPayloadV1
  | ResolveConflictPayloadV1
  | DeactivatePayloadV1
  | ReactivatePayloadV1
  | RevertPayloadV1

export interface GovernanceEventDraftV1 {
  schema_version: 1
  project_scope_id: string
  sequence: number
  prev_event_hash: string | null
  payload: GovernanceEventPayloadV1
  evidence_refs: GovernanceEvidenceRefV1[]
  reason_code: string
  created_at: string
}

export interface GovernanceEventV1 extends GovernanceEventDraftV1 {
  event_id: string
  event_sha256: string
}

export interface GovernanceHeadV1 extends GovernanceEventRefV1 {
  sequence: number
}

export interface GovernanceMemoryRecordV1 extends GovernanceMemoryRefV1 {
  project_scope_id: string
}

export interface GovernanceReferenceContextV1 {
  project_scope_id: string
  current_head: GovernanceHeadV1 | null
  memories: readonly GovernanceMemoryRecordV1[]
  committed_events: readonly GovernanceEventV1[]
}

function invalid(): never {
  throw new ProtocolValidationError()
}

function sameMemoryRef(left: GovernanceMemoryRefV1, right: GovernanceMemoryRefV1): boolean {
  return left.memory_id === right.memory_id && left.content_sha256 === right.content_sha256
}

function sameEventRef(left: GovernanceEventRefV1, right: GovernanceEventRefV1): boolean {
  return left.event_id === right.event_id && left.event_sha256 === right.event_sha256
}

export function compareGovernanceMemoryRefsV1(left: GovernanceMemoryRefV1, right: GovernanceMemoryRefV1): number {
  return compareCodePoints(left.memory_id, right.memory_id) || compareCodePoints(left.content_sha256, right.content_sha256)
}

export function compareGovernanceEventRefsV1(left: GovernanceEventRefV1, right: GovernanceEventRefV1): number {
  return compareCodePoints(left.event_id, right.event_id) || compareCodePoints(left.event_sha256, right.event_sha256)
}

export function compareGovernanceEvidenceRefsV1(left: GovernanceEvidenceRefV1, right: GovernanceEvidenceRefV1): number {
  const kind = compareCodePoints(left.kind, right.kind)
  if (kind !== 0) return kind
  if (left.kind === 'memory' && right.kind === 'memory') return compareGovernanceMemoryRefsV1(left, right)
  if (left.kind === 'governance_event' && right.kind === 'governance_event') return compareGovernanceEventRefsV1(left, right)
  return invalid()
}

export function validateGovernanceMemoryRefV1(value: unknown): GovernanceMemoryRefV1 {
  assertExactKeys(value, MEMORY_REF_KEYS)
  try { validateMemoryId(value.memory_id) } catch { invalid() }
  assertHash(value.content_sha256)
  return { memory_id: value.memory_id as string, content_sha256: value.content_sha256 as string }
}

export function computeGovernanceEventIdV1(eventSha256: string): string {
  assertHash(eventSha256)
  return `gov_${eventSha256.slice('sha256_'.length)}`
}

export function validateGovernanceEventRefV1(value: unknown): GovernanceEventRefV1 {
  assertExactKeys(value, EVENT_REF_KEYS)
  assertHash(value.event_sha256)
  if (typeof value.event_id !== 'string' || !EVENT_ID.test(value.event_id) || value.event_id !== computeGovernanceEventIdV1(value.event_sha256)) invalid()
  return { event_id: value.event_id, event_sha256: value.event_sha256 }
}

export function validateGovernanceEvidenceRefV1(value: unknown): GovernanceEvidenceRefV1 {
  if (typeof value !== 'object' || value === null || !('kind' in value)) invalid()
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind === 'memory') {
    assertExactKeys(value, MEMORY_EVIDENCE_KEYS)
    const ref = validateGovernanceMemoryRefV1({ memory_id: raw.memory_id, content_sha256: raw.content_sha256 })
    return { kind, ...ref }
  }
  if (kind === 'governance_event') {
    assertExactKeys(value, EVENT_EVIDENCE_KEYS)
    const ref = validateGovernanceEventRefV1({ event_id: raw.event_id, event_sha256: raw.event_sha256 })
    return { kind, ...ref }
  }
  return invalid()
}

function validateResolution(value: unknown): ConflictResolutionV1 {
  if (typeof value !== 'object' || value === null || !('kind' in value)) invalid()
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind === 'dismiss') {
    assertExactKeys(value, ['kind'])
    return { kind }
  }
  if (kind === 'supersede') {
    assertExactKeys(value, ['kind', 'replacement', 'replaced'])
    const replacement = validateGovernanceMemoryRefV1(raw.replacement)
    const replaced = validateGovernanceMemoryRefV1(raw.replaced)
    if (replacement.memory_id === replaced.memory_id) invalid()
    return { kind, replacement, replaced }
  }
  if (kind === 'deactivate') {
    assertExactKeys(value, ['kind', 'memory'])
    return { kind, memory: validateGovernanceMemoryRefV1(raw.memory) }
  }
  return invalid()
}

function validatePayload(value: unknown, requireCanonicalOrder: boolean): GovernanceEventPayloadV1 {
  if (typeof value !== 'object' || value === null || !('action' in value)) invalid()
  const raw = value as Record<string, unknown>
  const action = raw.action
  if (action === 'supersede') {
    assertExactKeys(value, ['action', 'replacement', 'replaced'])
    const replacement = validateGovernanceMemoryRefV1(raw.replacement)
    const replaced = validateGovernanceMemoryRefV1(raw.replaced)
    if (replacement.memory_id === replaced.memory_id) invalid()
    return { action, replacement, replaced }
  }
  if (action === 'add_conflict') {
    assertExactKeys(value, ['action', 'first', 'second'])
    const first = validateGovernanceMemoryRefV1(raw.first)
    const second = validateGovernanceMemoryRefV1(raw.second)
    if (first.memory_id === second.memory_id) invalid()
    const comparison = compareGovernanceMemoryRefsV1(first, second)
    if (requireCanonicalOrder && comparison >= 0) invalid()
    return comparison < 0 ? { action, first, second } : { action, first: second, second: first }
  }
  if (action === 'resolve_conflict') {
    assertExactKeys(value, ['action', 'conflict_event', 'resolution'])
    return {
      action,
      conflict_event: validateGovernanceEventRefV1(raw.conflict_event),
      resolution: validateResolution(raw.resolution),
    }
  }
  if (action === 'deactivate') {
    assertExactKeys(value, ['action', 'memory'])
    return { action, memory: validateGovernanceMemoryRefV1(raw.memory) }
  }
  if (action === 'reactivate') {
    assertExactKeys(value, ['action', 'memory', 'deactivate_event'])
    return {
      action,
      memory: validateGovernanceMemoryRefV1(raw.memory),
      deactivate_event: validateGovernanceEventRefV1(raw.deactivate_event),
    }
  }
  if (action === 'revert') {
    assertExactKeys(value, ['action', 'target_event'])
    return { action, target_event: validateGovernanceEventRefV1(raw.target_event) }
  }
  return invalid()
}

function payloadMemoryRefs(payload: GovernanceEventPayloadV1): GovernanceMemoryRefV1[] {
  if (payload.action === 'supersede' || payload.action === 'add_conflict') return [payload.action === 'supersede' ? payload.replacement : payload.first, payload.action === 'supersede' ? payload.replaced : payload.second]
  if (payload.action === 'deactivate' || payload.action === 'reactivate') return [payload.memory]
  if (payload.action === 'resolve_conflict') {
    if (payload.resolution.kind === 'dismiss') return []
    if (payload.resolution.kind === 'deactivate') return [payload.resolution.memory]
    return [payload.resolution.replacement, payload.resolution.replaced]
  }
  return []
}

function payloadEventRefs(payload: GovernanceEventPayloadV1): GovernanceEventRefV1[] {
  if (payload.action === 'resolve_conflict') return [payload.conflict_event]
  if (payload.action === 'reactivate') return [payload.deactivate_event]
  if (payload.action === 'revert') return [payload.target_event]
  return []
}

function assertIdentityConsistency(payload: GovernanceEventPayloadV1, evidence: readonly GovernanceEvidenceRefV1[]): void {
  const memoryHashes = new Map<string, string>()
  const eventHashes = new Map<string, string>()
  const rememberMemory = (ref: GovernanceMemoryRefV1): void => {
    const previous = memoryHashes.get(ref.memory_id)
    if (previous !== undefined && previous !== ref.content_sha256) invalid()
    memoryHashes.set(ref.memory_id, ref.content_sha256)
  }
  const rememberEvent = (ref: GovernanceEventRefV1): void => {
    const previous = eventHashes.get(ref.event_id)
    if (previous !== undefined && previous !== ref.event_sha256) invalid()
    eventHashes.set(ref.event_id, ref.event_sha256)
  }
  for (const ref of payloadMemoryRefs(payload)) rememberMemory(ref)
  for (const ref of payloadEventRefs(payload)) rememberEvent(ref)
  for (const ref of evidence) {
    if (ref.kind === 'memory') rememberMemory(ref)
    else rememberEvent(ref)
  }
}

function sameEvidenceRef(left: GovernanceEvidenceRefV1, right: GovernanceEvidenceRefV1): boolean {
  return left.kind === right.kind && (left.kind === 'memory'
    ? right.kind === 'memory' && sameMemoryRef(left, right)
    : right.kind === 'governance_event' && sameEventRef(left, right))
}

function validateDraft(value: unknown, requireCanonicalOrder: boolean): GovernanceEventDraftV1 {
  assertExactKeys(value, EVENT_DRAFT_KEYS)
  if (value.schema_version !== 1) invalid()
  assertHash(value.project_scope_id)
  assertInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER)
  if (value.sequence === 1) {
    if (value.prev_event_hash !== null) invalid()
  } else {
    assertHash(value.prev_event_hash)
  }
  const payload = validatePayload(value.payload, requireCanonicalOrder)
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0) invalid()
  const evidence = value.evidence_refs.map(validateGovernanceEvidenceRefV1)
  for (let index = 0; index < evidence.length; index++) {
    for (let previous = 0; previous < index; previous++) if (sameEvidenceRef(evidence[index], evidence[previous])) invalid()
  }
  const sortedEvidence = [...evidence].sort(compareGovernanceEvidenceRefsV1)
  if (requireCanonicalOrder && evidence.some((ref, index) => !sameEvidenceRef(ref, sortedEvidence[index]))) invalid()
  assertIdentityConsistency(payload, sortedEvidence)
  if (typeof value.reason_code !== 'string' || !REASON_CODE.test(value.reason_code)) invalid()
  try { assertUtcTimestamp(value.created_at) } catch { invalid() }
  return {
    schema_version: 1,
    project_scope_id: value.project_scope_id,
    sequence: value.sequence,
    prev_event_hash: value.prev_event_hash as string | null,
    payload,
    evidence_refs: sortedEvidence,
    reason_code: value.reason_code,
    created_at: value.created_at as string,
  }
}

export function computeGovernanceEventHashV1(value: GovernanceEventDraftV1): string {
  return canonicalHash(validateDraft(value, false))
}

export function createGovernanceEventV1(value: GovernanceEventDraftV1): GovernanceEventV1 {
  const body = validateDraft(value, false)
  const eventSha256 = canonicalHash(body)
  return {
    schema_version: 1,
    event_id: computeGovernanceEventIdV1(eventSha256),
    event_sha256: eventSha256,
    project_scope_id: body.project_scope_id,
    sequence: body.sequence,
    prev_event_hash: body.prev_event_hash,
    payload: body.payload,
    evidence_refs: body.evidence_refs,
    reason_code: body.reason_code,
    created_at: body.created_at,
  }
}

export function validateGovernanceEventV1(value: unknown): GovernanceEventV1 {
  assertExactKeys(value, EVENT_KEYS)
  const body = validateDraft({
    schema_version: value.schema_version,
    project_scope_id: value.project_scope_id,
    sequence: value.sequence,
    prev_event_hash: value.prev_event_hash,
    payload: value.payload,
    evidence_refs: value.evidence_refs,
    reason_code: value.reason_code,
    created_at: value.created_at,
  }, true)
  assertHash(value.event_sha256)
  const expectedHash = canonicalHash(body)
  if (value.event_sha256 !== expectedHash) invalid()
  if (typeof value.event_id !== 'string' || value.event_id !== computeGovernanceEventIdV1(expectedHash)) invalid()
  return { ...body, event_id: value.event_id, event_sha256: value.event_sha256 }
}

export function canonicalizeGovernanceEventV1(value: unknown): string {
  return canonicalBytes(validateGovernanceEventV1(value))
}

function validateHead(value: unknown): GovernanceHeadV1 {
  assertExactKeys(value, HEAD_KEYS)
  assertInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER)
  const ref = validateGovernanceEventRefV1({ event_id: value.event_id, event_sha256: value.event_sha256 })
  return { sequence: value.sequence, ...ref }
}

function validateMemoryRecord(value: unknown): GovernanceMemoryRecordV1 {
  assertExactKeys(value, MEMORY_RECORD_KEYS)
  const ref = validateGovernanceMemoryRefV1({ memory_id: value.memory_id, content_sha256: value.content_sha256 })
  assertHash(value.project_scope_id)
  return { ...ref, project_scope_id: value.project_scope_id }
}

function pairKey(refs: readonly GovernanceMemoryRefV1[]): string {
  return [...refs].sort(compareGovernanceMemoryRefsV1).map((ref) => `${ref.memory_id}\0${ref.content_sha256}`).join('\0')
}

export function validateGovernanceEventReferencesV1(value: unknown, context: GovernanceReferenceContextV1): GovernanceEventV1 {
  const event = validateGovernanceEventV1(value)
  assertHash(context.project_scope_id)
  if (event.project_scope_id !== context.project_scope_id) invalid()

  const memories = new Map<string, GovernanceMemoryRecordV1>()
  for (const raw of context.memories) {
    const memory = validateMemoryRecord(raw)
    if (memories.has(memory.memory_id)) invalid()
    memories.set(memory.memory_id, memory)
  }
  const events = new Map<string, GovernanceEventV1>()
  for (const raw of context.committed_events) {
    const previous = validateGovernanceEventV1(raw)
    if (events.has(previous.event_id)) invalid()
    events.set(previous.event_id, previous)
  }

  let currentHead: GovernanceHeadV1 | null = null
  if (context.current_head !== null) {
    currentHead = validateHead(context.current_head)
    const parent = events.get(currentHead.event_id)
    if (!parent || parent.project_scope_id !== event.project_scope_id || parent.sequence !== currentHead.sequence || !sameEventRef(parent, currentHead)) invalid()
  }
  if (currentHead === null) {
    if (event.sequence !== 1 || event.prev_event_hash !== null) invalid()
  } else if (event.sequence !== currentHead.sequence + 1 || event.prev_event_hash !== currentHead.event_sha256) invalid()

  const resolveMemory = (ref: GovernanceMemoryRefV1): GovernanceMemoryRecordV1 => {
    const resolved = memories.get(ref.memory_id)
    if (!resolved || resolved.project_scope_id !== event.project_scope_id || !sameMemoryRef(resolved, ref)) invalid()
    return resolved
  }
  const resolveEvent = (ref: GovernanceEventRefV1): GovernanceEventV1 => {
    const resolved = events.get(ref.event_id)
    if (!resolved || resolved.project_scope_id !== event.project_scope_id || resolved.sequence >= event.sequence || !sameEventRef(resolved, ref)) invalid()
    return resolved
  }

  for (const ref of payloadMemoryRefs(event.payload)) resolveMemory(ref)
  for (const ref of event.evidence_refs) {
    if (ref.kind === 'memory') resolveMemory(ref)
    else resolveEvent(ref)
  }

  if (event.payload.action === 'resolve_conflict') {
    const target = resolveEvent(event.payload.conflict_event)
    if (target.payload.action !== 'add_conflict') invalid()
    const targetPair = pairKey([target.payload.first, target.payload.second])
    if (event.payload.resolution.kind === 'supersede') {
      if (pairKey([event.payload.resolution.replacement, event.payload.resolution.replaced]) !== targetPair) invalid()
    } else if (event.payload.resolution.kind === 'deactivate') {
      if (!sameMemoryRef(event.payload.resolution.memory, target.payload.first) && !sameMemoryRef(event.payload.resolution.memory, target.payload.second)) invalid()
    }
  } else if (event.payload.action === 'reactivate') {
    const target = resolveEvent(event.payload.deactivate_event)
    if (target.payload.action !== 'deactivate' || !sameMemoryRef(target.payload.memory, event.payload.memory)) invalid()
  } else if (event.payload.action === 'revert') {
    if (resolveEvent(event.payload.target_event).payload.action === 'revert') invalid()
  }

  return event
}
