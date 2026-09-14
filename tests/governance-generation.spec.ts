import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/protocol/canonical.js'
import { createGovernanceEventV1 } from '../src/protocol/governance.js'
import { createGovernedGenerationManifestV1, readVersionedGenerationManifestV1, validateGovernedGenerationManifestV1, validateLegacyGenerationManifestV1 } from '../src/governance/generation.js'

const PROJECT = `sha256_${'a'.repeat(64)}`
const A = { memory_id: 'mem_a', content_sha256: `sha256_${'1'.repeat(64)}` }
const B = { memory_id: 'mem_b', content_sha256: `sha256_${'2'.repeat(64)}` }
const legacyIdentity = { schema_version: 1 as const, project_scope_id: PROJECT, compiler_version: 'dsh-mnemosyne-okf-v2/1' as const, catalog_id: `catalog_${'2'.repeat(64)}`, catalog_sha256: `sha256_${'2'.repeat(64)}`, memory_refs: [A, B], output_refs: [{ path: 'index.json', content_sha256: `sha256_${'3'.repeat(64)}`, byte_length: 1 }], created_at: '2026-09-11T00:00:00.000Z' }
const legacy = { ...legacyIdentity, generation_id: `gen_${canonicalHash(legacyIdentity).slice(7)}` } as const
function governed(headSeed: string) {
  const event = createGovernanceEventV1({ schema_version: 1, project_scope_id: PROJECT, sequence: 1, prev_event_hash: null, payload: { action: 'deactivate', memory: A }, evidence_refs: [{ kind: 'memory', ...A }], reason_code: 'fixture', created_at: '2026-09-11T00:00:00.000Z' })
  const head = headSeed === 'event' ? { sequence: 1, event_id: event.event_id, event_sha256: event.event_sha256 } : { sequence: 1, event_id: `gov_${headSeed.repeat(64)}`, event_sha256: `sha256_${headSeed.repeat(64)}` }
  return createGovernedGenerationManifestV1({ schema_version: 2, project_scope_id: PROJECT, compiler_version: 'dsh-mnemosyne-okf-governance-v1/1', catalog_id: legacy.catalog_id, catalog_sha256: legacy.catalog_sha256, memory_refs: [A, B], visible_memory_refs: [A], output_refs: legacy.output_refs, created_at: legacy.created_at, governance_head: head, effective_catalog_id: `ecatalog_${'4'.repeat(64)}`, effective_catalog_sha256: `sha256_${'4'.repeat(64)}`, effective_state_sha256: canonicalHash({ head, visible: [A] }) })
}

describe('Governance Versioned Generation Slice 4', () => {
  it('reads legacy manifests without rewriting or upgrading them', () => {
    const loaded = readVersionedGenerationManifestV1(legacy)
    expect(loaded.kind).toBe('legacy')
    expect(loaded.governance_head).toBeNull()
    expect(loaded.visible_memory_refs).toEqual([A, B])
    expect(validateLegacyGenerationManifestV1(legacy)).toEqual(legacy)
  })
  it('constructs and reads governed manifests with distinct raw and visible sets', () => {
    const manifest = governed('event')
    const loaded = readVersionedGenerationManifestV1(manifest)
    expect(loaded.kind).toBe('governed')
    expect(manifest.schema_version).toBe(2)
    expect(manifest.visible_memory_refs).toEqual([A])
    expect(manifest.effective_catalog_id).not.toBe(manifest.catalog_id)
  })
  it('rejects unknown versions, legacy governance fields, missing head, and visible outside raw', () => {
    expect(() => readVersionedGenerationManifestV1({ ...legacy, governance_head: null })).toThrow()
    expect(() => readVersionedGenerationManifestV1({ ...legacy, schema_version: 9 })).toThrow()
    expect(() => validateGovernedGenerationManifestV1({ ...governed('event'), governance_head: null })).toThrow()
    expect(() => validateGovernedGenerationManifestV1({ ...governed('event'), visible_memory_refs: [{ memory_id: 'mem_c', content_sha256: `sha256_${'3'.repeat(64)}` }] })).toThrow()
  })
  it('rejects duplicates and noncanonical ref collections', () => {
    expect(() => validateGovernedGenerationManifestV1({ ...governed('event'), memory_refs: [B, A] })).toThrow()
    expect(() => validateGovernedGenerationManifestV1({ ...governed('event'), memory_refs: [A, A] })).toThrow()
    expect(() => validateGovernedGenerationManifestV1({ ...governed('event'), visible_memory_refs: [A, A] })).toThrow()
  })
  it('binds generation identity to governance head and effective state', () => {
    const first = governed('event')
    const second = governed('5')
    expect(first.generation_id).not.toBe(second.generation_id)
    expect(first.effective_state_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
  })
})
