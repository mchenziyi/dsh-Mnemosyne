import { describe, expect, it } from 'vitest'
import { executeOKFSearch } from '../src/okf-search.js'
import type { OKFIndex, OKFIndexEntry } from '../src/okf-schema.js'
import { canonicalizeSearchDisclosure, type OKFGenerationRef } from '../src/protocol/okf-retrieval.js'

describe('MVP-04B: OKF Deterministic Search & Ranking', () => {
  const sampleGenRef: OKFGenerationRef = {
    generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    generation_sha256: 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    manifest_id: 'manifest_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    manifest_sha256: 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    index_sha256: 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  }

  const projectScopeId = 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const sessionScopeId = 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  const entries: OKFIndexEntry[] = [
    {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_build_01',
      title: 'Compiler Build System Cache',
      summary: 'Configures incremental compilation caching for rustc and gcc tools.',
      component: 'build-system',
      tags: ['cache', 'compiler', 'performance'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: null,
      content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
      page_ref: 'wiki/memories/mem_build_01.md',
    },
    {
      tier: 'short_term',
      session_scope_id: sessionScopeId,
      memory_id: 'mem_auth_01',
      title: 'Authentication Token Verification',
      summary: 'Validates JWT bearer tokens and checks session expiry timestamp.',
      component: null,
      tags: ['auth', 'security', 'token'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: '2026-08-25T14:00:00.000Z',
      content_sha256: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
      page_ref: 'wiki/memories/mem_auth_01.md',
    },
    {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_cjk_01',
      title: '前端构建与增量打包',
      summary: '说明 Webpack 与 Vite 增量打包配置及缓存路径。',
      component: 'frontend',
      tags: ['build', 'cache'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: null,
      content_sha256: 'sha256_3333333333333333333333333333333333333333333333333333333333333333',
      page_ref: 'wiki/memories/mem_cjk_01.md',
    },
    {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_tie_a',
      title: 'Target Search Keyword',
      summary: 'Keyword matched equally.',
      component: 'core',
      tags: ['test'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: null,
      content_sha256: 'sha256_4444444444444444444444444444444444444444444444444444444444444444',
      page_ref: 'wiki/memories/mem_tie_a.md',
    },
    {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_tie_b',
      title: 'Target Search Keyword',
      summary: 'Keyword matched equally.',
      component: 'core',
      tags: ['test'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: null,
      content_sha256: 'sha256_5555555555555555555555555555555555555555555555555555555555555555',
      page_ref: 'wiki/memories/mem_tie_b.md',
    },
  ]

  const sampleIndex: OKFIndex = {
    schema_version: 1,
    generation_id: sampleGenRef.generation_id,
    project_scope_id: projectScopeId,
    compiler_version: 'dsh-mnemosyne-okf/1',
    evaluation_at: '2026-08-25T12:00:00.000Z',
    entries,
    content_sha256: sampleGenRef.index_sha256,
  }

  it('15. Exact title/component/summary/tag scoring weights operate correctly', () => {
    // Title match: 'Compiler' -> 4000 (title) + 2000 (tag) = 6000 on mem_build_01
    const res = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'Compiler' },
    })

    expect(res.level).toBe(2)
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items[0].memory_ref.memory_id).toBe('mem_build_01')
    expect(res.items[0].score_fixed).toBe(6000)
    expect(res.items[0].rank).toBe(1)
  })

  it('16. CJK n-gram tokenization and NFKC normalization matches accurately', () => {
    const res = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: '增量打包' },
    })

    expect(res.items.length).toBe(1)
    expect(res.items[0].memory_ref.memory_id).toBe('mem_cjk_01')
    expect(res.items[0].rank).toBe(1)
  })

  it('17. Equal scores break ties strictly by memory_id codepoint ascending', () => {
    const res = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'Target' },
    })

    expect(res.items.length).toBe(2)
    expect(res.items[0].memory_ref.memory_id).toBe('mem_tie_a')
    expect(res.items[0].rank).toBe(1)
    expect(res.items[1].memory_ref.memory_id).toBe('mem_tie_b')
    expect(res.items[1].rank).toBe(2)
    expect(res.items[0].score_fixed).toBe(res.items[1].score_fixed)
  })

  it('18. top_k parameter truncates results within 1..5', () => {
    const res1 = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'Target', top_k: 1 },
    })
    expect(res1.items.length).toBe(1)
    expect(res1.result_count).toBe(1)
    expect(res1.top_k).toBe(1)

    const res2 = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'Target', top_k: 5 },
    })
    expect(res2.items.length).toBe(2)
    expect(res2.top_k).toBe(5)
  })

  it('19. Non-positive scores are strictly excluded from results', () => {
    const res = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'completely_unmatched_xyz_query' },
    })

    expect(res.items).toEqual([])
    expect(res.result_count).toBe(0)
  })

  it('20. component_hint adds 5000 score bonus when text term matches candidate', () => {
    const resWithoutHint = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compilation' },
    })
    const scoreWithoutHint = resWithoutHint.items[0].score_fixed

    const resWithHint = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compilation', component_hint: 'build-system' },
    })
    expect(resWithHint.items[0].score_fixed).toBe(scoreWithoutHint + 5000)
    expect(resWithHint.component_hint).toBe('build-system')
  })

  it('21. Distinguishes short-term and long-term memory references correctly', () => {
    const resShort = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'JWT' },
    })
    expect(resShort.items[0].memory_ref.tier).toBe('short_term')
    expect(resShort.items[0].memory_ref.session_scope_id).toBe(sessionScopeId)
    expect(resShort.items[0].component).toBeNull()

    const resLong = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compiler' },
    })
    expect(resLong.items[0].memory_ref.tier).toBe('long_term')
    expect(resLong.items[0].memory_ref.session_scope_id).toBeNull()
    expect(resLong.items[0].component).toBe('build-system')
  })

  it('22. Search only reads Index; terms only in fact bodies cannot be matched', () => {
    // A term that does not exist in title, component, summary, or tag
    const res = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'secret_body_only_text_term' },
    })
    expect(res.items.length).toBe(0)
    expect(res.result_count).toBe(0)
  })

  it('23. Empty world (index === null or generationRef === null) returns valid empty disclosure with null generation_ref', () => {
    const res = executeOKFSearch({
      index: null,
      generationRef: null,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compiler' },
    })

    expect(res.generation_ref).toBeNull()
    expect(res.result_count).toBe(0)
    expect(res.items).toEqual([])
    expect(res.level).toBe(2)
    expect(res.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
  })

  it('24. Identical inputs yield byte-identical canonical JSON output', () => {
    const res1 = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compiler' },
    })
    const res2 = executeOKFSearch({
      index: sampleIndex,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId,
      searchParams: { query: 'compiler' },
    })

    expect(canonicalizeSearchDisclosure(res1)).toBe(canonicalizeSearchDisclosure(res2))
  })

  it('25. Search candidate filtering strictly excludes short-term memories of other sessions', () => {
    const otherSessionScopeId = 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const indexWithOtherSession: OKFIndex = {
      ...sampleIndex,
      entries: [
        ...entries,
        {
          tier: 'short_term',
          session_scope_id: otherSessionScopeId,
          memory_id: 'mem_other_auth_02',
          title: 'Authentication Secret Other Session',
          summary: 'Confidential session data from another session.',
          component: null,
          tags: ['auth', 'security'],
          created_at: '2026-08-25T10:00:00.000Z',
          expires_at: '2026-08-25T14:00:00.000Z',
          content_sha256: 'sha256_9999999999999999999999999999999999999999999999999999999999999999',
          page_ref: 'wiki/memories/mem_other_auth_02.md',
        },
      ],
    }

    const res = executeOKFSearch({
      index: indexWithOtherSession,
      generationRef: sampleGenRef,
      projectScopeId,
      sessionScopeId, // sessionScopeId != otherSessionScopeId
      searchParams: { query: 'Authentication' },
    })

    const foundIds = res.items.map((it) => it.memory_ref.memory_id)
    expect(foundIds).toContain('mem_auth_01')
    expect(foundIds).not.toContain('mem_other_auth_02')
  })
})
