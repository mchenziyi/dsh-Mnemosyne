import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { publishOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import { openGovernanceLedgerStore, createMemoryCurrentBoundary } from '../src/governance/ledger-store.js'
import { readCurrentVersionedGenerationV1 } from '../src/v2/versioned-generation-store.js'

const execFileAsync = promisify(execFile)
const workerPath = new URL('./helpers/governance-commit-worker.mjs', import.meta.url).pathname
const readWorkerPath = new URL('./helpers/governance-read-worker.mjs', import.meta.url).pathname

function memory(scope: string, id: string): OKFMemoryV2 {
  const value: OKFMemoryV2 = { schema_version: 2, memory_id: id, project_scope_id: scope, title: id, summary: id, content: id, related_memory_refs: [], created_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }
  value.content_sha256 = computeOKFMemoryV2Hash(value)
  return value
}

describe('Governance production process concurrency', () => {
  it('serializes independent Node processes through one CURRENT and committed chain', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-governance-process-')))
    try {
      const scope = computeProjectScopeId(root)
      const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
      const a = memory(scope, 'mem_a')
      const b = memory(scope, 'mem_b')
      await store.putMemory(a); await store.putMemory(b)
      const node = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Test')
      const rawCatalog: OKFCatalogV1 = { schema_version: 1, project_scope_id: scope, root_node_id: 'node_root', nodes: [{ node_id: 'node_root', title: 'Root', summary: 'Root', parent_node_id: null, child_node_refs: [node], memory_refs: [] }, { node_id: node, title: 'Test', summary: 'Test', parent_node_id: 'node_root', child_node_refs: [], memory_refs: [a.memory_id, b.memory_id] }], updated_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }
      rawCatalog.content_sha256 = computeOKFCatalogV1Hash(rawCatalog)
      const catalog = await store.putCatalog(rawCatalog)
      await publishOKFGenerationV2({ project_root: root, project_scope_id: scope, catalog_id: catalog.catalog_id, created_at: '2026-09-11T00:00:01.000Z' })
      const results = await Promise.all([a, b].map((memoryValue) => execFileAsync(process.execPath, ['--experimental-strip-types', workerPath, root, scope, memoryValue.memory_id, memoryValue.content_sha256])))
      const parsed = results.map((result) => JSON.parse(result.stdout) as { status: string; sequence?: number; code?: string })
      expect(parsed.filter((result) => result.status === 'committed')).toHaveLength(1)
      expect(parsed.filter((result) => result.status === 'failed' && result.code === 'memory_compile_busy')).toHaveLength(1)
      const world = await readCurrentVersionedGenerationV1({ project_root: root, project_scope_id: scope })
      expect(world.kind).toBe('governed')
      const head = world.governance_head!
      expect(head.sequence).toBe(1)
      const chain = await openGovernanceLedgerStore({ project_root: root, project_scope_id: scope, current: createMemoryCurrentBoundary(scope, head) }).loadCommittedChain(head)
      expect(chain).toHaveLength(1)
      const restarted = await execFileAsync(process.execPath, ['--experimental-strip-types', readWorkerPath, root, scope])
      expect(JSON.parse(restarted.stdout)).toEqual({ kind: 'governed', generation_id: world.generation_id, sequence: 1, visible: world.visible_memory_refs.map((ref) => ref.memory_id) })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30000)
})
