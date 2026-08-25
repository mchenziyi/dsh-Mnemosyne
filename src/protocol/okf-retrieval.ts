import { createHash } from 'node:crypto'
import { isMemoryStoreErrorCode } from '../memory-store-error.js'
import {
  assertArray,
  assertExactKeys,
  assertHash,
  assertId,
  assertInteger,
  assertNoDuplicate,
  assertObject,
  assertString,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
  ProtocolValidationError,
  withoutHash,
} from './canonical.js'

const invalid = (message = 'okf retrieval protocol validation failed'): never => {
  throw new ProtocolValidationError(message)
}

const COMPONENT_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,23}$/
const TAG_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/

export function assertComponentSlug(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !COMPONENT_SLUG_REGEX.test(value)) {
    invalid('invalid component slug')
  }
}

export function assertTag(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TAG_REGEX.test(value)) {
    invalid('invalid tag')
  }
}

/* ==========================================================================
 * 1. Generation Ref
 * ========================================================================== */

export interface OKFGenerationRef {
  generation_id: string
  generation_sha256: string
  manifest_id: string
  manifest_sha256: string
  index_sha256: string
}

const GENERATION_REF_KEYS = [
  'generation_id',
  'generation_sha256',
  'manifest_id',
  'manifest_sha256',
  'index_sha256',
] as const

export function validateGenerationRef(value: unknown): OKFGenerationRef {
  assertObject(value)
  assertExactKeys(value, GENERATION_REF_KEYS)

  const obj = value as Record<string, unknown>
  assertId(obj.generation_id, 'gen_')
  assertHash(obj.generation_sha256)
  assertId(obj.manifest_id, 'manifest_')
  assertHash(obj.manifest_sha256)
  assertHash(obj.index_sha256)

  return Object.freeze({
    generation_id: obj.generation_id,
    generation_sha256: obj.generation_sha256,
    manifest_id: obj.manifest_id,
    manifest_sha256: obj.manifest_sha256,
    index_sha256: obj.index_sha256,
  })
}

export function canonicalizeGenerationRef(value: OKFGenerationRef): string {
  const validated = validateGenerationRef(value)
  return canonicalBytes(validated)
}

/* ==========================================================================
 * 2. Search Input
 * ========================================================================== */

export interface OKFSearchInput {
  query: string
  component_hint: string | null
  top_k: number
}

export function validateSearchInput(value: unknown): OKFSearchInput {
  assertObject(value)
  const obj = value as Record<string, unknown>

  // Reject unknown search input keys
  const allowedKeys = ['query', 'component_hint', 'top_k']
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) {
      invalid('unknown key in search input')
    }
  }

  if (typeof obj.query !== 'string') {
    invalid('search query must be string')
  }
  const query = (obj.query as string).trim()
  if (query.length === 0 || query.length > 500 || CONTROL_CHARS_REGEX.test(query)) {
    invalid('search query invalid length or contains control chars')
  }

  let component_hint: string | null = null
  if (obj.component_hint !== undefined && obj.component_hint !== null) {
    assertComponentSlug(obj.component_hint)
    component_hint = obj.component_hint
  }

  let top_k = 5
  if (obj.top_k !== undefined && obj.top_k !== null) {
    assertInteger(obj.top_k, 1, 5)
    top_k = obj.top_k
  }

  return Object.freeze({
    query,
    component_hint,
    top_k,
  })
}

/* ==========================================================================
 * 3. Memory Ref
 * ========================================================================== */

export interface OKFShortTermMemoryRef {
  tier: 'short_term'
  session_scope_id: string
  memory_id: string
  content_sha256: string
  page_ref: string
}

export interface OKFLongTermMemoryRef {
  tier: 'long_term'
  session_scope_id: null
  memory_id: string
  content_sha256: string
  page_ref: string
}

export type OKFMemoryRef = OKFShortTermMemoryRef | OKFLongTermMemoryRef

