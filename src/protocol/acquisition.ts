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
  assertString,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
  ProtocolValidationError,
} from './canonical.js'

export const SOURCE_KINDS = ['task_completed', 'checkpoint', 'explicit_request'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface AcquisitionCandidate {
  schema_version: 1
  candidate_id: string
  source_event_id: string
  source_kind: SourceKind
  scope_id: string
  task_fingerprint: string
  component: string
  operation: string
  title: string
  summary: string
  applies_when: string[]
  failure_boundaries: string[]
  tags: string[]
  aliases: string[]
  redaction_status: 'passed'
  content_sha256: string
}

export const SKIP_DECISIONS = ['eligible', 'skip_exact_event', 'skip_exact_content', 'duplicate_candidate'] as const
export type SkipDecision = (typeof SKIP_DECISIONS)[number]

export interface AcquisitionSkipDecision {
  schema_version: 1
  candidate_id: string
  decision: SkipDecision
  basis_ids: string[]
  content_sha256: string
}

export interface SkipDecisionInput {
  candidate_id: string
  decision: SkipDecision
  basis_ids: string[]
}

const CANDIDATE_KEYS = ['schema_version', 'candidate_id', 'source_event_id', 'source_kind', 'scope_id', 'task_fingerprint', 'component', 'operation', 'title', 'summary', 'applies_when', 'failure_boundaries', 'tags', 'aliases', 'redaction_status', 'content_sha256'] as const
const SKIP_KEYS = ['schema_version', 'candidate_id', 'decision', 'basis_ids', 'content_sha256'] as const
const CONTROLLED = /^[a-z0-9][a-z0-9._-]{0,63}$/

function boundedList(value: unknown, max: number, itemMax: number): string[] {
  assertArray(value, max)
  for (const item of value) assertSafeText(item, itemMax)
  const result = value as string[]
  assertNoDuplicate(result)
  return result
}

function sortedTextList(value: unknown, max: number, itemMax: number): string[] {
  return [...boundedList(value, max, itemMax)].sort(compareCodePoints)
}

function controlledList(value: unknown, max: number): string[] {
  assertArray(value, max)
  if (value.some((item) => typeof item !== 'string' || !CONTROLLED.test(item))) throw new ProtocolValidationError()
  const result = value as string[]
  assertNoDuplicate(result)
  return [...result].sort(compareCodePoints)
}

function candidateHashPayload(candidate: AcquisitionCandidate): Record<string, unknown> {
  const { candidate_id: _id, content_sha256: _hash, ...rest } = candidate
  return rest
}

export function candidateContentHash(candidate: AcquisitionCandidate): string {
  return canonicalHash(candidateHashPayload(candidate))
}

export function candidateId(sourceEventId: string, taskFingerprint: string, contentHash: string): string {
  return `candidate_${canonicalHash({ content_sha256: contentHash, source_event_id: sourceEventId, task_fingerprint: taskFingerprint }).slice(8, 24)}`
}

export function validateCandidate(value: unknown): AcquisitionCandidate {
  assertObject(value)
  assertExactKeys(value, CANDIDATE_KEYS)
  assertInteger(value.schema_version, 1, 1)
  assertId(value.candidate_id, 'candidate_')
  assertId(value.source_event_id, 'event_')
  assertEnum(value.source_kind, SOURCE_KINDS)
  assertId(value.scope_id, 'scope_')
  assertHash(value.task_fingerprint)
  if (typeof value.component !== 'string' || !CONTROLLED.test(value.component)) throw new ProtocolValidationError()
  if (typeof value.operation !== 'string' || !CONTROLLED.test(value.operation)) throw new ProtocolValidationError()
  assertSafeText(value.title, 120)
  assertSafeText(value.summary, 1000)
  const applies = sortedTextList(value.applies_when, 16, 200)
  const boundaries = sortedTextList(value.failure_boundaries, 16, 200)
  const aliases = sortedTextList(value.aliases, 16, 200)
  const tags = controlledList(value.tags, 16)
  assertEnum(value.redaction_status, ['passed'])
  assertHash(value.content_sha256)
  if (candidateId(value.source_event_id, value.task_fingerprint, value.content_sha256) !== value.candidate_id) throw new ProtocolValidationError()
  const normalized: AcquisitionCandidate = {
    schema_version: 1,
    candidate_id: value.candidate_id,
    source_event_id: value.source_event_id,
    source_kind: value.source_kind as SourceKind,
    scope_id: value.scope_id,
    task_fingerprint: value.task_fingerprint,
    component: value.component,
    operation: value.operation,
    title: value.title,
    summary: value.summary,
    applies_when: applies,
    failure_boundaries: boundaries,
    tags,
    aliases,
    redaction_status: 'passed',
    content_sha256: value.content_sha256,
  }
  if (candidateContentHash(normalized) !== value.content_sha256) throw new ProtocolValidationError()
  return normalized
}

export interface CandidateInput {
  source_event_id: string
  source_kind: SourceKind
  scope_id: string
  task_fingerprint: string
  component: string
  operation: string
  title: string
  summary: string
  applies_when: string[]
  failure_boundaries: string[]
  tags: string[]
  aliases: string[]
}

export function createCandidate(input: CandidateInput): AcquisitionCandidate {
  const base = { schema_version: 1 as const, candidate_id: 'candidate_placeholder', ...input, redaction_status: 'passed' as const, content_sha256: 'sha256_' + '0'.repeat(64) }
  const contentHash = candidateContentHash(base)
  const candidate = { ...base, content_sha256: contentHash, candidate_id: candidateId(input.source_event_id, input.task_fingerprint, contentHash) }
  return validateCandidate(candidate)
}

export function encodeCandidate(candidate: AcquisitionCandidate): string {
  return canonicalBytes(validateCandidate(candidate))
}

export function validateSkipDecision(value: unknown): AcquisitionSkipDecision {
  assertObject(value)
  assertExactKeys(value, SKIP_KEYS)
  assertInteger(value.schema_version, 1, 1)
  assertId(value.candidate_id, 'candidate_')
  assertEnum(value.decision, SKIP_DECISIONS)
  assertArray(value.basis_ids, 16)
  const basis = value.basis_ids as unknown[]
  if (!basis.every((id) => typeof id === 'string' && CONTROLLED.test(id))) throw new ProtocolValidationError()
  assertNoDuplicate(basis as string[])
  if (basis.length === 0) throw new ProtocolValidationError()
  const basisIds = [...(basis as string[])].sort(compareCodePoints)
  assertHash(value.content_sha256)
  const normalized = { schema_version: 1 as const, candidate_id: value.candidate_id, decision: value.decision as SkipDecision, basis_ids: basisIds }
  if (canonicalHash(normalized) !== value.content_sha256) throw new ProtocolValidationError()
  return { ...normalized, content_sha256: value.content_sha256 }
}

export function skipDecisionContentHash(decision: SkipDecisionInput): string {
  return canonicalHash({ schema_version: 1, candidate_id: decision.candidate_id, decision: decision.decision, basis_ids: [...decision.basis_ids].sort(compareCodePoints) })
}

export function createSkipDecision(input: SkipDecisionInput): AcquisitionSkipDecision {
  return validateSkipDecision({ schema_version: 1, ...input, content_sha256: skipDecisionContentHash(input) })
}

export function encodeSkipDecision(decision: AcquisitionSkipDecision): string {
  return canonicalBytes(validateSkipDecision(decision))
}

export function skipBlocksAcquisition(decision: AcquisitionSkipDecision): boolean {
  validateSkipDecision(decision)
  return decision.decision === 'skip_exact_event' || decision.decision === 'skip_exact_content'
}
