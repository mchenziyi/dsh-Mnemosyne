import { assertExactKeys, assertHash, assertInteger, canonicalBytes, canonicalHash, ProtocolValidationError } from '../protocol/canonical.js'
import { createGovernanceEventV1, validateGovernanceEventRefV1, type GovernanceEventPayloadV1, type GovernanceEvidenceRefV1, type GovernanceHeadV1 } from '../protocol/governance.js'
import { validateScopeId } from '../memory-store-path.js'

const PROPOSAL_KEYS = ['schema_version', 'proposal_id', 'project_scope_id', 'base_generation_id', 'base_governance_head', 'payload', 'evidence_refs', 'reason_code', 'proposed_at'] as const
const PROPOSAL_ID = /^prop_[0-9a-f]{64}$/
const GENERATION_ID = /^gen_[0-9a-f]{64}$/

export interface GovernanceProposalV1 {
  schema_version: 1
  proposal_id: string
  project_scope_id: string
  base_generation_id: string
  base_governance_head: GovernanceHeadV1 | null
  payload: GovernanceEventPayloadV1
  evidence_refs: GovernanceEvidenceRefV1[]
  reason_code: string
  proposed_at: string
}

export type GovernanceProposalDraftV1 = Omit<GovernanceProposalV1, 'proposal_id'>

function invalid(message = 'proposal_invalid'): never { throw new ProtocolValidationError(message) }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function validateHead(value: unknown): GovernanceHeadV1 | null {
  if (value === null) return null
  assertExactKeys(value, ['sequence', 'event_id', 'event_sha256'])
  assertInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER)
  return { sequence: value.sequence, ...validateGovernanceEventRefV1({ event_id: value.event_id, event_sha256: value.event_sha256 }) }
}

function normalizeDraft(value: unknown): GovernanceProposalDraftV1 {
  if (typeof value !== 'object' || value === null) return invalid()
  const raw = value as Record<string, unknown>
  assertExactKeys(value, ['schema_version', 'project_scope_id', 'base_generation_id', 'base_governance_head', 'payload', 'evidence_refs', 'reason_code', 'proposed_at'])
  if (raw.schema_version !== 1) return invalid()
  let project_scope_id: string
  try { project_scope_id = validateScopeId(raw.project_scope_id) } catch { return invalid() }
  if (typeof raw.base_generation_id !== 'string' || !GENERATION_ID.test(raw.base_generation_id)) return invalid()
  const base_governance_head = validateHead(raw.base_governance_head)
  // Reuse the frozen Event payload/evidence validator without creating a second schema.
  const normalizedEvent = createGovernanceEventV1({
    schema_version: 1,
    project_scope_id,
    sequence: 1,
    prev_event_hash: null,
    payload: raw.payload as GovernanceEventPayloadV1,
    evidence_refs: raw.evidence_refs as GovernanceEvidenceRefV1[],
    reason_code: raw.reason_code as string,
    created_at: raw.proposed_at as string,
  })
  return {
    schema_version: 1,
    project_scope_id,
    base_generation_id: raw.base_generation_id,
    base_governance_head,
    payload: structuredClone(normalizedEvent.payload),
    evidence_refs: structuredClone(normalizedEvent.evidence_refs),
    reason_code: normalizedEvent.reason_code,
    proposed_at: normalizedEvent.created_at,
  }
}

function identityOf(value: GovernanceProposalDraftV1): GovernanceProposalDraftV1 {
  return {
    schema_version: 1,
    project_scope_id: value.project_scope_id,
    base_generation_id: value.base_generation_id,
    base_governance_head: value.base_governance_head,
    payload: value.payload,
    evidence_refs: value.evidence_refs,
    reason_code: value.reason_code,
    proposed_at: value.proposed_at,
  }
}

export function computeGovernanceProposalHashV1(value: GovernanceProposalDraftV1): string {
  return canonicalHash(identityOf(normalizeDraft(value)))
}

export function computeGovernanceProposalIdV1(proposalSha256: string): string {
  assertHash(proposalSha256)
  return `prop_${proposalSha256.slice('sha256_'.length)}`
}

export function createGovernanceProposalV1(value: GovernanceProposalDraftV1): GovernanceProposalV1 {
  const draft = normalizeDraft(value)
  return deepFreeze({ ...structuredClone(draft), proposal_id: computeGovernanceProposalIdV1(canonicalHash(identityOf(draft))) })
}

export function validateGovernanceProposalV1(value: unknown): GovernanceProposalV1 {
  assertExactKeys(value, PROPOSAL_KEYS)
  const raw = value as Record<string, unknown>
  if (typeof raw.proposal_id !== 'string' || !PROPOSAL_ID.test(raw.proposal_id)) return invalid()
  const draft = normalizeDraft({
    schema_version: raw.schema_version,
    project_scope_id: raw.project_scope_id,
    base_generation_id: raw.base_generation_id,
    base_governance_head: raw.base_governance_head,
    payload: raw.payload,
    evidence_refs: raw.evidence_refs,
    reason_code: raw.reason_code,
    proposed_at: raw.proposed_at,
  })
  if (canonicalBytes(raw.payload) !== canonicalBytes(draft.payload) || canonicalBytes(raw.evidence_refs) !== canonicalBytes(draft.evidence_refs)) return invalid('proposal_noncanonical')
  if (raw.proposal_id !== computeGovernanceProposalIdV1(canonicalHash(identityOf(draft)))) return invalid('proposal_identity_mismatch')
  return deepFreeze({ ...structuredClone(draft), proposal_id: raw.proposal_id })
}

export function canonicalizeGovernanceProposalV1(value: unknown): string {
  return canonicalBytes(validateGovernanceProposalV1(value))
}

export function sameGovernanceHeadV1(left: GovernanceHeadV1 | null, right: GovernanceHeadV1 | null): boolean {
  if (left === null || right === null) return left === right
  return left.sequence === right.sequence && left.event_id === right.event_id && left.event_sha256 === right.event_sha256
}
