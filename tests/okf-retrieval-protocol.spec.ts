import { describe, expect, it } from 'vitest'
import { canonicalHash, withoutHash } from '../src/protocol/canonical.js'
import {
  validateGenerationRef,
  canonicalizeGenerationRef,
  validateSearchInput,
  validateMemoryRef,
  canonicalizeMemoryRef,
  validateSearchDisclosure,
  canonicalizeSearchDisclosure,
  validateOpenInput,
  validateOpenDisclosure,
  canonicalizeOpenDisclosure,
  validateStatusV3Output,
  canonicalizeStatusV3Output,
  computeRetrievalId,
  computeSearchDisclosureId,
  computeOpenDisclosureId,
  type OKFGenerationRef,
  type OKFSearchInput,
  type OKFMemoryRef,
  type OKFSearchDisclosure,
  type OKFOpenInput,
  type OKFOpenDisclosure,
  type StatusV3Output,
  type StatusV3ScopePayload,
  type StatusV3MemoryPayload,
} from '../src/protocol/okf-retrieval.js'

describe('MVP-04A: OKF Retrieval Protocol & Disclosure Schemas', () => {
  const sampleGenRef: OKFGenerationRef = {
    generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    generation_sha256: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    manifest_id: 'manifest_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    manifest_sha256: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    index_sha256: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  }

  const sampleShortMemoryRef: OKFMemoryRef = {
    tier: 'short_term',
    session_scope_id: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
    memory_id: 'mem_short_01',
    content_sha256: 'sha256_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    page_ref: 'wiki/memories/mem_short_01.md',
  }

  const sampleLongMemoryRef: OKFMemoryRef = {
    tier: 'long_term',
    session_scope_id: null,
    memory_id: 'mem_long_01',
    content_sha256: 'sha256_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    page_ref: 'wiki/memories/mem_long_01.md',
  }

  it('1. OKFGenerationRef validates and canonicalizes correctly', () => {
    const valid = validateGenerationRef(sampleGenRef)
    expect(valid).toEqual(sampleGenRef)

    const canonical = canonicalizeGenerationRef(valid)
    expect(typeof canonical).toBe('string')
    expect(JSON.parse(canonical)).toEqual(sampleGenRef)

    // Rejects unknown fields
    expect(() => validateGenerationRef({ ...sampleGenRef, extra: 'forbidden' })).toThrow()
    // Rejects invalid SHA256 format
    expect(() => validateGenerationRef({ ...sampleGenRef, index_sha256: 'invalid_sha' })).toThrow()
    // Rejects invalid generation_id prefix
    expect(() => validateGenerationRef({ ...sampleGenRef, generation_id: 'invalid_id' })).toThrow()
  })

  it('2. OKFSearchInput validates query, component_hint and top_k correctly', () => {
    const valid = validateSearchInput({
      query: '  compiler cache rebuild  ',
      component_hint: 'build-system',
      top_k: 3,
    })
    expect(valid.query).toBe('compiler cache rebuild')
    expect(valid.component_hint).toBe('build-system')
    expect(valid.top_k).toBe(3)

    // Default top_k is 5
    const defaultTopK = validateSearchInput({ query: 'hello' })
    expect(defaultTopK.top_k).toBe(5)
    expect(defaultTopK.component_hint).toBeNull()

    // Rejects empty or whitespace-only query
    expect(() => validateSearchInput({ query: '   ' })).toThrow()
    // Rejects control characters in query
    expect(() => validateSearchInput({ query: 'bad\u0000query' })).toThrow()
    // Rejects query > 500 chars
    expect(() => validateSearchInput({ query: 'a'.repeat(501) })).toThrow()
    // Rejects invalid component_hint slug
    expect(() => validateSearchInput({ query: 'ok', component_hint: 'INVALID_SLUG!' })).toThrow()
    // Rejects top_k out of 1..5 range
    expect(() => validateSearchInput({ query: 'ok', top_k: 0 })).toThrow()
    expect(() => validateSearchInput({ query: 'ok', top_k: 6 })).toThrow()
    // Rejects operation_hint (forbidden in production MVP-04)
    expect(() => validateSearchInput({ query: 'ok', operation_hint: 'lookup' })).toThrow()
  })

  it('3. OKFMemoryRef validates short-term and long-term invariants', () => {
    expect(validateMemoryRef(sampleShortMemoryRef)).toEqual(sampleShortMemoryRef)
    expect(validateMemoryRef(sampleLongMemoryRef)).toEqual(sampleLongMemoryRef)

    // Short term must have session_scope_id
    expect(() => validateMemoryRef({ ...sampleShortMemoryRef, session_scope_id: null })).toThrow()
    // Long term must have session_scope_id === null
    expect(() => validateMemoryRef({ ...sampleLongMemoryRef, session_scope_id: 'sha256_1111' })).toThrow()
    // page_ref must match wiki/memories/<memory_id>.md
    expect(() => validateMemoryRef({ ...sampleShortMemoryRef, page_ref: 'wiki/wrong.md' })).toThrow()
  })

  it('4. OKFSearchDisclosure validates and canonicalizes with content_sha256 roundtrip', () => {
    const rawDisclosure: OKFSearchDisclosure = {
      schema_version: 1,
      disclosure_id: 'disclosure_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
      retrieval_id: 'retrieval_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      level: 2,
      result_count: 2,
      items: [
        {
          memory_ref: sampleShortMemoryRef,
          title: 'Title 1',
          summary: 'Summary 1',
          component: null,
          tags: ['alpha', 'beta'],
          score_fixed: 17000,
          rank: 1,
        },
        {
          memory_ref: sampleLongMemoryRef,
          title: 'Title 2',
          summary: 'Summary 2',
          component: 'core',
          tags: ['gamma'],
          score_fixed: 9000,
          rank: 2,
        },
      ],
      content_sha256: '',
    }

    const canonical = canonicalizeSearchDisclosure(rawDisclosure)
    const parsed = JSON.parse(canonical)
    expect(parsed.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(parsed.level).toBe(2)
    expect(parsed.result_count).toBe(2)

    // Validating parsed succeeds
    const validated = validateSearchDisclosure(parsed)
    expect(validated.content_sha256).toBe(parsed.content_sha256)

    // Rejects body in items or disclosure
    expect(() => validateSearchDisclosure({ ...parsed, body: 'forbidden' })).toThrow()
    expect(() => validateSearchDisclosure({ ...parsed, items: [{ ...parsed.items[0], body: 'forbidden' }] })).toThrow()

    // Rejects rank breakage (e.g. rank 1, rank 3)
    const brokenRank = { ...parsed, items: [{ ...parsed.items[0], rank: 1 }, { ...parsed.items[1], rank: 3 }] }
    brokenRank.content_sha256 = ''
    expect(() => validateSearchDisclosure(brokenRank)).toThrow()

    // Rejects score non-decreasing violation (e.g. 9000 followed by 17000)
    const brokenScore = { ...parsed, items: [{ ...parsed.items[0], score_fixed: 5000 }, { ...parsed.items[1], score_fixed: 9000 }] }
    brokenScore.content_sha256 = ''
    expect(() => validateSearchDisclosure(brokenScore)).toThrow()
  })

  it('5. OKFSearchDisclosure supports empty generation (null generation_ref) when no CURRENT', () => {
    const emptyDisclosure: OKFSearchDisclosure = {
      schema_version: 1,
      disclosure_id: 'disclosure_0000000000000000000000000000000000000000000000000000000000000000',
      retrieval_id: 'retrieval_0000000000000000000000000000000000000000000000000000000000000000',
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: null,
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      level: 2,
      result_count: 0,
      items: [],
      content_sha256: '',
    }

    const canonical = canonicalizeSearchDisclosure(emptyDisclosure)
    const validated = validateSearchDisclosure(JSON.parse(canonical))
    expect(validated.generation_ref).toBeNull()
    expect(validated.result_count).toBe(0)
    expect(validated.items).toEqual([])
  })

  it('6. OKFOpenInput and OKFOpenDisclosure validate and canonicalize correctly', () => {
    const validInput = validateOpenInput({
      retrieval_id: 'retrieval_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
      search_disclosure_sha256: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      memory_id: 'mem_target_01',
    })
    expect(validInput.memory_id).toBe('mem_target_01')

    const rawOpenDisclosure: OKFOpenDisclosure = {
      schema_version: 1,
      disclosure_id: 'disclosure_222233334444555566667777888899990000aaaabbbbccccddddeeeeffff1111',
      retrieval_id: validInput.retrieval_id,
      parent_disclosure_sha256: validInput.search_disclosure_sha256,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      level: 3,
      memory_ref: sampleShortMemoryRef,
      title: 'Detailed Title',
      summary: 'Detailed Summary',
      component: null,
      tags: ['cache'],
      body: 'Full content of memory text here.',
      content_sha256: '',
    }

    const canonical = canonicalizeOpenDisclosure(rawOpenDisclosure)
    const parsed = JSON.parse(canonical)
    expect(parsed.level).toBe(3)
    expect(parsed.body).toBe('Full content of memory text here.')
    expect(parsed.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)

    const validated = validateOpenDisclosure(parsed)
    expect(validated.content_sha256).toBe(parsed.content_sha256)

    // Rejects unknown fields
    expect(() => validateOpenDisclosure({ ...parsed, extra: 'bad' })).toThrow()
  })

  it('7. Status v3 schema validates ready, empty, unavailable and invalid states', () => {
    const readyStatus: StatusV3Output = {
      plugin: 'dsh-Mnemosyne',
      version: '0.1.0',
      protocol_version: 3,
      memory_enabled: true,
      status: 'ready',
      scope: {
        status: 'ready',
        source: 'session_header',
        project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        reason: null,
      },
      memory: {
        availability: 'ready',
        generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        short_term_count: 2,
        long_term_count: 3,
        total_count: 5,
        reason: null,
      },
    }

    const canonical = canonicalizeStatusV3Output(readyStatus)
    const validated = validateStatusV3Output(JSON.parse(canonical))
    expect(validated.protocol_version).toBe(3)
    expect(validated.memory.availability).toBe('ready')
    expect(validated.memory.total_count).toBe(5)

    // Empty state
    const emptyStatus: StatusV3Output = {
      ...readyStatus,
      memory: {
        availability: 'empty',
        generation_id: null,
        short_term_count: 0,
        long_term_count: 0,
        total_count: 0,
        reason: null,
      },
    }
    expect(validateStatusV3Output(emptyStatus).memory.availability).toBe('empty')

    // Invalid/corrupted state
    const invalidStatus: StatusV3Output = {
      ...readyStatus,
      memory: {
        availability: 'invalid',
        generation_id: null,
        short_term_count: 0,
        long_term_count: 0,
        total_count: 0,
        reason: 'generation_invalid',
      },
    }
    expect(validateStatusV3Output(invalidStatus).memory.availability).toBe('invalid')

    // Total count mismatch is rejected
    expect(() => validateStatusV3Output({
      ...readyStatus,
      memory: { ...readyStatus.memory, total_count: 99 },
    })).toThrow()
  })

  it('7. Component Slug adheres to unified MVP-03 regex ^[a-z0-9][a-z0-9_-]{0,23}$', () => {
    // Valid slugs with underscores, hyphens, numbers
    expect(validateSearchInput({ query: 'test', component_hint: 'build_core' }).component_hint).toBe('build_core')
    expect(validateSearchInput({ query: 'test', component_hint: 'a_b-c_123' }).component_hint).toBe('a_b-c_123')
    expect(validateSearchInput({ query: 'test', component_hint: 'a'.repeat(24) }).component_hint).toBe('a'.repeat(24))

    // Rejected slugs (>24 chars, starts with non-alnum, uppercase, illegal chars)
    expect(() => validateSearchInput({ query: 'test', component_hint: 'a'.repeat(25) })).toThrow()
    expect(() => validateSearchInput({ query: 'test', component_hint: '_invalid' })).toThrow()
    expect(() => validateSearchInput({ query: 'test', component_hint: '-invalid' })).toThrow()
    expect(() => validateSearchInput({ query: 'test', component_hint: 'Invalid' })).toThrow()
    expect(() => validateSearchInput({ query: 'test', component_hint: 'invalid@slug' })).toThrow()
  })

  it('8. Protocol closure: generation_ref=null strictly requires result_count=0 and items=[]', () => {
    const rawEmpty = {
      schema_version: 1 as const,
      disclosure_id: 'disclosure_0000000000000000000000000000000000000000000000000000000000000000',
      retrieval_id: 'retrieval_0000000000000000000000000000000000000000000000000000000000000000',
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: null,
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      level: 2 as const,
      result_count: 0,
      items: Object.freeze([]),
      content_sha256: '',
    }
    const validEmpty = validateSearchDisclosure(JSON.parse(canonicalizeSearchDisclosure(rawEmpty)))
    expect(validateSearchDisclosure(validEmpty)).toEqual(validEmpty)

    // Rejected if generation_ref=null but result_count > 0 or items has elements
    expect(() => validateSearchDisclosure({
      ...validEmpty,
      result_count: 1,
    })).toThrow()

    expect(() => validateSearchDisclosure({
      ...validEmpty,
      items: [{
        memory_ref: sampleShortMemoryRef,
        title: 'Title',
        summary: 'Summary',
        component: null,
        tags: ['test'],
        score_fixed: 1000,
        rank: 1,
      }],
    })).toThrow()
  })

  it('9. Protocol validation error messages are static and do not leak unknown keys or payload inputs', () => {
    const maliciousKey = 'sensitive_secret_password_field_12345'
    try {
      validateSearchInput({ query: 'test', [maliciousKey]: 'secret_value' })
      expect.unreachable('should have thrown on unknown key')
    } catch (err: unknown) {
      const msg = (err as Error).message
      expect(msg).not.toContain(maliciousKey)
      expect(msg).not.toContain('secret_value')
    }
  })

  it('10. Status v3 strict state matrix: rejects all invalid scope/memory combinations', () => {
    const baseReady: StatusV3Output = {
      plugin: 'dsh-Mnemosyne',
      version: '0.1.0',
      protocol_version: 3,
      memory_enabled: true,
      status: 'ready',
      scope: {
        status: 'ready',
        source: 'session_header',
        project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        reason: null,
      },
      memory: {
        availability: 'ready',
        generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        short_term_count: 2,
        long_term_count: 3,
        total_count: 5,
        reason: null,
      },
    }

    // 1. scope.ready invalid variations
    expect(() => validateStatusV3Output({ ...baseReady, scope: { ...baseReady.scope, source: 'none' } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, scope: { ...baseReady.scope, project_scope_id: null } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, scope: { ...baseReady.scope, session_scope_id: null } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, scope: { ...baseReady.scope, reason: 'missing_agent' } })).toThrow()

    // 2. scope.unavailable invalid variations
    const baseUnavailScope: StatusV3ScopePayload = {
      status: 'unavailable',
      source: 'none',
      project_scope_id: null,
      session_scope_id: null,
      reason: 'missing_agent',
    }
    const baseUnavailMem: StatusV3MemoryPayload = {
      availability: 'unavailable',
      generation_id: null,
      short_term_count: 0,
      long_term_count: 0,
      total_count: 0,
      reason: 'missing_agent',
    }
    const validUnavail: StatusV3Output = {
      ...baseReady,
      scope: baseUnavailScope,
      memory: baseUnavailMem,
    }
    expect(validateStatusV3Output(validUnavail)).toEqual(validUnavail)

    expect(() => validateStatusV3Output({ ...validUnavail, scope: { ...baseUnavailScope, source: 'session_header' } })).toThrow()
    expect(() => validateStatusV3Output({ ...validUnavail, scope: { ...baseUnavailScope, project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).toThrow()
    expect(() => validateStatusV3Output({ ...validUnavail, scope: { ...baseUnavailScope, reason: null } })).toThrow()

    // 3. memory.ready invalid variations
    expect(() => validateStatusV3Output({ ...baseReady, memory: { ...baseReady.memory, generation_id: null } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, memory: { ...baseReady.memory, reason: 'failed' } })).toThrow()

    // 4. memory.empty invalid variations
    const baseEmptyMem: StatusV3MemoryPayload = {
      availability: 'empty',
      generation_id: null,
      short_term_count: 0,
      long_term_count: 0,
      total_count: 0,
      reason: null,
    }
    expect(() => validateStatusV3Output({ ...baseReady, memory: { ...baseEmptyMem, generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, memory: { ...baseEmptyMem, short_term_count: 1, total_count: 1 } })).toThrow()
    expect(() => validateStatusV3Output({ ...baseReady, memory: { ...baseEmptyMem, reason: 'some_reason' } })).toThrow()

    // 5. memory.unavailable / invalid invalid variations
    expect(() => validateStatusV3Output({ ...validUnavail, memory: { ...baseUnavailMem, generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } })).toThrow()
    expect(() => validateStatusV3Output({ ...validUnavail, memory: { ...baseUnavailMem, short_term_count: 1, total_count: 1 } })).toThrow()
    expect(() => validateStatusV3Output({ ...validUnavail, memory: { ...baseUnavailMem, reason: null } })).toThrow()

    // 6. Scope non-ready requires memory unavailable with exact same reason
    expect(() => validateStatusV3Output({ ...validUnavail, memory: baseReady.memory })).toThrow()
    expect(() => validateStatusV3Output({ ...validUnavail, memory: { ...baseUnavailMem, reason: 'different_reason' } })).toThrow()

    // 7. Scope ready allows only ready | empty | invalid (NOT unavailable)
    expect(() => validateStatusV3Output({ ...baseReady, memory: baseUnavailMem })).toThrow()
  })

  it('11. Search Disclosure tied scores must be sorted strictly by memory_id codepoints ascending', () => {
    const itemA = {
      memory_ref: { ...sampleShortMemoryRef, memory_id: 'mem_aaa' },
      title: 'Title A',
      summary: 'Summary A',
      component: null,
      tags: ['test'],
      score_fixed: 2000,
      rank: 1,
    }
    const itemZ = {
      memory_ref: { ...sampleShortMemoryRef, memory_id: 'mem_zzz' },
      title: 'Title Z',
      summary: 'Summary Z',
      component: null,
      tags: ['test'],
      score_fixed: 2000,
      rank: 2,
    }

    const retrievalId = computeRetrievalId({
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      generation_ref: sampleGenRef,
    })

    // Correct ascending order: mem_aaa (rank 1), mem_zzz (rank 2)
    const validItems = [itemA, itemZ]
    const validDisclosureId = computeSearchDisclosureId({
      retrieval_id: retrievalId,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      generation_ref: sampleGenRef,
      items: validItems,
    })
    const validRaw = {
      schema_version: 1 as const,
      disclosure_id: validDisclosureId,
      retrieval_id: retrievalId,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      level: 2 as const,
      result_count: 2,
      items: validItems,
      content_sha256: '',
    }
    const validCanonical = canonicalizeSearchDisclosure(validRaw)
    expect(validateSearchDisclosure(JSON.parse(validCanonical))).toBeDefined()

    // Reversed tied order: mem_zzz (rank 1), mem_aaa (rank 2) -> MUST throw
    const reversedItems = [
      { ...itemZ, rank: 1 },
      { ...itemA, rank: 2 },
    ]
    const reversedDisclosureId = computeSearchDisclosureId({
      retrieval_id: retrievalId,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      generation_ref: sampleGenRef,
      items: reversedItems,
    })
    expect(() => validateSearchDisclosure({
      ...validRaw,
      disclosure_id: reversedDisclosureId,
      items: reversedItems,
    })).toThrow()
  })

  it('12. Strict Hash: validateSearchDisclosure and validateOpenDisclosure require exact valid content_sha256', () => {
    const retrievalId = computeRetrievalId({
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      generation_ref: sampleGenRef,
    })
    const searchDisclosureId = computeSearchDisclosureId({
      retrieval_id: retrievalId,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      generation_ref: sampleGenRef,
      items: [],
    })
    const searchRaw = {
      schema_version: 1 as const,
      disclosure_id: searchDisclosureId,
      retrieval_id: retrievalId,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null,
      top_k: 5,
      level: 2 as const,
      result_count: 0,
      items: [],
      content_sha256: '',
    }

    // Direct validateSearchDisclosure with empty or invalid hash -> throws
    expect(() => validateSearchDisclosure(searchRaw)).toThrow()
    expect(() => validateSearchDisclosure({ ...searchRaw, content_sha256: 'invalid_sha' })).toThrow()
    expect(() => validateSearchDisclosure({ ...searchRaw, content_sha256: 'sha256_9999999999999999999999999999999999999999999999999999999999999999' })).toThrow()

    // canonicalizeSearchDisclosure computes hash and round-trips
    const canonicalSearch = canonicalizeSearchDisclosure(searchRaw)
    const validSearch = validateSearchDisclosure(JSON.parse(canonicalSearch))
    expect(validSearch.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)

    // Direct validateOpenDisclosure with empty or invalid hash -> throws
    const parentSha = validSearch.content_sha256
    const openDisclosureId = computeOpenDisclosureId({
      retrieval_id: retrievalId,
      parent_disclosure_sha256: parentSha,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      memory_ref: sampleShortMemoryRef,
    })
    const openRaw = {
      schema_version: 1 as const,
      disclosure_id: openDisclosureId,
      retrieval_id: retrievalId,
      parent_disclosure_sha256: parentSha,
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generation_ref: sampleGenRef,
      level: 3 as const,
      memory_ref: sampleShortMemoryRef,
      title: 'Title',
      summary: 'Summary',
      component: null,
      tags: ['test'],
      body: 'Body text',
      content_sha256: '',
    }

    expect(() => validateOpenDisclosure(openRaw)).toThrow()
    expect(() => validateOpenDisclosure({ ...openRaw, content_sha256: 'sha256_9999999999999999999999999999999999999999999999999999999999999999' })).toThrow()

    // canonicalizeOpenDisclosure computes hash and round-trips
    const canonicalOpen = canonicalizeOpenDisclosure(openRaw)
    const validOpen = validateOpenDisclosure(JSON.parse(canonicalOpen))
    expect(validOpen.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
  })

  it('13. Deterministic IDs: binds all canonical parameters and rejects forged IDs in validator', () => {
    const baseParams = {
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      query_fingerprint: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      component_hint: null as string | null,
      top_k: 5,
      generation_ref: sampleGenRef as OKFGenerationRef | null,
    }

    const id1 = computeRetrievalId(baseParams)
    // 1. Changing component_hint changes retrieval_id
    const idHint = computeRetrievalId({ ...baseParams, component_hint: 'core' })
    expect(idHint).not.toBe(id1)

    // 2. Changing top_k changes retrieval_id
    const idTopK = computeRetrievalId({ ...baseParams, top_k: 3 })
    expect(idTopK).not.toBe(id1)

    // 3. Changing generation_ref changes retrieval_id
    const idNullGen = computeRetrievalId({ ...baseParams, generation_ref: null })
    expect(idNullGen).not.toBe(id1)

    // 4. Changing items changes search disclosure_id
    const discEmpty = computeSearchDisclosureId({ ...baseParams, retrieval_id: id1, items: [] })
    const discWithItems = computeSearchDisclosureId({
      ...baseParams,
      retrieval_id: id1,
      items: [{
        memory_ref: sampleShortMemoryRef,
        title: 'Title',
        summary: 'Summary',
        component: null,
        tags: ['test'],
        score_fixed: 1000,
        rank: 1,
      }],
    })
    expect(discWithItems).not.toBe(discEmpty)

    // 5. Forged retrieval_id or disclosure_id is rejected by validateSearchDisclosure
    const forgedSearch = {
      schema_version: 1 as const,
      disclosure_id: 'disclosure_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      retrieval_id: id1,
      project_scope_id: baseParams.project_scope_id,
      session_scope_id: baseParams.session_scope_id,
      generation_ref: sampleGenRef,
      query_fingerprint: baseParams.query_fingerprint,
      component_hint: null,
      top_k: 5,
      level: 2 as const,
      result_count: 0,
      items: Object.freeze([]),
      content_sha256: '',
    }
    const hash = canonicalHash(withoutHash(forgedSearch))
    expect(() => validateSearchDisclosure({ ...forgedSearch, content_sha256: hash })).toThrow()
  })

  it('14. Status v3 reason whitelist: accepts all MemoryStoreErrorCode and generation_invalid, rejects arbitrary/sensitive strings', () => {
    const validCodes = [
      'memory_store_invalid_input',
      'memory_store_scope_mismatch',
      'memory_store_path_unsafe',
      'memory_store_symlink_rejected',
      'memory_store_insecure_permissions',
      'memory_store_not_found',
      'memory_store_file_too_large',
      'memory_store_decode_failed',
      'memory_store_hash_mismatch',
      'memory_store_noncanonical',
      'memory_store_identity_conflict',
      'memory_store_io_failed',
      'memory_compile_invalid_input',
      'memory_compile_busy',
      'memory_compile_not_found',
      'memory_compile_path_unsafe',
      'memory_compile_symlink_rejected',
      'memory_compile_insecure_permissions',
      'memory_compile_decode_failed',
      'memory_compile_hash_mismatch',
      'memory_compile_noncanonical',
      'memory_compile_identity_conflict',
      'memory_compile_generation_incomplete',
      'memory_compile_current_invalid',
      'memory_compile_io_failed',
      'generation_invalid',
    ]

    const baseReadyScope: StatusV3ScopePayload = {
      status: 'ready',
      source: 'session_header',
      project_scope_id: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_scope_id: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: null,
    }

    // 1. All valid codes must be accepted
    for (const code of validCodes) {
      const validStatus: StatusV3Output = {
        plugin: 'dsh-Mnemosyne',
        version: '0.1.0',
        protocol_version: 3,
        memory_enabled: true,
        status: 'ready',
        scope: baseReadyScope,
        memory: {
          availability: 'invalid',
          generation_id: null,
          short_term_count: 0,
          long_term_count: 0,
          total_count: 0,
          reason: code,
        },
      }
      expect(validateStatusV3Output(validStatus).memory.reason).toBe(code)
    }

    // 2. Sensitive strings, paths, secrets, unregistered codes, free text must be rejected
    const rejectedReasons = [
      '/Users/victim/.ssh/id_rsa',
      'sk-secret',
      'generation_corrupted',
      'arbitrary_free_text',
      'UNKNOWN_ERROR_CODE',
      'rm -rf /',
      'a'.repeat(2000),
    ]

    for (const badReason of rejectedReasons) {
      const badStatus: StatusV3Output = {
        plugin: 'dsh-Mnemosyne',
        version: '0.1.0',
        protocol_version: 3,
        memory_enabled: true,
        status: 'ready',
        scope: baseReadyScope,
        memory: {
          availability: 'invalid',
          generation_id: null,
          short_term_count: 0,
          long_term_count: 0,
          total_count: 0,
          reason: badReason,
        },
      }
      let threw = false
      try {
        validateStatusV3Output(badStatus)
      } catch (err: unknown) {
        threw = true
        const msg = (err as Error).message
        expect(msg).not.toContain(badReason)
        expect(msg).not.toContain('victim')
        expect(msg).not.toContain('id_rsa')
        expect(msg).not.toContain('secret')
      }
      expect(threw, `should have rejected invalid reason "${badReason}"`).toBe(true)
    }
  })
})
