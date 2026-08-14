import {
  assertArray,
  assertExactKeys,
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
  containsSensitiveText,
  ProtocolValidationError,
} from './canonical.js'

const CONTROLLED_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DISCLOSURE_ID = /^disclosure_[a-z0-9][a-z0-9._-]{0,63}$/
const MEMORY_ID = /^memory_[a-z0-9][a-z0-9._-]{0,63}$/

export interface RetrievalRequest {
  schema_version: 1
  retrieval_id: string
  query_fingerprint: string
  component_hint: string | null
  operation_hint: string | null
  top_k: number
  catalog_sha256: string
  content_sha256: string
}

export interface CandidateRecord {
  memory_id: string
  component_match: boolean
  operation_match: boolean
  alias_match: boolean
  token_count: number
  matched_term_count: number
  score_fixed: number
  rank: number
}

export interface CandidateUniverse {
  schema_version: 1
  retrieval_id: string
  catalog_sha256: string
  candidates: CandidateRecord[]
  content_sha256: string
}

export interface SearchItem {
  memory_id: string
  title: string
  summary: string
  component: string
  operation: string
  tags: string[]
  aliases: string[]
  score_fixed: number
  rank: number
}

export interface SearchDisclosure {
  schema_version: 1
  disclosure_id: string
  retrieval_ref: string
  candidate_universe_sha256: string
  level: 2
  result_count: number
  items: SearchItem[]
  content_sha256: string
}

export interface OpenDisclosure {
  schema_version: 1
  disclosure_id: string
  retrieval_ref: string
  parent_disclosure_sha256: string
  level: 3
  memory_id: string
  title: string
  summary: string
  component: string
  operation: string
  tags: string[]
  aliases: string[]
  body: string
  lifecycle: 'active'
  memory_content_sha256: string
  content_sha256: string
}

const REQUEST_KEYS = ['schema_version', 'retrieval_id', 'query_fingerprint', 'component_hint', 'operation_hint', 'top_k', 'catalog_sha256', 'content_sha256'] as const
const CANDIDATE_KEYS = ['memory_id', 'component_match', 'operation_match', 'alias_match', 'token_count', 'matched_term_count', 'score_fixed', 'rank'] as const
const UNIVERSE_KEYS = ['schema_version', 'retrieval_id', 'catalog_sha256', 'candidates', 'content_sha256'] as const
const SEARCH_ITEM_KEYS = ['memory_id', 'title', 'summary', 'component', 'operation', 'tags', 'aliases', 'score_fixed', 'rank'] as const
const SEARCH_KEYS = ['schema_version', 'disclosure_id', 'retrieval_ref', 'candidate_universe_sha256', 'level', 'result_count', 'items', 'content_sha256'] as const
const OPEN_KEYS = ['schema_version', 'disclosure_id', 'retrieval_ref', 'parent_disclosure_sha256', 'level', 'memory_id', 'title', 'summary', 'component', 'operation', 'tags', 'aliases', 'body', 'lifecycle', 'memory_content_sha256', 'content_sha256'] as const

function id(value: unknown, expression: RegExp): asserts value is string { if (typeof value !== 'string' || !expression.test(value)) throw new ProtocolValidationError() }
function controlled(value: unknown): asserts value is string { if (typeof value !== 'string' || !CONTROLLED_ID.test(value)) throw new ProtocolValidationError() }
function hashWithout<T extends Record<string, unknown>>(value: T, key: string): string { const copy = { ...value }; delete copy[key]; return canonicalHash(copy) }
function hashField(value: unknown, expected: string): void { assertHash(value); if (value !== expected) throw new ProtocolValidationError() }
function text(value: unknown, max: number): asserts value is string { assertSafeText(value, max); if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ProtocolValidationError() }
function controlledStringList(value: unknown, max: number): string[] { assertArray(value, max); const values = value as unknown[]; if (!values.every((item) => typeof item === 'string' && CONTROLLED_ID.test(item))) throw new ProtocolValidationError(); assertNoDuplicate(values as string[]); return [...(values as string[])].sort(compareCodePoints) }
function safeStringList(value: unknown, max: number): string[] { assertArray(value, max); const values = value as unknown[]; for (const item of values) { assertSafeText(item, 120); if (/[\u0000-\u001f\u007f]/u.test(item)) throw new ProtocolValidationError() } assertNoDuplicate(values as string[]); return [...(values as string[])].sort(compareCodePoints) }
function stableId(prefix: string, value: unknown): string { return `${prefix}${canonicalHash(value).slice(7, 23)}` }