const MEMORY_REF_KEYS = [
  'tier',
  'session_scope_id',
  'memory_id',
  'content_sha256',
  'page_ref',
] as const

export function validateMemoryRef(value: unknown): OKFMemoryRef {
  assertObject(value)
  assertExactKeys(value, MEMORY_REF_KEYS)

  const obj = value as Record<string, unknown>
  if (obj.tier !== 'short_term' && obj.tier !== 'long_term') {
    invalid('invalid memory tier')
  }

  if (obj.tier === 'short_term') {
    if (typeof obj.session_scope_id !== 'string') {
      invalid('short_term memory ref must have string session_scope_id')
    }
    assertHash(obj.session_scope_id)
  } else {
    if (obj.session_scope_id !== null) {
      invalid('long_term memory ref must have null session_scope_id')
    }
  }

  assertId(obj.memory_id, 'mem_')
  assertHash(obj.content_sha256)

  if (typeof obj.page_ref !== 'string' || !obj.page_ref.startsWith('wiki/memories/mem_') || !obj.page_ref.endsWith('.md')) {
    invalid('invalid page_ref format')
  }

  if (obj.tier === 'short_term') {
    return Object.freeze({
      tier: 'short_term' as const,
      session_scope_id: obj.session_scope_id as string,
      memory_id: obj.memory_id as string,
      content_sha256: obj.content_sha256 as string,
      page_ref: obj.page_ref as string,
    })
  }

  return Object.freeze({
    tier: 'long_term' as const,
    session_scope_id: null,
    memory_id: obj.memory_id as string,
    content_sha256: obj.content_sha256 as string,
    page_ref: obj.page_ref as string,
  })
}

export function canonicalizeMemoryRef(value: OKFMemoryRef): string {
  const validated = validateMemoryRef(value)
  return canonicalBytes(validated)
}

/* ==========================================================================
 * 4. Deterministic ID Computation Pure Functions
 * ========================================================================== */

export interface ComputeRetrievalIdParams {
  project_scope_id: string
  session_scope_id: string
  query_fingerprint: string
  component_hint: string | null
  top_k: number
  generation_ref: OKFGenerationRef | null
}

export function computeRetrievalId(params: ComputeRetrievalIdParams): string {
  assertHash(params.project_scope_id)
  assertHash(params.session_scope_id)
  assertHash(params.query_fingerprint)
  if (params.component_hint !== null) {
    assertComponentSlug(params.component_hint)
  }
  assertInteger(params.top_k, 1, 5)
  if (params.generation_ref !== null) {
    validateGenerationRef(params.generation_ref)
  }

  const identity = {
    schema_version: 1,
    kind: 'retrieval',
    project_scope_id: params.project_scope_id,
    session_scope_id: params.session_scope_id,
    query_fingerprint: params.query_fingerprint,
    component_hint: params.component_hint,
    top_k: params.top_k,
    generation_ref: params.generation_ref,
  }
  return `retrieval_${createHash('sha256').update(canonicalBytes(identity)).digest('hex')}`
}

export interface ComputeSearchDisclosureIdParams {
  retrieval_id: string
  project_scope_id: string
  session_scope_id: string
  query_fingerprint: string
  component_hint: string | null
  top_k: number
  generation_ref: OKFGenerationRef | null
  items: readonly OKFSearchDisclosureItem[]
}

export function computeSearchDisclosureId(params: ComputeSearchDisclosureIdParams): string {
  assertId(params.retrieval_id, 'retrieval_')
  assertHash(params.project_scope_id)
  assertHash(params.session_scope_id)
  assertHash(params.query_fingerprint)
  if (params.component_hint !== null) {
    assertComponentSlug(params.component_hint)
  }
  assertInteger(params.top_k, 1, 5)
  if (params.generation_ref !== null) {
    validateGenerationRef(params.generation_ref)
  }

  const identity = {
    schema_version: 1,
    kind: 'search_disclosure',
    retrieval_id: params.retrieval_id,
    project_scope_id: params.project_scope_id,
    session_scope_id: params.session_scope_id,
    query_fingerprint: params.query_fingerprint,
    component_hint: params.component_hint,
    top_k: params.top_k,
    generation_ref: params.generation_ref,
    items: params.items,
  }
  return `disclosure_${createHash('sha256').update(canonicalBytes(identity)).digest('hex')}`
}

