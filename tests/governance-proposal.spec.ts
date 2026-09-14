import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { computeProjectScopeId, type ResolvedScope } from '../src/runtime-scope.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { publishOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import { readCurrentRecallWorldV1, readCurrentVersionedGenerationV1 } from '../src/v2/versioned-generation-store.js'
import { createGovernanceProductionRuntimeV1, rebuildGovernedGenerationV1 } from '../src/governance/runtime.js'
import { createGovernanceProposalV1, validateGovernanceProposalV1, computeGovernanceProposalHashV1, computeGovernanceProposalIdV1 } from '../src/governance/proposal.js'
import type { GovernanceHeadV1 } from '../src/protocol/governance.js'

function memory(scope: string, id: string, title: string): OKFMemoryV2 { const value: OKFMemoryV2 = { schema_version: 2, memory_id: id, project_scope_id: scope, title, summary: `${title} summary`, content: `${title} content`, related_memory_refs: [], created_at: '2026-09-14T00:00:00.000Z', content_sha256: '' }; value.content_sha256 = computeOKFMemoryV2Hash(value); return value }
function catalog(scope: string, ids: string[]): OKFCatalogV1 { const child = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Test'); const value: OKFCatalogV1 = { schema_version: 1, project_scope_id: scope, root_node_id: 'node_root', nodes: [{ node_id: 'node_root', title: 'Root', summary: 'Root', parent_node_id: null, child_node_refs: [child], memory_refs: [] }, { node_id: child, title: 'Test', summary: 'Test', parent_node_id: 'node_root', child_node_refs: [], memory_refs: ids }], updated_at: '2026-09-14T00:00:00.000Z', content_sha256: '' }; value.content_sha256 = computeOKFCatalogV1Hash(value); return value }
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-governance-proposal-'))); const scopeId = computeProjectScopeId(root); const scope = { schema_version: 1, session_id: 'proposal-test', project_root: root, source: 'explicit_config', project_scope_id: scopeId, session_scope_id: 'sha256_' + '1'.repeat(64) } as ResolvedScope; const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scopeId }); const a = memory(scopeId, 'mem_a', 'A'); const b = memory(scopeId, 'mem_b', 'B'); await store.putMemory(a); await store.putMemory(b); const written = await store.putCatalog(catalog(scopeId, [a.memory_id, b.memory_id])); await publishOKFGenerationV2({ project_root: root, project_scope_id: scopeId, catalog_id: written.catalog_id, created_at: '2026-09-14T00:00:01.000Z' }); return { root, scope, scopeId, a, b, store } }
function proposal(scopeId: string, generation_id: string, head: GovernanceHeadV1 | null, memoryRef: OKFMemoryV2, proposed_at = '2026-09-14T00:00:02.000Z') { return createGovernanceProposalV1({ schema_version: 1, project_scope_id: scopeId, base_generation_id: generation_id, base_governance_head: head, payload: { action: 'deactivate', memory: { memory_id: memoryRef.memory_id, content_sha256: memoryRef.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: memoryRef.memory_id, content_sha256: memoryRef.content_sha256 }], reason_code: 'test_proposal', proposed_at }) }

describe('Governance Proposal Layer', () => {
  it('creates deterministic, deeply immutable proposals and rejects tampering/noncanonical refs', () => {
    const draft = { schema_version: 1 as const, project_scope_id: 'sha256_' + '1'.repeat(64), base_generation_id: 'gen_' + '2'.repeat(64), base_governance_head: null, payload: { action: 'add_conflict' as const, first: { memory_id: 'mem_a', content_sha256: 'sha256_' + '3'.repeat(64) }, second: { memory_id: 'mem_b', content_sha256: 'sha256_' + '4'.repeat(64) } }, evidence_refs: [{ kind: 'memory' as const, memory_id: 'mem_a', content_sha256: 'sha256_' + '3'.repeat(64) }], reason_code: 'test_proposal', proposed_at: '2026-09-14T00:00:00.000Z' }
    const first = createGovernanceProposalV1(draft); const second = createGovernanceProposalV1(structuredClone(draft)); expect(first).toEqual(second); expect(first.proposal_id).toBe(computeGovernanceProposalIdV1(computeGovernanceProposalHashV1(draft))); expect(createGovernanceProposalV1({ ...draft, proposed_at: '2026-09-14T00:00:01.000Z' }).proposal_id).not.toBe(first.proposal_id); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.payload)).toBe(true); expect(() => validateGovernanceProposalV1({ ...first, proposal_id: 'prop_' + '0'.repeat(64) })).toThrow(); expect(() => validateGovernanceProposalV1({ ...first, extra: true })).toThrow(); expect(() => validateGovernanceProposalV1({ ...first, schema_version: 2 })).toThrow(); expect(() => createGovernanceProposalV1({ ...draft, base_generation_id: 'gen_bad' })).toThrow();
    const addConflict = first.payload as Extract<typeof first.payload, { action: 'add_conflict' }>; const reversed = { ...first, payload: { ...addConflict, first: addConflict.second, second: addConflict.first } }; expect(() => validateGovernanceProposalV1(reversed)).toThrow()
  })

  it('applies a fresh legacy proposal and creates the first governed generation', async () => {
    const f = await fixture(); try { const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId }); const p = proposal(f.scopeId, legacy.manifest.generation_id, null, f.a); const result = await createGovernanceProductionRuntimeV1({ now: () => '2026-09-14T00:00:03.000Z' }).applyProposal({ scope: f.scope, proposal: p }); expect(result.status).toBe('committed'); if (result.status === 'committed') { expect(result.event.created_at).toBe('2026-09-14T00:00:03.000Z'); expect(result.event.created_at).not.toBe(p.proposed_at) }; expect((await readCurrentVersionedGenerationV1({ project_root: f.root, project_scope_id: f.scopeId })).kind).toBe('governed') } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('returns stale when a consolidation changes generation but preserves a null head', async () => {
    const f = await fixture(); try { const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId }); const p = proposal(f.scopeId, legacy.manifest.generation_id, null, f.a); await publishOKFGenerationV2({ project_root: f.root, project_scope_id: f.scopeId, catalog_id: legacy.manifest.catalog_id, created_at: '2026-09-14T00:00:04.000Z' }); const result = await createGovernanceProductionRuntimeV1().applyProposal({ scope: f.scope, proposal: p }); expect(result.status).toBe('stale_proposal'); if (result.status === 'stale_proposal') expect(result.current_generation_id).not.toBe(p.base_generation_id); expect(await readdir(join(f.root, '.dsh-mnemosyne', 'v2', 'governance', 'events')).catch(() => [])).toEqual([]) } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects a fresh but semantically invalid proposal without writing an Event', async () => {
    const f = await fixture(); try { const runtime = createGovernanceProductionRuntimeV1(); const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId }); const p = proposal(f.scopeId, legacy.manifest.generation_id, null, f.a); expect((await runtime.applyProposal({ scope: f.scope, proposal: p })).status).toBe('committed'); const current = await readCurrentVersionedGenerationV1({ project_root: f.root, project_scope_id: f.scopeId }); const duplicate = proposal(f.scopeId, current.generation_id, current.governance_head, f.a, '2026-09-14T00:00:05.000Z'); const result = await runtime.applyProposal({ scope: f.scope, proposal: duplicate }); expect(result).toEqual({ status: 'rejected', reason_code: 'governance_event_rejected' }) } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('returns stale for both governed head changes and governed generation changes', async () => {
    const f = await fixture(); try {
      const runtime = createGovernanceProductionRuntimeV1({ now: () => '2026-09-14T00:00:07.000Z' })
      const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId })
      await runtime.applyProposal({ scope: f.scope, proposal: proposal(f.scopeId, legacy.manifest.generation_id, null, f.a) })
      const governed = await readCurrentVersionedGenerationV1({ project_root: f.root, project_scope_id: f.scopeId })
      const headProposal = proposal(f.scopeId, governed.generation_id, governed.governance_head, f.b, '2026-09-14T00:00:08.000Z')
      await runtime.commit({ scope: f.scope, payload: { action: 'deactivate', memory: { memory_id: f.b.memory_id, content_sha256: f.b.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: f.b.memory_id, content_sha256: f.b.content_sha256 }], reason_code: 'competing_commit', created_at: '2026-09-14T00:00:09.000Z' })
      expect((await runtime.applyProposal({ scope: f.scope, proposal: headProposal })).status).toBe('stale_proposal')
      const afterHead = await readCurrentVersionedGenerationV1({ project_root: f.root, project_scope_id: f.scopeId })
      const generationProposal = proposal(f.scopeId, afterHead.generation_id, afterHead.governance_head, f.a, '2026-09-14T00:00:10.000Z')
      await rebuildGovernedGenerationV1({ scope: f.scope, catalog_id: afterHead.manifest.catalog_id, created_at: '2026-09-14T00:00:11.000Z' })
      expect((await runtime.applyProposal({ scope: f.scope, proposal: generationProposal })).status).toBe('stale_proposal')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects cross-project proposals and does not mutate either project', async () => {
    const f = await fixture(); try { const other = await fixture(); try { const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId }); const p = proposal(f.scopeId, legacy.manifest.generation_id, null, f.a); const result = await createGovernanceProductionRuntimeV1().applyProposal({ scope: other.scope, proposal: p }); expect(result).toEqual({ status: 'rejected', reason_code: 'project_scope_mismatch' }); expect((await readCurrentRecallWorldV1({ project_root: other.root, project_scope_id: other.scopeId })).manifest.compiler_version).toBe('dsh-mnemosyne-okf-v2/1') } finally { await rm(other.root, { recursive: true, force: true }) } } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('checks freshness after entering the coordinator gate', async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve }); const releasePromise = new Promise<void>((resolve) => { release = resolve }); const coordinator = { async run<T>(_scope: string, operation: () => Promise<T>): Promise<T> { entered(); await releasePromise; return operation() } }; try { const legacy = await readCurrentRecallWorldV1({ project_root: f.root, project_scope_id: f.scopeId }); const p = proposal(f.scopeId, legacy.manifest.generation_id, null, f.a); const applying = createGovernanceProductionRuntimeV1({ coordinator }).applyProposal({ scope: f.scope, proposal: p }); await enteredPromise; await createGovernanceProductionRuntimeV1({ now: () => '2026-09-14T00:00:06.000Z' }).commit({ scope: f.scope, payload: { action: 'deactivate', memory: { memory_id: f.b.memory_id, content_sha256: f.b.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: f.b.memory_id, content_sha256: f.b.content_sha256 }], reason_code: 'competing_commit', created_at: '2026-09-14T00:00:06.000Z' }); release(); expect((await applying).status).toBe('stale_proposal') } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})