export function validateRetrievalRequest(value: unknown): RetrievalRequest {
  assertObject(value); assertExactKeys(value, REQUEST_KEYS); assertInteger(value.schema_version, 1, 1); id(value.retrieval_id, /^retrieval_[a-z0-9][a-z0-9._-]{0,63}$/); assertHash(value.query_fingerprint); if (value.component_hint !== null) controlled(value.component_hint); if (value.operation_hint !== null) controlled(value.operation_hint); assertInteger(value.top_k, 1, 5); assertHash(value.catalog_sha256); assertHash(value.content_sha256)
  if (value.retrieval_id !== stableId('retrieval_', { query_fingerprint: value.query_fingerprint, component_hint: value.component_hint, operation_hint: value.operation_hint, top_k: value.top_k, catalog_sha256: value.catalog_sha256 })) throw new ProtocolValidationError()
  hashField(value.content_sha256, hashWithout(value, 'content_sha256'))
  return { schema_version: 1, retrieval_id: value.retrieval_id, query_fingerprint: value.query_fingerprint, component_hint: value.component_hint as string | null, operation_hint: value.operation_hint as string | null, top_k: value.top_k, catalog_sha256: value.catalog_sha256, content_sha256: value.content_sha256 }
}

function validateCandidateRecord(value: unknown): CandidateRecord {
  assertObject(value); assertExactKeys(value, CANDIDATE_KEYS); id(value.memory_id, MEMORY_ID); if (typeof value.component_match !== 'boolean' || typeof value.operation_match !== 'boolean' || typeof value.alias_match !== 'boolean') throw new ProtocolValidationError(); assertInteger(value.token_count, 0, 1_000_000); assertInteger(value.matched_term_count, 0, 1_000_000); assertInteger(value.score_fixed, 0, Number.MAX_SAFE_INTEGER); assertInteger(value.rank, 1, 1_000_000); return { memory_id: value.memory_id, component_match: value.component_match, operation_match: value.operation_match, alias_match: value.alias_match, token_count: value.token_count, matched_term_count: value.matched_term_count, score_fixed: value.score_fixed, rank: value.rank }
}

export function validateCandidateUniverse(value: unknown): CandidateUniverse {
  assertObject(value); assertExactKeys(value, UNIVERSE_KEYS); assertInteger(value.schema_version, 1, 1); id(value.retrieval_id, /^retrieval_[a-z0-9][a-z0-9._-]{0,63}$/); assertHash(value.catalog_sha256); assertArray(value.candidates, 128); const candidates = (value.candidates as unknown[]).map(validateCandidateRecord); assertNoDuplicate(candidates.map((item) => item.memory_id)); for (let index = 0; index < candidates.length; index++) { const item = candidates[index]; if (item.rank !== index + 1 || (index > 0 && (candidates[index - 1].score_fixed < item.score_fixed || (candidates[index - 1].score_fixed === item.score_fixed && compareCodePoints(candidates[index - 1].memory_id, item.memory_id) > 0)))) throw new ProtocolValidationError() }
  assertHash(value.content_sha256); hashField(value.content_sha256, hashWithout(value, 'content_sha256')); return { schema_version: 1, retrieval_id: value.retrieval_id, catalog_sha256: value.catalog_sha256, candidates, content_sha256: value.content_sha256 }
}

function validateSearchItem(value: unknown): SearchItem {
  assertObject(value); assertExactKeys(value, SEARCH_ITEM_KEYS); id(value.memory_id, MEMORY_ID); text(value.title, 120); text(value.summary, 1000); controlled(value.component); controlled(value.operation); const tags = controlledStringList(value.tags, 16); const aliases = safeStringList(value.aliases, 16); assertInteger(value.score_fixed, 0, Number.MAX_SAFE_INTEGER); assertInteger(value.rank, 1, 5); return { memory_id: value.memory_id, title: value.title, summary: value.summary, component: value.component, operation: value.operation, tags, aliases, score_fixed: value.score_fixed, rank: value.rank }
}