export interface ComputeOpenDisclosureIdParams {
  retrieval_id: string
  parent_disclosure_sha256: string
  project_scope_id: string
  session_scope_id: string
  generation_ref: OKFGenerationRef
  memory_ref: OKFMemoryRef
}

export function computeOpenDisclosureId(params: ComputeOpenDisclosureIdParams): string {
  assertId(params.retrieval_id, 'retrieval_')
  assertHash(params.parent_disclosure_sha256)
  assertHash(params.project_scope_id)
  assertHash(params.session_scope_id)
  validateGenerationRef(params.generation_ref)
  validateMemoryRef(params.memory_ref)

  const identity = {
    schema_version: 1,
    kind: 'open_disclosure',
    retrieval_id: params.retrieval_id,
    parent_disclosure_sha256: params.parent_disclosure_sha256,
    project_scope_id: params.project_scope_id,
    session_scope_id: params.session_scope_id,
    generation_ref: params.generation_ref,
    memory_ref: params.memory_ref,
  }
  return `disclosure_${createHash('sha256').update(canonicalBytes(identity)).digest('hex')}`
}

/* ==========================================================================
 * 5. Search Disclosure Item & Search Disclosure
 * ========================================================================== */

export interface OKFSearchDisclosureItem {
  memory_ref: OKFMemoryRef
  title: string
  summary: string
  component: string | null
  tags: readonly string[]
  score_fixed: number
  rank: number
}

const SEARCH_ITEM_KEYS = [
  'memory_ref',
  'title',
  'summary',
  'component',
  'tags',
  'score_fixed',
  'rank',
] as const

export function validateSearchDisclosureItem(value: unknown, expectedRank?: number): OKFSearchDisclosureItem {
  assertObject(value)
  assertExactKeys(value, SEARCH_ITEM_KEYS)

  const obj = value as Record<string, unknown>
  const memory_ref = validateMemoryRef(obj.memory_ref)

  assertString(obj.title, 256)
  if (obj.title.length === 0) invalid('title cannot be empty')
  assertString(obj.summary, 2048)
  if (obj.summary.length === 0) invalid('summary cannot be empty')

  if (obj.component !== null) {
    assertComponentSlug(obj.component)
  }

  assertArray(obj.tags, 32)
  const tags: string[] = []
  for (const t of obj.tags) {
    assertTag(t)
    tags.push(t)
  }
  assertNoDuplicate(tags)
  const sortedTags = [...tags].sort(compareCodePoints)
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] !== sortedTags[i]) {
      invalid('tags must be sorted by codepoints')
    }
  }

  assertInteger(obj.score_fixed, 1, 1_000_000_000)
  assertInteger(obj.rank, 1, 5)
  if (expectedRank !== undefined && obj.rank !== expectedRank) {
    invalid('invalid item rank')
  }

  return Object.freeze({
    memory_ref,
    title: obj.title,
    summary: obj.summary,
    component: obj.component,
    tags: Object.freeze(sortedTags),
    score_fixed: obj.score_fixed,
    rank: obj.rank,
  })
}

export interface OKFSearchDisclosure {
  schema_version: 1
  disclosure_id: string
  retrieval_id: string
  project_scope_id: string
  session_scope_id: string
  generation_ref: OKFGenerationRef | null
  query_fingerprint: string
  component_hint: string | null
  top_k: number
  level: 2
  result_count: number
  items: readonly OKFSearchDisclosureItem[]
  content_sha256: string
}

