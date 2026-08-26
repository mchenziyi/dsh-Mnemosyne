import {
  assertExactKeys,
  assertHash,
  assertId,
  assertInteger,
  assertSafeText,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
  containsSensitiveText,
  withoutHash,
} from './protocol/canonical.js'
import { MemoryStoreError } from './memory-store-error.js'

export interface ShortTermMemoryFact {
  schema_version: 1
  tier: 'short_term'
  memory_id: string
  project_scope_id: string
  session_scope_id: string
  title: string
  summary: string
  body: string
  tags: string[]
  created_at: string
  expires_at: string
  content_sha256: string
}

export interface SourceShortTermRef {
  project_scope_id: string
  session_scope_id: string
  memory_id: string
  content_sha256: string
}

export type ShortTermSourceRef = SourceShortTermRef

export interface LongTermMemoryFact {
  schema_version: 1
  tier: 'long_term'
  memory_id: string
  project_scope_id: string
  title: string
  summary: string
  body: string
  tags: string[]
  created_at: string
  source_short_term_refs: SourceShortTermRef[]
  content_sha256: string
}

export type MemoryFact = ShortTermMemoryFact | LongTermMemoryFact

const SHORT_TERM_KEYS = [
  'schema_version',
  'tier',
  'memory_id',
  'project_scope_id',
  'session_scope_id',
  'title',
  'summary',
  'body',
  'tags',
  'created_at',
  'expires_at',
  'content_sha256',
] as const

const LONG_TERM_KEYS = [
  'schema_version',
  'tier',
  'memory_id',
  'project_scope_id',
  'title',
  'summary',
  'body',
  'tags',
  'created_at',
  'source_short_term_refs',
  'content_sha256',
] as const

const SOURCE_REF_KEYS = [
  'project_scope_id',
  'session_scope_id',
  'memory_id',
  'content_sha256',
] as const

const TAG_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/
const RFC3339_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isValidIsoUtc(val: unknown): val is string {
  if (typeof val !== 'string' || !RFC3339_UTC_REGEX.test(val)) return false
  const time = Date.parse(val)
  if (Number.isNaN(time)) return false
  return new Date(time).toISOString() === val
}

export function assertUtcTimestamp(val: unknown): asserts val is string {
  if (!isValidIsoUtc(val)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
}

export function validateTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags) || rawTags.length > 16) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  const seen = new Set<string>()
  for (let i = 0; i < rawTags.length; i++) {
    const t = rawTags[i]
    if (typeof t !== 'string' || !TAG_REGEX.test(t) || seen.has(t)) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    seen.add(t)
  }
  return [...rawTags].sort(compareCodePoints)
}

export function compareSourceRefs(a: SourceShortTermRef, b: SourceShortTermRef): number {
  let delta = compareCodePoints(a.project_scope_id, b.project_scope_id)
  if (delta !== 0) return delta
  delta = compareCodePoints(a.session_scope_id, b.session_scope_id)
  if (delta !== 0) return delta
  delta = compareCodePoints(a.memory_id, b.memory_id)
  if (delta !== 0) return delta
  return compareCodePoints(a.content_sha256, b.content_sha256)
}

export function validateSourceRefs(rawRefs: unknown): SourceShortTermRef[] {
  if (!Array.isArray(rawRefs) || rawRefs.length > 16) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  const seen = new Set<string>()
  const parsedRefs: SourceShortTermRef[] = []

  for (let i = 0; i < rawRefs.length; i++) {
    const r = rawRefs[i]
    try {
      assertExactKeys(r, SOURCE_REF_KEYS)
      assertHash(r.project_scope_id)
      assertHash(r.session_scope_id)
      assertId(r.memory_id, 'mem_')
      assertHash(r.content_sha256)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_store_invalid_input', err)
    }

    const key = `${r.project_scope_id}:${r.session_scope_id}:${r.memory_id}:${r.content_sha256}`
    if (seen.has(key)) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    seen.add(key)
    parsedRefs.push({
      project_scope_id: r.project_scope_id as string,
      session_scope_id: r.session_scope_id as string,
      memory_id: r.memory_id as string,
      content_sha256: r.content_sha256 as string,
    })
  }

  return parsedRefs.sort(compareSourceRefs)
}

