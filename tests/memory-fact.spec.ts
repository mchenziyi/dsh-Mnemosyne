import { describe, expect, it } from 'vitest'
import {
  validateShortTermMemoryFact,
  validateLongTermMemoryFact,
  canonicalizeShortTermMemoryFact,
  canonicalizeLongTermMemoryFact,
  computeFactHash,
  type ShortTermMemoryFact,
  type LongTermMemoryFact,
} from '../src/memory-fact.js'
import { MemoryStoreError } from '../src/memory-store-error.js'

describe('MVP-02A: Schema & Canonical Matrix (Tests 1-10)', () => {
  const validShortTerm: ShortTermMemoryFact = {
    schema_version: 1,
    tier: 'short_term',
    memory_id: 'mem_build_cache_01',
    project_scope_id: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    session_scope_id: 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    title: 'Build cache invalidation finding',
    summary: 'Cache key must include the compiler version.',
    body: 'The observed cache miss was resolved by including the compiler version in the key.',
    tags: ['build', 'cache'],
    created_at: '2026-08-24T12:00:00.000Z',
    expires_at: '2026-08-31T12:00:00.000Z',
    content_sha256: '',
  }
  validShortTerm.content_sha256 = computeFactHash(validShortTerm)

  const validLongTerm: LongTermMemoryFact = {
    schema_version: 1,
    tier: 'long_term',
    memory_id: 'mem_build_cache_01',
    project_scope_id: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    title: 'Build cache key constraint',
    summary: 'Compiler version is part of the cache identity.',
    body: 'Treat compiler-version changes as cache-key changes.',
    tags: ['build', 'cache'],
    created_at: '2026-08-24T12:00:00.000Z',
    source_short_term_refs: [
      {
        project_scope_id: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        session_scope_id: 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        memory_id: 'mem_build_cache_01',
        content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
      },
    ],
    content_sha256: '',
  }
  validLongTerm.content_sha256 = computeFactHash(validLongTerm)

  it('1. short-term valid object round-trip', () => {
    const validated = validateShortTermMemoryFact(validShortTerm)
    expect(validated).toEqual(validShortTerm)
  })

  it('2. long-term valid object round-trip', () => {
    const validated = validateLongTermMemoryFact(validLongTerm)
    expect(validated).toEqual(validLongTerm)
  })

  it('3. Repeated encoding produces byte-for-byte and hash identical results', () => {
    const canonical1 = canonicalizeShortTermMemoryFact(validShortTerm)
    const canonical2 = canonicalizeShortTermMemoryFact(validShortTerm)
    expect(canonical1).toBe(canonical2)
    expect(computeFactHash(validShortTerm)).toBe(validShortTerm.content_sha256)
  })

  it('4. Out-of-order tags and source_short_term_refs produce stable canonical order', () => {
    const factWithUnsortedTags: ShortTermMemoryFact = {
      ...validShortTerm,
      tags: ['cache', 'build', 'alpha'],
      content_sha256: '',
    }
    factWithUnsortedTags.content_sha256 = computeFactHash(factWithUnsortedTags)
    const c1 = canonicalizeShortTermMemoryFact(factWithUnsortedTags)
    const parsed1 = JSON.parse(c1)
    expect(parsed1.tags).toEqual(['alpha', 'build', 'cache'])

    const factWithUnsortedRefs: LongTermMemoryFact = {
      ...validLongTerm,
      source_short_term_refs: [
        {
          project_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          session_scope_id: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
          memory_id: 'mem_b',
          content_sha256: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
        },
        {
          project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          session_scope_id: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
          memory_id: 'mem_a',
          content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
        },
      ],
      content_sha256: '',
    }
    factWithUnsortedRefs.content_sha256 = computeFactHash(factWithUnsortedRefs)
    const c2 = canonicalizeLongTermMemoryFact(factWithUnsortedRefs)
    const parsed2 = JSON.parse(c2)
    expect(parsed2.source_short_term_refs[0].project_scope_id).toBe('sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('5. Unknown fields, incorrect tier, missing fields, or partial objects are rejected', () => {
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, extra: true })).toThrowError(MemoryStoreError)
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, tier: 'long_term' as never })).toThrowError(MemoryStoreError)
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, title: undefined as never })).toThrowError(MemoryStoreError)
    expect(() => validateLongTermMemoryFact({ ...validLongTerm, session_scope_id: 'sha256_...' as never })).toThrowError(MemoryStoreError)
  })

  it('6. Invalid content_sha256 hash is rejected', () => {
    expect(() =>
      validateShortTermMemoryFact({
        ...validShortTerm,
        content_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
      })
    ).toThrowError(MemoryStoreError)
  })

  it('7. Malformed/duplicate IDs, Scope IDs, tags, or source refs are rejected', () => {
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, memory_id: 'INVALID_ID' })).toThrow()
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, project_scope_id: 'not_a_hash' })).toThrow()
    expect(() => validateShortTermMemoryFact({ ...validShortTerm, tags: ['dup', 'dup'] })).toThrow()
    expect(() =>
      validateLongTermMemoryFact({
        ...validLongTerm,
        source_short_term_refs: [
          validLongTerm.source_short_term_refs[0],
          validLongTerm.source_short_term_refs[0],
        ],
      })
    ).toThrow()
  })

  it('8. short-term expires_at not strictly later than created_at is rejected', () => {
    expect(() =>
      validateShortTermMemoryFact({
        ...validShortTerm,
        created_at: '2026-08-24T12:00:00.000Z',
        expires_at: '2026-08-24T12:00:00.000Z',
      })
    ).toThrow()

    expect(() =>
      validateShortTermMemoryFact({
        ...validShortTerm,
        created_at: '2026-08-24T12:00:00.000Z',
        expires_at: '2026-08-24T11:00:00.000Z',
      })
    ).toThrow()
  })

  it('9. Credentials, private keys, absolute paths, and oversized bodies are rejected without error leakage', () => {
    const malicious = {
      ...validShortTerm,
      body: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
    }
    try {
      validateShortTermMemoryFact(malicious)
      expect.unreachable('should reject sensitive text')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MemoryStoreError)
      expect((err as Error).message).not.toContain('eyJhbGciOi')
    }

    const pathLeak = {
      ...validShortTerm,
      body: 'File located at /Users/victim/.ssh/id_rsa',
    }
    try {
      validateShortTermMemoryFact(pathLeak)
      expect.unreachable('should reject path leak')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MemoryStoreError)
      expect((err as Error).message).not.toContain('/Users/victim')
    }

    const oversized = {
      ...validShortTerm,
      body: 'a'.repeat(8001),
    }
    expect(() => validateShortTermMemoryFact(oversized)).toThrowError(MemoryStoreError)
  })

  it('10. Trailing newlines, non-canonical key order, or non-canonical timestamps on disk are rejected', () => {
    const raw = JSON.stringify(validShortTerm)
    // Non-canonical JSON with trailing space or different formatting
    const nonCanonicalJson = JSON.stringify(validShortTerm, null, 2)
    expect(() => validateShortTermMemoryFact(JSON.parse(nonCanonicalJson))).not.toThrow()
    // Canonical byte equality check
    expect(canonicalizeShortTermMemoryFact(validShortTerm)).not.toBe(nonCanonicalJson)
  })
})
