import { describe, expect, it } from 'vitest'
import { createMapOfferV3, MAP_OFFER_PAGE_SIZE, pinGenerationV3 } from '../src/v3/map-offer.js'

function generation() {
  const children = Array.from({ length: MAP_OFFER_PAGE_SIZE + 2 }, (_, i) => ({ ref: `node_${String(i).padStart(2, '0')}`, title: `分类 ${i}` }))
  return {
    generation_id: 'gen_' + 'a'.repeat(64),
    manifest: { project_scope_id: 'sha256_' + 'b'.repeat(64), catalog_id: 'catalog_' + 'c'.repeat(64) },
    files: new Map([['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children, memories: [] })]]),
  } as any
}

describe('v3 map offer', () => {
  it('pins an immutable generation identity and exposes title-only entries', () => {
    const pin = pinGenerationV3(generation())
    const offer = createMapOfferV3(pin)
    expect(offer.generation_id).toBe(pin.generation_id)
    expect(offer.entries).toHaveLength(MAP_OFFER_PAGE_SIZE)
    expect(JSON.stringify(offer)).not.toContain('summary')
    expect(JSON.stringify(offer)).not.toContain('content')
    expect(() => (offer.entries as any).push({})).toThrow()
  })

  it('paginates deterministically without silent truncation', () => {
    const pin = pinGenerationV3(generation())
    const first = createMapOfferV3(pin)
    expect(first.next_cursor).toBe(String(MAP_OFFER_PAGE_SIZE))
    const second = createMapOfferV3(pin, 'node_root', Number(first.next_cursor))
    expect(second.entries).toHaveLength(2)
    expect(second.next_cursor).toBeNull()
    expect(second.entries[0]!.ref).toBe('node_32')
  })

  it('uses the byte budget rather than silently truncating large titles', () => {
    const source = generation()
    source.files.set('indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_a', title: 'x'.repeat(7800) }, { ref: 'node_b', title: 'later' }], memories: [] }))
    const offer = createMapOfferV3(pinGenerationV3(source))
    expect(offer.entries).toHaveLength(1)
    expect(offer.next_cursor).toBe('1')
    const oversized = { ...source, files: new Map([['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_a', title: 'x'.repeat(12000) }], memories: [] })]]) } as any
    expect(() => createMapOfferV3(pinGenerationV3(oversized))).toThrow()
  })

  it('binds the offer to the pinned generation and node', () => {
    const pin = pinGenerationV3(generation())
    const a = createMapOfferV3(pin, 'node_root')
    const b = createMapOfferV3(pin, 'node_root', 1)
    expect(a.offer_sha256).not.toBe(b.offer_sha256)
    expect(() => createMapOfferV3(pin, 'node_missing')).toThrow()
  })
})
