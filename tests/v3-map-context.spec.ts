import { describe, expect, it } from 'vitest'
import { createMapContextMessageV3, MAP_CONTEXT_PREFIX } from '../src/v3/map-context.js'

describe('v3 map context', () => {
  it('exposes only the bounded title map to the parent model', () => {
    const message = createMapContextMessageV3({ schema_version: 1, generation_id: 'gen_' + 'a'.repeat(64), catalog_id: 'catalog_' + 'b'.repeat(64), project_scope_id: 'sha256_' + 'c'.repeat(64), node_id: 'node_root', entries: [{ ref: 'node_auth', title: 'Authentication', kind: 'node' }], next_cursor: null, offer_sha256: 'sha256_' + 'd'.repeat(64) })
    const text = (message.content[0] as { text: string }).text
    expect(text.startsWith(MAP_CONTEXT_PREFIX)).toBe(true)
    expect(text).toContain('Authentication')
    expect(text).not.toContain('summary')
    expect(text).not.toContain('content')
  })
})