const SEARCH_DISCLOSURE_KEYS = [
  'schema_version',
  'disclosure_id',
  'retrieval_id',
  'project_scope_id',
  'session_scope_id',
  'generation_ref',
  'query_fingerprint',
  'component_hint',
  'top_k',
  'level',
  'result_count',
  'items',
  'content_sha256',
] as const

export function validateSearchDisclosure(value: unknown): OKFSearchDisclosure {
  assertObject(value)
  assertExactKeys(value, SEARCH_DISCLOSURE_KEYS)

  const obj = value as Record<string, unknown>
  if (obj.schema_version !== 1) invalid('schema_version must be 1')
  assertId(obj.disclosure_id, 'disclosure_')
  assertId(obj.retrieval_id, 'retrieval_')
  assertHash(obj.project_scope_id)
  assertHash(obj.session_scope_id)

  let generation_ref: OKFGenerationRef | null = null
  if (obj.generation_ref !== null) {
    generation_ref = validateGenerationRef(obj.generation_ref)
  } else {
    if (obj.result_count !== 0 || (Array.isArray(obj.items) && obj.items.length !== 0)) {
      invalid('empty generation must have zero results')
    }
  }

  assertHash(obj.query_fingerprint)
  if (obj.component_hint !== null) {
    assertComponentSlug(obj.component_hint)
  }
  assertInteger(obj.top_k, 1, 5)
  if (obj.level !== 2) invalid('search disclosure level must be 2')
  assertInteger(obj.result_count, 0, 5)

  assertArray(obj.items, 5)
  if (obj.items.length !== obj.result_count) {
    invalid('result_count must match items.length')
  }

  const items: OKFSearchDisclosureItem[] = []
  let previousItem: OKFSearchDisclosureItem | null = null
  const seenMemoryIds = new Set<string>()

  for (let i = 0; i < obj.items.length; i++) {
    const item = validateSearchDisclosureItem(obj.items[i], i + 1)
    if (seenMemoryIds.has(item.memory_ref.memory_id)) {
      invalid('duplicate memory_id in items')
    }
    seenMemoryIds.add(item.memory_ref.memory_id)

    if (previousItem !== null) {
      if (item.score_fixed > previousItem.score_fixed) {
        invalid('scores in items must be non-increasing')
      } else if (item.score_fixed === previousItem.score_fixed) {
        if (compareCodePoints(previousItem.memory_ref.memory_id, item.memory_ref.memory_id) >= 0) {
          invalid('tied scores must be sorted by memory_id ascending')
        }
      }
    }
    previousItem = item
    items.push(item)
  }

  // Validate deterministic IDs
  const expectedRetrievalId = computeRetrievalId({
    project_scope_id: obj.project_scope_id as string,
    session_scope_id: obj.session_scope_id as string,
    query_fingerprint: obj.query_fingerprint as string,
    component_hint: obj.component_hint as string | null,
    top_k: obj.top_k as number,
    generation_ref,
  })
  if (obj.retrieval_id !== expectedRetrievalId) {
    invalid('retrieval_id mismatch')
  }

  const expectedDisclosureId = computeSearchDisclosureId({
    retrieval_id: expectedRetrievalId,
    project_scope_id: obj.project_scope_id as string,
    session_scope_id: obj.session_scope_id as string,
    query_fingerprint: obj.query_fingerprint as string,
    component_hint: obj.component_hint as string | null,
    top_k: obj.top_k as number,
    generation_ref,
    items,
  })
  if (obj.disclosure_id !== expectedDisclosureId) {
    invalid('disclosure_id mismatch')
  }

  // Strict Hash verification
  const resultWithoutHash = withoutHash(obj)
  const expectedSha = canonicalHash(resultWithoutHash)

  if (typeof obj.content_sha256 !== 'string' || obj.content_sha256.length === 0) {
    invalid('missing or invalid content_sha256')
  }
  assertHash(obj.content_sha256)
  if (obj.content_sha256 !== expectedSha) {
    invalid('search disclosure content_sha256 mismatch')
  }

  return Object.freeze({
    schema_version: 1,
    disclosure_id: obj.disclosure_id,
    retrieval_id: obj.retrieval_id,
    project_scope_id: obj.project_scope_id,
    session_scope_id: obj.session_scope_id,
    generation_ref,
    query_fingerprint: obj.query_fingerprint,
    component_hint: obj.component_hint as string | null,
    top_k: obj.top_k,
    level: 2,
    result_count: obj.result_count,
    items: Object.freeze(items),
    content_sha256: expectedSha,
  })
}

