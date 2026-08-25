import { describe, expect, it } from 'vitest'
import {
  deriveComponentSlug,
  escapeMarkdownText,
  quoteMarkdownBlock,
  renderComponentPage,
  renderMemoryPage,
  renderRootPage,
  renderSessionPage,
} from '../src/okf-render.js'
import { MemoryStoreError } from '../src/memory-store-error.js'
import type { LongTermMemoryFact, ShortTermMemoryFact } from '../src/memory-fact.js'

describe('MVP-03C: Deterministic Markdown Rendering & Index (Tests 23-31)', () => {
  const projectScopeId = 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

  const sampleShortFact: ShortTermMemoryFact = {
    schema_version: 1,
    tier: 'short_term',
    memory_id: 'mem_short_render',
    project_scope_id: projectScopeId,
    session_scope_id: sessionScopeId,
    title: 'Short title <test> & [link]',
    summary: 'Short summary with *markdown* and #hashtag',
    body: 'Line 1 of body\nLine 2 with > quote\n```ts\nconst x = 1\n```',
    tags: ['testing', 'render'],
    created_at: '2026-08-25T10:00:00.000Z',
    expires_at: '2026-08-30T10:00:00.000Z',
    content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
  }

  const sampleLongFact: LongTermMemoryFact = {
    schema_version: 1,
    tier: 'long_term',
    memory_id: 'mem_long_render',
    project_scope_id: projectScopeId,
    title: 'Long architecture decision',
    summary: 'Long summary description',
    body: 'Detailed body architecture rationale.',
    tags: ['arch', 'component-database'],
    created_at: '2026-08-25T10:00:00.000Z',
    source_short_term_refs: [],
    content_sha256: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
  }

  it('23. ROOT page contains only overview, counts, and directory links, with ZERO fact body', () => {
    const rootMd = renderRootPage({
      generation_id: 'gen_test_01',
      evaluation_at: '2026-08-25T12:00:00.000Z',
      short_term_count: 1,
      long_term_count: 1,
      sessions: [sessionScopeId],
      components: ['database'],
      memories_count: 2,
    })

    expect(rootMd).toContain('# Open Knowledge Fact Index')
    expect(rootMd).toContain(`- [Session: ${sessionScopeId}](short-term/${sessionScopeId}.md)`)
    expect(rootMd).toContain('- [Component: database](components/database.md)')
    expect(rootMd).not.toContain('Line 1 of body')
    expect(rootMd).not.toContain('Detailed body architecture rationale')
  })

  it('24. Session Page lists facts with title, summary, tags, expires_at, and memory ref, with ZERO fact body', () => {
    const sessionMd = renderSessionPage({
      session_scope_id: sessionScopeId,
      evaluation_at: '2026-08-25T12:00:00.000Z',
      facts: [sampleShortFact],
    })

    expect(sessionMd).toContain(`# Short-term Session: ${sessionScopeId}`)
    expect(sessionMd).toContain(`[${sampleShortFact.memory_id}](../memories/${sampleShortFact.memory_id}.md)`)
    expect(sessionMd).toContain(quoteMarkdownBlock(sampleShortFact.summary))
    expect(sessionMd).not.toContain('Line 1 of body')
  })

  it('25. Component Page lists long-term facts with title, summary, tags, and memory ref, with ZERO fact body', () => {
    const compMd = renderComponentPage({
      component: 'database',
      evaluation_at: '2026-08-25T12:00:00.000Z',
      facts: [sampleLongFact],
    })

    expect(compMd).toContain('# Component: database')
    expect(compMd).toContain(`[${sampleLongFact.memory_id}](../memories/${sampleLongFact.memory_id}.md)`)
    expect(compMd).toContain(quoteMarkdownBlock(sampleLongFact.summary))
    expect(compMd).not.toContain('Detailed body architecture rationale')
  })

  it('26. Memory Page contains complete metadata, summary, and full body', () => {
    const memMd = renderMemoryPage({
      fact: sampleShortFact,
      component: null,
      evaluation_at: '2026-08-25T12:00:00.000Z',
    })

    expect(memMd).toContain(`# Memory: ${sampleShortFact.memory_id}`)
    expect(memMd).toContain('## Summary')
    expect(memMd).toContain('## Body')
    expect(memMd).toContain(quoteMarkdownBlock(sampleShortFact.body))
  })

  it('27. User Markdown control characters are safely quoted with > prefix and empty is > (empty)', () => {
    const quoted = quoteMarkdownBlock('Line 1\n# Heading Injection\n```bash\nrm -rf\n```')
    expect(quoted).toBe('> Line 1\n> \\# Heading Injection\n> \\`\\`\\`bash\n> rm \\-rf\n> \\`\\`\\`')

    const emptyQuoted = quoteMarkdownBlock('')
    expect(emptyQuoted).toBe('> (empty)')
  })

  it('28. Component slug derivation handles single component-*, none (general), and rejects multiple', () => {
    expect(deriveComponentSlug(['t1', 'component-storage'])).toBe('storage')
    expect(deriveComponentSlug(['t1', 't2'])).toBe('general')
    expect(() => deriveComponentSlug(['component-db', 'component-api'])).toThrowError(MemoryStoreError)
    expect(() => deriveComponentSlug(['component-INVALID!'])).toThrowError(MemoryStoreError)
  })

  it('29. All relative links point strictly to protocol-defined relative paths in the same Generation', () => {
    const sessionMd = renderSessionPage({
      session_scope_id: sessionScopeId,
      evaluation_at: '2026-08-25T12:00:00.000Z',
      facts: [sampleShortFact],
    })
    expect(sessionMd).toContain(`../memories/${sampleShortFact.memory_id}.md`)
    expect(sessionMd).not.toContain('file://')
    expect(sessionMd).not.toContain('/Users/')
  })

  it('30. Chinese, English, emojis, and multiline text render deterministically and stably', () => {
    const unicodeFact: ShortTermMemoryFact = {
      ...sampleShortFact,
      memory_id: 'mem_unicode_01',
      title: '测试标题 🚀 Alpha',
      summary: '中文摘要：包含多行\n第二行 🌟',
      body: '详细内容：\n- 列表项 1\n- 列表项 2 🎉',
    }
    const rendered1 = renderMemoryPage({ fact: unicodeFact, component: null, evaluation_at: '2026-08-25T12:00:00.000Z' })
    const rendered2 = renderMemoryPage({ fact: unicodeFact, component: null, evaluation_at: '2026-08-25T12:00:00.000Z' })
    expect(rendered1).toBe(rendered2)
    expect(rendered1).toContain('测试标题 🚀 Alpha')
  })

  it('31. All generated markdown files use LF and end with exactly one LF', () => {
    const rootMd = renderRootPage({
      generation_id: 'gen_test_01',
      evaluation_at: '2026-08-25T12:00:00.000Z',
      short_term_count: 1,
      long_term_count: 1,
      sessions: [sessionScopeId],
      components: ['database'],
      memories_count: 2,
    })
    expect(rootMd.includes('\r')).toBe(false)
    expect(rootMd.endsWith('\n')).toBe(true)
    expect(rootMd.endsWith('\n\n')).toBe(false)
    expect(rootMd).not.toContain('\r')
  })

  it('66. Adversarial Markdown input in title/summary/body cannot inject headings, links, HTML, or metadata lines', () => {
    const maliciousFact: ShortTermMemoryFact = {
      ...sampleShortFact,
      memory_id: 'mem_malicious_01',
      title: 'Title with \n## Injected Heading\n- Injected Metadata: 123\n](evil.com)<script>alert(1)</script>',
      summary: 'Summary with \n```bash\nrm -rf /\n```\n<iframe src="evil"></iframe>\n# Heading Inside\n- List item\n[Link](http://evil.com)\n![Img](http://evil.com)',
      body: 'Body line\n## Injected Top Heading\n<script>alert(2)</script>\n```ts\ncode\n```',
    }

    const memMd = renderMemoryPage({
      fact: maliciousFact,
      component: null,
      evaluation_at: '2026-08-25T12:00:00.000Z',
    })

    // Assert title is sanitized to single line and cannot break out of `- Title: `
    expect(memMd).not.toMatch(/\n## Injected Heading/)
    expect(memMd).not.toMatch(/\n- Injected Metadata:/)
    expect(memMd).not.toContain('<script>')
    expect(memMd).not.toContain('<iframe')

    // In blockquote, lines must not contain raw unescaped markdown headings or fences or links
    expect(memMd).not.toMatch(/^> # /m)
    expect(memMd).not.toMatch(/^> ## /m)
    expect(memMd).not.toMatch(/^> ```/m)
    expect(memMd).not.toMatch(/^> - /m)
    expect(memMd).not.toContain('[Link](http://evil.com)')
    expect(memMd).not.toContain('![Img](http://evil.com)')

    const sessionMd = renderSessionPage({
      session_scope_id: sessionScopeId,
      evaluation_at: '2026-08-25T12:00:00.000Z',
      facts: [maliciousFact],
    })

    // In Session page, title must not break heading or inject links
    expect(sessionMd).not.toMatch(/\n## Injected Heading/)
    expect(sessionMd).not.toContain('<script>')
    expect(sessionMd).not.toMatch(/^> # /m)
    expect(sessionMd).not.toMatch(/^> ```/m)
  })
})