export function validateSearchDisclosure(value: unknown): SearchDisclosure {
  assertObject(value); assertExactKeys(value, SEARCH_KEYS); assertInteger(value.schema_version, 1, 1); id(value.disclosure_id, DISCLOSURE_ID); id(value.retrieval_ref, /^retrieval_[a-z0-9][a-z0-9._-]{0,63}$/); assertHash(value.candidate_universe_sha256); assertInteger(value.level, 2, 2); assertArray(value.items, 5); const items = (value.items as unknown[]).map(validateSearchItem); assertInteger(value.result_count, 0, 5); if (value.result_count !== items.length || new Set(items.map((item) => item.memory_id)).size !== items.length) throw new ProtocolValidationError(); for (let index = 0; index < items.length; index++) if (items[index].rank !== index + 1 || (index > 0 && (items[index - 1].score_fixed < items[index].score_fixed || (items[index - 1].score_fixed === items[index].score_fixed && compareCodePoints(items[index - 1].memory_id, items[index].memory_id) > 0)))) throw new ProtocolValidationError(); if (value.disclosure_id !== stableId('disclosure_', { retrieval_ref: value.retrieval_ref, candidate_universe_sha256: value.candidate_universe_sha256, level: 2, items })) throw new ProtocolValidationError(); assertHash(value.content_sha256); hashField(value.content_sha256, hashWithout(value, 'content_sha256')); return { schema_version: 1, disclosure_id: value.disclosure_id, retrieval_ref: value.retrieval_ref, candidate_universe_sha256: value.candidate_universe_sha256, level: 2, result_count: value.result_count, items, content_sha256: value.content_sha256 }
}

export function validateOpenDisclosure(value: unknown): OpenDisclosure {
  assertObject(value); assertExactKeys(value, OPEN_KEYS); assertInteger(value.schema_version, 1, 1); id(value.disclosure_id, DISCLOSURE_ID); id(value.retrieval_ref, /^retrieval_[a-z0-9][a-z0-9._-]{0,63}$/); assertHash(value.parent_disclosure_sha256); assertInteger(value.level, 3, 3); id(value.memory_id, MEMORY_ID); text(value.title, 120); text(value.summary, 1000); controlled(value.component); controlled(value.operation); const tags = controlledStringList(value.tags, 16); const aliases = safeStringList(value.aliases, 16); text(value.body, 8000); if (value.lifecycle !== 'active') throw new ProtocolValidationError(); const memoryContent = { memory_id: value.memory_id, title: value.title, summary: value.summary, component: value.component, operation: value.operation, tags, aliases, body: value.body, lifecycle: 'active' as const }; assertHash(value.memory_content_sha256); hashField(value.memory_content_sha256, canonicalHash(memoryContent)); if (value.disclosure_id !== stableId('disclosure_', { parent_disclosure_sha256: value.parent_disclosure_sha256, retrieval_ref: value.retrieval_ref, memory_id: value.memory_id, level: 3 })) throw new ProtocolValidationError(); assertHash(value.content_sha256); hashField(value.content_sha256, hashWithout(value, 'content_sha256')); return { schema_version: 1, disclosure_id: value.disclosure_id, retrieval_ref: value.retrieval_ref, parent_disclosure_sha256: value.parent_disclosure_sha256, level: 3, memory_id: value.memory_id, title: value.title, summary: value.summary, component: value.component, operation: value.operation, tags, aliases, body: value.body, lifecycle: 'active', memory_content_sha256: value.memory_content_sha256, content_sha256: value.content_sha256 }
}

export type DisclosureEnvelope = SearchDisclosure | OpenDisclosure

export function replayDisclosure(bytes: string): DisclosureEnvelope {
  if (typeof bytes !== 'string' || bytes.length > 1_000_000) throw new ProtocolValidationError()
  let value: unknown; try { value = JSON.parse(bytes) } catch { throw new ProtocolValidationError() }
  assertObject(value); if (value.level === 2) return validateSearchDisclosure(value); if (value.level === 3) return validateOpenDisclosure(value); throw new ProtocolValidationError()
}

export function encodeDisclosure(value: DisclosureEnvelope): string { return canonicalBytes(value.level === 2 ? validateSearchDisclosure(value) : validateOpenDisclosure(value)) }
