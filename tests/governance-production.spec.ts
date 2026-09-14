import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { publishOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import { readCurrentRecallWorldV1, readCurrentVersionedGenerationV1 } from '../src/v2/versioned-generation-store.js'
import { createGovernanceProductionRuntimeV1 } from '../src/governance/runtime.js'
import { createConsolidationRuntimeV2 } from '../src/v2/consolidation-runtime.js'

function memory(scope: string, id: string, title: string): OKFMemoryV2 { const value: OKFMemoryV2 = { schema_version: 2, memory_id: id, project_scope_id: scope, title, summary: `${title} summary`, content: `${title} content`, related_memory_refs: [], created_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }; value.content_sha256 = computeOKFMemoryV2Hash(value); return value }
function catalog(scope: string, ids: string[]): OKFCatalogV1 { const node = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Test'); const value: OKFCatalogV1 = { schema_version: 1, project_scope_id: scope, root_node_id: 'node_root', nodes: [{ node_id: 'node_root', title: 'Root', summary: 'Root', parent_node_id: null, child_node_refs: [node], memory_refs: [] }, { node_id: node, title: 'Test', summary: 'Test', parent_node_id: 'node_root', child_node_refs: [], memory_refs: ids }], updated_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }; value.content_sha256 = computeOKFCatalogV1Hash(value); return value }

describe('Governance production integration Slice 6', () => {
  it('atomically upgrades a legacy CURRENT on the first real Governance commit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-governance-production-'))); const scope = computeProjectScopeId(root); const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope }); const a = memory(scope, 'mem_a', 'A'); const b = memory(scope, 'mem_b', 'B'); await store.putMemory(a); await store.putMemory(b); const catalogResult = await store.putCatalog(catalog(scope, [a.memory_id, b.memory_id])); await publishOKFGenerationV2({ project_root: root, project_scope_id: scope, catalog_id: catalogResult.catalog_id, created_at: '2026-09-11T00:00:01.000Z' })
    try {
      const runtime = createGovernanceProductionRuntimeV1()
      const result = await runtime.commit({ scope: { project_root: root, project_scope_id: scope } as never, payload: { action: 'deactivate', memory: { memory_id: a.memory_id, content_sha256: a.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: a.memory_id, content_sha256: a.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:02.000Z' })
      const world = await readCurrentVersionedGenerationV1({ project_root: root, project_scope_id: scope })
      expect(result.governance_head.sequence).toBe(1); expect(world.kind).toBe('governed'); expect(world.visible_memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_b']); expect(world.files.get('indexes/nodes/' + computeOKFCatalogNodeIdV1(scope, 'node_root', 'Test') + '.json')).not.toContain('mem_a')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('leaves CURRENT on legacy when the process fails after staging and before the switch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-governance-pre-switch-')))
    const scope = computeProjectScopeId(root)
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    const a = memory(scope, 'mem_a', 'A')
    await store.putMemory(a)
    const catalogResult = await store.putCatalog(catalog(scope, [a.memory_id]))
    await publishOKFGenerationV2({ project_root: root, project_scope_id: scope, catalog_id: catalogResult.catalog_id, created_at: '2026-09-11T00:00:01.000Z' })
    try {
      const runtime = createGovernanceProductionRuntimeV1({ before_current_switch: () => { throw new Error('simulated_crash') } })
      await expect(runtime.commit({ scope: { project_root: root, project_scope_id: scope } as never, payload: { action: 'deactivate', memory: { memory_id: a.memory_id, content_sha256: a.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: a.memory_id, content_sha256: a.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:02.000Z' })).rejects.toThrow('simulated_crash')
      const current = await readCurrentRecallWorldV1({ project_root: root, project_scope_id: scope })
      expect(current.manifest.compiler_version).toBe('dsh-mnemosyne-okf-v2/1')
      expect(current.manifest.memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_a'])
      expect(await readdir(join(root, '.dsh-mnemosyne', 'v2', 'governance', 'events'))).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not recreate or reactivate a governed hidden duplicate during Consolidation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-governance-duplicate-')))
    const scopeId = computeProjectScopeId(root)
    const scope = { project_root: root, project_scope_id: scopeId } as never
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scopeId })
    const a = memory(scopeId, 'mem_a', 'A')
    await store.putMemory(a)
    const catalogResult = await store.putCatalog(catalog(scopeId, [a.memory_id]))
    await publishOKFGenerationV2({ project_root: root, project_scope_id: scopeId, catalog_id: catalogResult.catalog_id, created_at: '2026-09-11T00:00:01.000Z' })
    try {
      await createGovernanceProductionRuntimeV1().commit({ scope, payload: { action: 'deactivate', memory: { memory_id: a.memory_id, content_sha256: a.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: a.memory_id, content_sha256: a.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:02.000Z' })
      const before = await readCurrentVersionedGenerationV1({ project_root: root, project_scope_id: scopeId })
      const consolidation = createConsolidationRuntimeV2({ model: async () => ({ decision: 'create', title: a.title, summary: a.summary, content: a.content, related_memory_refs: [] }) })
      const result = await consolidation.consolidate({ scope, evidence: { task: 'same', outcome: 'same' }, used_memory_refs: [], provider: 'test', model: 'test', now: '2026-09-11T00:00:03.000Z', signal: new AbortController().signal })
      expect(result).toEqual({ status: 'failed', reason_code: 'governance_hidden_duplicate', memory_id: a.memory_id })
      expect(await store.listMemories()).toHaveLength(1)
      const after = await readCurrentVersionedGenerationV1({ project_root: root, project_scope_id: scopeId })
      expect(after.generation_id).toBe(before.generation_id)
      expect(after.governance_head).toEqual(before.governance_head)
      expect(after.visible_memory_refs).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