export function canonicalizeSearchDisclosure(value: unknown): string {
  assertObject(value)
  const obj = { ...value } as Record<string, unknown>
  delete obj.content_sha256

  let generation_ref: OKFGenerationRef | null = null
  if (obj.generation_ref !== null && obj.generation_ref !== undefined) {
    generation_ref = validateGenerationRef(obj.generation_ref)
  }
  const items = Array.isArray(obj.items)
    ? obj.items.map((it, idx) => validateSearchDisclosureItem(it, idx + 1))
    : []

  if (
    typeof obj.project_scope_id === 'string' &&
    typeof obj.session_scope_id === 'string' &&
    typeof obj.query_fingerprint === 'string' &&
    typeof obj.top_k === 'number'
  ) {
    obj.retrieval_id = computeRetrievalId({
      project_scope_id: obj.project_scope_id,
      session_scope_id: obj.session_scope_id,
      query_fingerprint: obj.query_fingerprint,
      component_hint: (obj.component_hint as string | null) ?? null,
      top_k: obj.top_k,
      generation_ref,
    })
    obj.disclosure_id = computeSearchDisclosureId({
      retrieval_id: obj.retrieval_id as string,
      project_scope_id: obj.project_scope_id,
      session_scope_id: obj.session_scope_id,
      query_fingerprint: obj.query_fingerprint,
      component_hint: (obj.component_hint as string | null) ?? null,
      top_k: obj.top_k,
      generation_ref,
      items,
    })
  }

  const content_sha256 = canonicalHash(obj)
  const complete = { ...obj, content_sha256 }
  const validated = validateSearchDisclosure(complete)
  return canonicalBytes(validated)
}

/* ==========================================================================
 * 6. Open Input & Open Disclosure
 * ========================================================================== */

export interface OKFOpenInput {
  retrieval_id: string
  search_disclosure_sha256: string
  memory_id: string
}

const OPEN_INPUT_KEYS = [
  'retrieval_id',
  'search_disclosure_sha256',
  'memory_id',
] as const

export function validateOpenInput(value: unknown): OKFOpenInput {
  assertObject(value)
  assertExactKeys(value, OPEN_INPUT_KEYS)

  const obj = value as Record<string, unknown>
  assertId(obj.retrieval_id, 'retrieval_')
  assertHash(obj.search_disclosure_sha256)
  assertId(obj.memory_id, 'mem_')

  return Object.freeze({
    retrieval_id: obj.retrieval_id,
    search_disclosure_sha256: obj.search_disclosure_sha256,
    memory_id: obj.memory_id,
  })
}

export interface OKFOpenDisclosure {
  schema_version: 1
  disclosure_id: string
  retrieval_id: string
  parent_disclosure_sha256: string
  project_scope_id: string
  session_scope_id: string
  generation_ref: OKFGenerationRef
  level: 3
  memory_ref: OKFMemoryRef
  title: string
  summary: string
  component: string | null
  tags: readonly string[]
  body: string
  content_sha256: string
}

const OPEN_DISCLOSURE_KEYS = [
  'schema_version',
  'disclosure_id',
  'retrieval_id',
  'parent_disclosure_sha256',
  'project_scope_id',
  'session_scope_id',
  'generation_ref',
  'level',
  'memory_ref',
  'title',
  'summary',
  'component',
  'tags',
  'body',
  'content_sha256',
] as const