export function computeFactHash(fact: MemoryFact | Record<string, unknown>): string {
  const copy: Record<string, unknown> = withoutHash(fact as Record<string, unknown>, 'content_sha256')
  if (Array.isArray(copy.tags)) {
    copy.tags = [...copy.tags].sort(compareCodePoints)
  }
  if (Array.isArray(copy.source_short_term_refs)) {
    copy.source_short_term_refs = [...(copy.source_short_term_refs as SourceShortTermRef[])].sort(compareSourceRefs)
  }
  return canonicalHash(copy)
}

export function validateShortTermMemoryFact(raw: unknown): ShortTermMemoryFact {
  try {
    assertExactKeys(raw, SHORT_TERM_KEYS)
    assertInteger(raw.schema_version, 1, 1)
    if (raw.tier !== 'short_term') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    assertId(raw.memory_id, 'mem_')
    assertHash(raw.project_scope_id)
    assertHash(raw.session_scope_id)
    assertSafeText(raw.title, 160)
    assertSafeText(raw.summary, 500)
    assertSafeText(raw.body, 8000)
    assertUtcTimestamp(raw.created_at)
    assertUtcTimestamp(raw.expires_at)
    assertHash(raw.content_sha256)

    if (Date.parse(raw.expires_at as string) <= Date.parse(raw.created_at as string)) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }

    const tags = validateTags(raw.tags)

    const normalized: ShortTermMemoryFact = {
      schema_version: 1,
      tier: 'short_term',
      memory_id: raw.memory_id as string,
      project_scope_id: raw.project_scope_id as string,
      session_scope_id: raw.session_scope_id as string,
      title: raw.title as string,
      summary: raw.summary as string,
      body: raw.body as string,
      tags,
      created_at: raw.created_at as string,
      expires_at: raw.expires_at as string,
      content_sha256: raw.content_sha256 as string,
    }

    const expectedHash = computeFactHash(normalized as unknown as Record<string, unknown>)
    if (raw.content_sha256 && raw.content_sha256 !== expectedHash) {
      throw new MemoryStoreError('memory_store_hash_mismatch')
    }

    return normalized
  } catch (err: unknown) {
    if (err instanceof MemoryStoreError) throw err
    throw new MemoryStoreError('memory_store_invalid_input', err)
  }
}

export function validateLongTermMemoryFact(raw: unknown): LongTermMemoryFact {
  try {
    assertExactKeys(raw, LONG_TERM_KEYS)
    assertInteger(raw.schema_version, 1, 1)
    if (raw.tier !== 'long_term') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    assertId(raw.memory_id, 'mem_')
    assertHash(raw.project_scope_id)
    assertSafeText(raw.title, 160)
    assertSafeText(raw.summary, 500)
    assertSafeText(raw.body, 8000)
    assertUtcTimestamp(raw.created_at)
    assertHash(raw.content_sha256)

    const tags = validateTags(raw.tags)
    const source_short_term_refs = validateSourceRefs(raw.source_short_term_refs)

    const normalized: LongTermMemoryFact = {
      schema_version: 1,
      tier: 'long_term',
      memory_id: raw.memory_id as string,
      project_scope_id: raw.project_scope_id as string,
      title: raw.title as string,
      summary: raw.summary as string,
      body: raw.body as string,
      tags,
      created_at: raw.created_at as string,
      source_short_term_refs,
      content_sha256: raw.content_sha256 as string,
    }

    const expectedHash = computeFactHash(normalized as unknown as Record<string, unknown>)
    if (raw.content_sha256 && raw.content_sha256 !== expectedHash) {
      throw new MemoryStoreError('memory_store_hash_mismatch')
    }

    return normalized
  } catch (err: unknown) {
    if (err instanceof MemoryStoreError) throw err
    throw new MemoryStoreError('memory_store_invalid_input', err)
  }
}

export function canonicalizeShortTermMemoryFact(fact: ShortTermMemoryFact): string {
  const validated = validateShortTermMemoryFact(fact)
  return canonicalBytes(validated)
}

export function canonicalizeLongTermMemoryFact(fact: LongTermMemoryFact): string {
  const validated = validateLongTermMemoryFact(fact)
  return canonicalBytes(validated)
}
