import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/protocol/canonical.js'
import { replayDisclosure, validateRetrievalRequest, validateSearchDisclosure } from '../src/protocol/retrieval.js'
import { createFixtureRuntime, validateOpenInput, validateSearchInput } from '../src/retrieval/runtime.js'

describe('M0.5B retrieval protocol', () => {
  it('rejects query request drift and unknown disclosure fields', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const audit = runtime.auditFor(search.retrieval_ref)
    const request = audit.request; const { content_sha256: _hash, ...withoutHash } = request
    expect(() => validateRetrievalRequest({ ...request, extra: true })).toThrow()
    expect(() => validateRetrievalRequest({ ...request, top_k: 4, content_sha256: canonicalHash({ ...withoutHash, top_k: 4 }) })).toThrow()
    expect(() => replayDisclosure(JSON.stringify({ schema_version: 1, level: 4 }))).toThrow()
  })

  it('rejects malformed search disclosures', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const value = JSON.parse(runtime.encode(search)) as Record<string, unknown>
    expect(() => validateSearchDisclosure({ ...value, extra: true })).toThrow()
    const countChanged = { ...value, result_count: (value.result_count as number) + 1 } as Record<string, unknown>; const { content_sha256: _countHash, ...countWithoutHash } = countChanged
    expect(() => validateSearchDisclosure({ ...countChanged, content_sha256: canonicalHash(countWithoutHash) })).toThrow()
    expect(() => validateSearchDisclosure({ ...value, content_sha256: 'sha256_' + 'f'.repeat(64) })).toThrow()
  })

  it('strictly validates runtime search/open inputs without TypeError or ignored fields', () => {
    const runtime = createFixtureRuntime()
    for (const input of [null, [], {}, { query: ' ' }, { query: '/Users/private' }, { query: 'password=secret' }, { query: 'git commit -am x' }, { query: 'cache', extra: true }, { query: 'cache', top_k: 0 }, { query: 'cache', component_hint: {} }]) expect(() => runtime.search(input as never)).toThrow()
    for (const query of ['cache\u0000', 'cache\nnext', 'cache\u007f']) expect(() => validateSearchInput({ query })).toThrow(/protocol validation failed/)
    for (const input of [null, [], {}, { retrieval_id: 'retrieval_x', search_disclosure_sha256: 'sha256_' + '0'.repeat(64), memory_id: 'memory_x', extra: true }, { retrieval_id: [], search_disclosure_sha256: 'sha256_' + '0'.repeat(64), memory_id: 'memory_x' }]) expect(() => runtime.open(input as never)).toThrow()
    expect(() => validateSearchInput({ query: 'cache', operation_hint: null, top_k: 5 })).not.toThrow()
    expect(() => validateOpenInput({ retrieval_id: 'retrieval_x', search_disclosure_sha256: 'sha256_' + '0'.repeat(64), memory_id: 'memory_x' })).not.toThrow()
  })

  it('rejects stable-ID tampering even when the content hash is recomputed', () => {
    const runtime = createFixtureRuntime(); const search = runtime.search({ query: 'compiler cache targeted rebuild' }); const value = JSON.parse(runtime.encode(search)) as Record<string, unknown>
    const changed = { ...value, disclosure_id: 'disclosure_tampered' } as Record<string, unknown>; const { content_sha256: _hash, ...withoutHash } = changed
    expect(() => replayDisclosure(JSON.stringify({ ...changed, content_sha256: canonicalHash(withoutHash) }))).toThrow()
    const audit = runtime.auditFor(search.retrieval_ref); const request = { ...audit.request, retrieval_id: 'retrieval_tampered' }; const { content_sha256: _requestHash, ...requestWithoutHash } = request
    expect(() => validateRetrievalRequest({ ...request, content_sha256: canonicalHash(requestWithoutHash) })).toThrow()
    const open = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id })
    const changedOpen = { ...open, disclosure_id: 'disclosure_tampered_open' } as Record<string, unknown>; const { content_sha256: _openHash, ...openWithoutHash } = changedOpen
    expect(() => replayDisclosure(JSON.stringify({ ...changedOpen, content_sha256: canonicalHash(openWithoutHash) }))).toThrow()
  })

  it('keeps registry state isolated from mutable caller objects', () => {
    const runtime = createFixtureRuntime()
    const search = runtime.search({ query: 'compiler cache targeted rebuild' })
    const memoryId = search.items[0].memory_id
    search.items[0].memory_id = 'memory_tampered'
    expect(runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: memoryId }).memory_id).toBe(memoryId)
    const audit = runtime.auditFor(search.retrieval_ref)
    audit.candidateUniverse.candidates[0].memory_id = 'memory_tampered'
    expect(runtime.auditFor(search.retrieval_ref).candidateUniverse.candidates[0].memory_id).not.toBe('memory_tampered')
  })
})