export function validateOpenDisclosure(value: unknown): OKFOpenDisclosure {
  assertObject(value)
  assertExactKeys(value, OPEN_DISCLOSURE_KEYS)

  const obj = value as Record<string, unknown>
  if (obj.schema_version !== 1) invalid('schema_version must be 1')
  assertId(obj.disclosure_id, 'disclosure_')
  assertId(obj.retrieval_id, 'retrieval_')
  assertHash(obj.parent_disclosure_sha256)
  assertHash(obj.project_scope_id)
  assertHash(obj.session_scope_id)
  const generation_ref = validateGenerationRef(obj.generation_ref)
  if (obj.level !== 3) invalid('open disclosure level must be 3')
  const memory_ref = validateMemoryRef(obj.memory_ref)

  assertString(obj.title, 256)
  if (obj.title.length === 0) invalid('title cannot be empty')
  assertString(obj.summary, 2048)
  if (obj.summary.length === 0) invalid('summary cannot be empty')

  if (obj.component !== null) {
    assertComponentSlug(obj.component)
  }

  assertArray(obj.tags, 32)
  const tags: string[] = []
  for (const t of obj.tags) {
    assertTag(t)
    tags.push(t)
  }
  assertNoDuplicate(tags)
  const sortedTags = [...tags].sort(compareCodePoints)
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] !== sortedTags[i]) {
      invalid('tags must be sorted by codepoints')
    }
  }

  assertString(obj.body, 1_000_000)
  if (obj.body.length === 0) invalid('body cannot be empty')

  // Validate deterministic open disclosure_id
  const expectedDisclosureId = computeOpenDisclosureId({
    retrieval_id: obj.retrieval_id as string,
    parent_disclosure_sha256: obj.parent_disclosure_sha256 as string,
    project_scope_id: obj.project_scope_id as string,
    session_scope_id: obj.session_scope_id as string,
    generation_ref,
    memory_ref,
  })
  if (obj.disclosure_id !== expectedDisclosureId) {
    invalid('disclosure_id mismatch')
  }

  // Strict Hash verification
  const resultWithoutHash = withoutHash(obj)
  const expectedSha = canonicalHash(resultWithoutHash)

  if (typeof obj.content_sha256 !== 'string' || obj.content_sha256.length === 0) {
    invalid('missing or invalid content_sha256')
  }
  assertHash(obj.content_sha256)
  if (obj.content_sha256 !== expectedSha) {
    invalid('open disclosure content_sha256 mismatch')
  }

  return Object.freeze({
    schema_version: 1,
    disclosure_id: obj.disclosure_id,
    retrieval_id: obj.retrieval_id,
    parent_disclosure_sha256: obj.parent_disclosure_sha256,
    project_scope_id: obj.project_scope_id,
    session_scope_id: obj.session_scope_id,
    generation_ref,
    level: 3,
    memory_ref,
    title: obj.title,
    summary: obj.summary,
    component: obj.component,
    tags: Object.freeze(sortedTags),
    body: obj.body,
    content_sha256: expectedSha,
  })
}

export function canonicalizeOpenDisclosure(value: unknown): string {
  assertObject(value)
  const obj = { ...value } as Record<string, unknown>
  delete obj.content_sha256

  if (
    typeof obj.retrieval_id === 'string' &&
    typeof obj.parent_disclosure_sha256 === 'string' &&
    typeof obj.project_scope_id === 'string' &&
    typeof obj.session_scope_id === 'string' &&
    obj.generation_ref &&
    obj.memory_ref
  ) {
    const generation_ref = validateGenerationRef(obj.generation_ref)
    const memory_ref = validateMemoryRef(obj.memory_ref)
    obj.disclosure_id = computeOpenDisclosureId({
      retrieval_id: obj.retrieval_id,
      parent_disclosure_sha256: obj.parent_disclosure_sha256,
      project_scope_id: obj.project_scope_id,
      session_scope_id: obj.session_scope_id,
      generation_ref,
      memory_ref,
    })
  }

  const content_sha256 = canonicalHash(obj)
  const complete = { ...obj, content_sha256 }
  const validated = validateOpenDisclosure(complete)
  return canonicalBytes(validated)
}

