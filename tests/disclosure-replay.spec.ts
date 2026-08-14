import { describe, expect, it } from 'vitest'
import { canonicalBytes } from '../src/protocol/canonical.js'
import { canonicalHash } from '../src/protocol/canonical.js'
import { validateOpenDisclosure } from '../src/protocol/retrieval.js'
import { createFixtureRuntime } from '../src/retrieval/runtime.js'

describe('M0.5B disclosure and replay', () => {
  it('keeps search at L2 and requires a verified parent for L3', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const bytes = runtime.encode(search)
    expect(search.items[0]).not.toHaveProperty('body')
    expect(() => runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: 'sha256_' + '0'.repeat(64), memory_id: search.items[0].memory_id })).toThrow()
    const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id })
    expect(opened.level).toBe(3); expect(opened.body.length).toBeGreaterThan(0)
    expect(() => runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: 'memory_stale_scope' })).toThrow()
    expect(() => runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: 'memory_unverified_hook' })).toThrow()
    expect(canonicalBytes(runtime.replay(bytes))).toBe(bytes)
    runtime.clear()
    expect(() => runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id })).toThrow()
    expect(canonicalBytes(runtime.replay(bytes))).toBe(bytes)
  })

  it('rejects open content, lifecycle, and memory-hash tampering', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id })
    for (const change of [{ body: 'changed body' }, { title: 'changed title' }, { lifecycle: 'frozen' }, { memory_content_sha256: 'sha256_' + 'f'.repeat(64) }]) {
      const tampered = { ...opened, ...change }; const { content_sha256: _hash, ...withoutHash } = tampered
      expect(() => runtime.replay(JSON.stringify({ ...tampered, content_sha256: canonicalHash(withoutHash) }))).toThrow()
    }
  })

  it('rejects path and credential text injected into search and open lists', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const searchValue = JSON.parse(runtime.encode(search)) as Record<string, unknown>
    const searchItems = searchValue.items as Array<Record<string, unknown>>
    for (const change of [{ tags: ['/Users/private'] }, { aliases: ['password=secret'] }]) {
      const items = searchItems.map((item, index) => index === 0 ? { ...item, ...change } : item)
      const identity = { retrieval_ref: searchValue.retrieval_ref, candidate_universe_sha256: searchValue.candidate_universe_sha256, level: 2, items }
      const tampered = { ...searchValue, items, disclosure_id: `disclosure_${canonicalHash(identity).slice(7, 23)}` } as Record<string, unknown>
      const { content_sha256: _hash, ...withoutHash } = tampered
      expect(() => runtime.replay(JSON.stringify({ ...tampered, content_sha256: canonicalHash(withoutHash) }))).toThrow()
    }
    const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id }); const openValue = JSON.parse(runtime.encode(opened)) as Record<string, unknown>
    for (const change of [{ tags: ['../../etc'] }, { aliases: ['Bearer supersecret123'] }]) {
      const tampered = { ...openValue, ...change, memory_content_sha256: 'sha256_' + '0'.repeat(64) } as Record<string, unknown>; const { content_sha256: _hash, ...withoutHash } = tampered
      expect(() => runtime.replay(JSON.stringify({ ...tampered, content_sha256: canonicalHash(withoutHash) }))).toThrow()
    }
  })

  it('rejects tampered rank, hash, and malformed replay bytes', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'hook executable path' }); const value = JSON.parse(runtime.encode(search)) as Record<string, unknown>
    const items = value.items as Array<Record<string, unknown>>
    items[0].rank = 2
    expect(() => runtime.replay(JSON.stringify(value))).toThrow()
    expect(() => runtime.replay(runtime.encode(search).replace(search.content_sha256, 'sha256_' + 'f'.repeat(64)))).toThrow()
    expect(() => runtime.replay('{bad-json')).toThrow()
  })

  it('rejects sensitive body text even when an attacker recomputes the envelope hash', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id })
    const tampered = { ...opened, body: 'run rm -rf /tmp/cache before retrying' }
    const { content_sha256: _hash, ...withoutHash } = tampered
    expect(() => validateOpenDisclosure({ ...tampered, content_sha256: canonicalHash(withoutHash) })).toThrow()
  })
})
