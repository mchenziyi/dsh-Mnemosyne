import {
  assertExactKeys,
  assertHash,
  assertId,
  assertInteger,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
  sortedUnique,
  withoutHash,
} from '../protocol/canonical.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { MemoryStoreError } from '../memory-store-error.js'

export interface OKFMemoryV2 {
  schema_version: 2
  memory_id: string
  project_scope_id: string
  title: string
  summary: string
  content: string
  related_memory_refs: string[]
  created_at: string
  content_sha256: string
}

const KEYS = [
  'schema_version',
  'memory_id',
  'project_scope_id',
  'title',
  'summary',
  'content',
  'related_memory_refs',
  'created_at',
  'content_sha256',
] as const

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  return value
}

function normalize(raw: unknown, requireHash: boolean): OKFMemoryV2 {
  try {
    assertExactKeys(raw, KEYS)
    assertInteger(raw.schema_version, 2, 2)
    assertId(raw.memory_id, 'mem_')
    assertHash(raw.project_scope_id)
    assertUtcTimestamp(raw.created_at)
    if (requireHash) assertHash(raw.content_sha256)
    if (!Array.isArray(raw.related_memory_refs) || raw.related_memory_refs.length > 32) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    for (const ref of raw.related_memory_refs) assertId(ref, 'mem_')
    const refs = sortedUnique(raw.related_memory_refs as string[])
    if (refs.includes(raw.memory_id as string)) throw new MemoryStoreError('memory_store_invalid_input')

    return {
      schema_version: 2,
      memory_id: raw.memory_id as string,
      project_scope_id: raw.project_scope_id as string,
      title: text(raw.title, 320),
      summary: text(raw.summary, 2000),
      content: text(raw.content, 65536),
      related_memory_refs: refs,
      created_at: raw.created_at as string,
      content_sha256: raw.content_sha256 as string,
    }
  } catch (error: unknown) {
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_store_invalid_input', error)
  }
}

export function computeOKFMemoryV2Hash(raw: OKFMemoryV2): string {
  const normalized = normalize(raw, false)
  return canonicalHash(withoutHash(normalized as unknown as Record<string, unknown>))
}

export function validateOKFMemoryV2(raw: unknown): OKFMemoryV2 {
  const normalized = normalize(raw, true)
  if (normalized.content_sha256 !== computeOKFMemoryV2Hash(normalized)) {
    throw new MemoryStoreError('memory_store_hash_mismatch')
  }
  return normalized
}

export function canonicalizeOKFMemoryV2(raw: unknown): string {
  return canonicalBytes(validateOKFMemoryV2(raw))
}

export function compareOKFMemories(left: OKFMemoryV2, right: OKFMemoryV2): number {
  return compareCodePoints(left.memory_id, right.memory_id)
}