/* ==========================================================================
 * 7. Status v3
 * ========================================================================== */

export type ScopeReason =
  | 'missing_agent'
  | 'invalid_session_id'
  | 'missing_project_root'
  | 'invalid_project_root'
  | 'agent_session_identity_mismatch'
  | 'session_scope_conflict'
  | 'runtime_disposed'

const VALID_SCOPE_REASONS = new Set<ScopeReason>([
  'missing_agent',
  'invalid_session_id',
  'missing_project_root',
  'invalid_project_root',
  'agent_session_identity_mismatch',
  'session_scope_conflict',
  'runtime_disposed',
])

export type MemoryAvailability = 'ready' | 'empty' | 'unavailable' | 'invalid'

export interface StatusV3ScopePayload {
  status: 'ready' | 'unavailable' | 'conflict'
  source: 'session_header' | 'explicit_config' | 'none'
  project_scope_id: string | null
  session_scope_id: string | null
  reason: ScopeReason | null
}

export interface StatusV3MemoryPayload {
  availability: MemoryAvailability
  generation_id: string | null
  short_term_count: number
  long_term_count: number
  total_count: number
  reason: string | null
}

export interface StatusV3Output {
  plugin: 'dsh-Mnemosyne'
  version: '0.0.0-dev'
  protocol_version: 3
  memory_enabled: true
  status: 'ready'
  scope: StatusV3ScopePayload
  memory: StatusV3MemoryPayload
}

const STATUS_V3_SCOPE_KEYS = [
  'status',
  'source',
  'project_scope_id',
  'session_scope_id',
  'reason',
] as const

const STATUS_V3_MEMORY_KEYS = [
  'availability',
  'generation_id',
  'short_term_count',
  'long_term_count',
  'total_count',
  'reason',
] as const

const STATUS_V3_KEYS = [
  'plugin',
  'version',
  'protocol_version',
  'memory_enabled',
  'status',
  'scope',
  'memory',
] as const

export function validateStatusV3Output(value: unknown): StatusV3Output {
  assertObject(value)
  assertExactKeys(value, STATUS_V3_KEYS)

  const obj = value as Record<string, unknown>
  if (obj.plugin !== 'dsh-Mnemosyne') invalid('plugin must be dsh-Mnemosyne')
  if (obj.version !== '0.0.0-dev') invalid('version must be 0.0.0-dev')
  if (obj.protocol_version !== 3) invalid('protocol_version must be 3')
  if (obj.memory_enabled !== true) invalid('memory_enabled must be true')
  if (obj.status !== 'ready') invalid('status must be ready')

  // Validate scope
  assertObject(obj.scope)
  assertExactKeys(obj.scope, STATUS_V3_SCOPE_KEYS)
  const scopeObj = obj.scope as Record<string, unknown>

  if (scopeObj.status === 'ready') {
    if (scopeObj.source !== 'session_header' && scopeObj.source !== 'explicit_config') {
      invalid('ready scope must have session_header or explicit_config source')
    }
    if (scopeObj.project_scope_id === null || scopeObj.session_scope_id === null) {
      invalid('ready scope must have non-null scope ids')
    }
    assertHash(scopeObj.project_scope_id)
    assertHash(scopeObj.session_scope_id)
    if (scopeObj.reason !== null) {
      invalid('ready scope must have null reason')
    }
  } else if (scopeObj.status === 'unavailable' || scopeObj.status === 'conflict') {
    if (scopeObj.source !== 'none') {
      invalid('non-ready scope must have none source')
    }
    if (scopeObj.project_scope_id !== null || scopeObj.session_scope_id !== null) {
      invalid('non-ready scope must have null scope ids')
    }
    if (typeof scopeObj.reason !== 'string' || !VALID_SCOPE_REASONS.has(scopeObj.reason as ScopeReason)) {
      invalid('non-ready scope must have valid scope reason')
    }
  } else {
    invalid('invalid scope status')
  }

  // Validate memory
  assertObject(obj.memory)
  assertExactKeys(obj.memory, STATUS_V3_MEMORY_KEYS)
  const memObj = obj.memory as Record<string, unknown>

  assertInteger(memObj.short_term_count, 0)
  assertInteger(memObj.long_term_count, 0)
  assertInteger(memObj.total_count, 0)
  if (memObj.total_count !== memObj.short_term_count + memObj.long_term_count) {
    invalid('total_count must equal short_term_count + long_term_count')
  }

  if (memObj.availability === 'ready') {
    if (memObj.generation_id === null) {
      invalid('ready memory must have non-null generation_id')
    }
    assertId(memObj.generation_id, 'gen_')
    if (memObj.reason !== null) {
      invalid('ready memory must have null reason')
    }
  } else if (memObj.availability === 'empty') {
    if (memObj.generation_id !== null) {
      invalid('empty memory must have null generation_id')
    }
    if (memObj.short_term_count !== 0 || memObj.long_term_count !== 0 || memObj.total_count !== 0) {
      invalid('empty memory must have zero counts')
    }
    if (memObj.reason !== null) {
      invalid('empty memory must have null reason')
    }
  } else if (memObj.availability === 'invalid') {
    if (memObj.generation_id !== null) {
      invalid('invalid memory must have null generation_id')
    }
    if (memObj.short_term_count !== 0 || memObj.long_term_count !== 0 || memObj.total_count !== 0) {
      invalid('invalid memory must have zero counts')
    }
    if (
      typeof memObj.reason !== 'string' ||
      (!isMemoryStoreErrorCode(memObj.reason) && memObj.reason !== 'generation_invalid')
    ) {
      invalid('invalid memory must have valid error reason')
    }
  } else if (memObj.availability === 'unavailable') {
    if (memObj.generation_id !== null) {
      invalid('unavailable memory must have null generation_id')
    }
    if (memObj.short_term_count !== 0 || memObj.long_term_count !== 0 || memObj.total_count !== 0) {
      invalid('unavailable memory must have zero counts')
    }
    if (
      typeof memObj.reason !== 'string' ||
      !VALID_SCOPE_REASONS.has(memObj.reason as ScopeReason)
    ) {
      invalid('unavailable memory must have valid scope reason')
    }
  } else {
    invalid('invalid memory availability')
  }

  // Cross-state invariant coupling
  if (scopeObj.status !== 'ready') {
    if (memObj.availability !== 'unavailable') {
      invalid('non-ready scope requires unavailable memory')
    }
    if (memObj.reason !== scopeObj.reason) {
      invalid('unavailable memory reason must match scope reason')
    }
  } else {
    if (memObj.availability === 'unavailable') {
      invalid('ready scope cannot have unavailable memory')
    }
  }

  return Object.freeze({
    plugin: 'dsh-Mnemosyne',
    version: '0.0.0-dev',
    protocol_version: 3,
    memory_enabled: true,
    status: 'ready',
    scope: Object.freeze({
      status: scopeObj.status as 'ready' | 'unavailable' | 'conflict',
      source: scopeObj.source as 'session_header' | 'explicit_config' | 'none',
      project_scope_id: scopeObj.project_scope_id as string | null,
      session_scope_id: scopeObj.session_scope_id as string | null,
      reason: scopeObj.reason as ScopeReason | null,
    }),
    memory: Object.freeze({
      availability: memObj.availability as MemoryAvailability,
      generation_id: memObj.generation_id as string | null,
      short_term_count: memObj.short_term_count,
      long_term_count: memObj.long_term_count,
      total_count: memObj.total_count,
      reason: memObj.reason as string | null,
    }),
  })
}

export function canonicalizeStatusV3Output(value: StatusV3Output): string {
  const validated = validateStatusV3Output(value)
  return canonicalBytes(validated)
}
