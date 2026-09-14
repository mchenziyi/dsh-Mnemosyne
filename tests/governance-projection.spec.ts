import { describe, expect, it } from 'vitest'
import { canonicalHash, withoutHash } from '../src/protocol/canonical.js'
import { createGovernanceEventV1, type GovernanceEventV1 } from '../src/protocol/governance.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { projectEffectiveWorldV1 } from '../src/governance/projection.js'
import { replayGovernanceV1 } from '../src/governance/replay.js'

const PROJECT = `sha256_${'a'.repeat(64)}`
function memory(id: string, related_memory_refs: string[] = []): OKFMemoryV2 { const body = { schema_version: 2 as const, memory_id: id, project_scope_id: PROJECT, title: id.toUpperCase(), summary: `summary ${id}`, content: `content ${id}`, related_memory_refs, created_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }; return { ...body, content_sha256: computeOKFMemoryV2Hash(body) } }
const A = memory('mem_a', ['mem_b', 'mem_c'])
const B = memory('mem_b')
const C = memory('mem_c')
const rootChild = computeOKFCatalogNodeIdV1(PROJECT, 'node_root', 'Auth')
function catalog(): OKFCatalogV1 { const body = { schema_version: 1 as const, project_scope_id: PROJECT, root_node_id: 'node_root', nodes: [{ node_id: 'node_root', title: 'Root', summary: 'Root', parent_node_id: null, child_node_refs: [rootChild], memory_refs: [] }, { node_id: rootChild, title: 'Auth', summary: 'Auth', parent_node_id: 'node_root', child_node_refs: [], memory_refs: ['mem_a', 'mem_b', 'mem_c'] }], updated_at: '2026-09-11T00:00:00.000Z', content_sha256: '' }; return { ...body, content_sha256: computeOKFCatalogV1Hash(body) } }
function event(payload: GovernanceEventV1['payload'], sequence: number, previous?: GovernanceEventV1): GovernanceEventV1 { return createGovernanceEventV1({ schema_version: 1, project_scope_id: PROJECT, sequence, prev_event_hash: previous?.event_sha256 ?? null, payload, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'projection', created_at: `2026-09-11T00:00:0${sequence}.000Z` }) }
function project(events: GovernanceEventV1[] = []) { const effective = replayGovernanceV1({ project_scope_id: PROJECT, memories: [A, B, C].map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256, project_scope_id: PROJECT })), events }).effective_memories; const tail = events.at(-1); return projectEffectiveWorldV1({ project_scope_id: PROJECT, governance_head: tail ? { sequence: tail.sequence, event_id: tail.event_id, event_sha256: tail.event_sha256 } : null, raw_memories: [A, B, C], raw_catalog: catalog(), effective_memories: effective, governance_events: events }) }

describe('Governance Effective World Slice 5', () => {
  it('projects all active memories and preserves raw inputs', () => {
    const raw = structuredClone({ memories: [A, B, C], catalog: catalog() }); const output = project(); expect(output.visible_memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_a', 'mem_b', 'mem_c']); expect(output.effective_catalog.nodes.find((node) => node.node_id === rootChild)!.memory_refs).toEqual(['mem_a', 'mem_b', 'mem_c']); expect({ memories: [A, B, C], catalog: catalog() }).toEqual(raw)
  })
  it('hides superseded and inactive memories while retaining root and pruning empty nodes', () => {
    const e1 = event({ action: 'deactivate', memory: { memory_id: C.memory_id, content_sha256: C.content_sha256 } }, 1); const output = project([e1]); expect(output.visible_memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_a', 'mem_b']); expect(output.effective_catalog.nodes.find((node) => node.node_id === rootChild)!.memory_refs).toEqual(['mem_a', 'mem_b'])
  })
  it('filters related refs without mutating raw memory', () => {
    const e1 = event({ action: 'deactivate', memory: { memory_id: C.memory_id, content_sha256: C.content_sha256 } }, 1); const output = project([e1]); expect(output.effective_memory_outputs.find((memory) => memory.source_memory_ref.memory_id === 'mem_a')!.related_memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_b']); expect(A.related_memory_refs).toEqual(['mem_b', 'mem_c'])
  })
  it('emits bidirectional and deterministic conflict metadata', () => {
    const e1 = event({ action: 'add_conflict', first: { memory_id: A.memory_id, content_sha256: A.content_sha256 }, second: { memory_id: B.memory_id, content_sha256: B.content_sha256 } }, 1); const output = project([e1]); const a = output.effective_memory_outputs.find((memory) => memory.source_memory_ref.memory_id === 'mem_a')!; const b = output.effective_memory_outputs.find((memory) => memory.source_memory_ref.memory_id === 'mem_b')!; expect(a.conflicts[0]).toMatchObject({ peer: { memory_ref: { memory_id: B.memory_id, content_sha256: B.content_sha256 }, title: 'MEM_B', lifecycle_status: 'active' }, status: 'unresolved' }); expect(b.conflicts[0]).toMatchObject({ peer: { memory_ref: { memory_id: A.memory_id, content_sha256: A.content_sha256 }, title: 'MEM_A', lifecycle_status: 'active' }, status: 'unresolved' })
  })
  it('removes resolved conflict metadata and supports empty effective trees', () => {
    const e1 = event({ action: 'add_conflict', first: { memory_id: A.memory_id, content_sha256: A.content_sha256 }, second: { memory_id: B.memory_id, content_sha256: B.content_sha256 } }, 1); const e2 = event({ action: 'resolve_conflict', conflict_event: { event_id: e1.event_id, event_sha256: e1.event_sha256 }, resolution: { kind: 'dismiss' } }, 2, e1); expect(project([e1, e2]).effective_memory_outputs.every((memory) => memory.conflicts.length === 0)).toBe(true)
    const hiddenA = event({ action: 'deactivate', memory: { memory_id: A.memory_id, content_sha256: A.content_sha256 } }, 1); const hiddenB = event({ action: 'deactivate', memory: { memory_id: B.memory_id, content_sha256: B.content_sha256 } }, 2, hiddenA); const hiddenC = event({ action: 'deactivate', memory: { memory_id: C.memory_id, content_sha256: C.content_sha256 } }, 3, hiddenB); const allHidden = [hiddenA, hiddenB, hiddenC]; expect(project(allHidden).effective_catalog.nodes.map((node) => node.node_id)).toEqual(['node_root'])
  })
  it('changes effective catalog identity when visibility changes and remains deterministic', () => {
    const first = project(); const e1 = event({ action: 'deactivate', memory: { memory_id: C.memory_id, content_sha256: C.content_sha256 } }, 1); const second = project([e1]); expect(first.effective_catalog_id).not.toBe(second.effective_catalog_id); expect(project([e1])).toEqual(second)
  })
  it('fails closed on missing effective memory, raw inconsistency, or hidden conflict peer', () => {
    expect(() => projectEffectiveWorldV1({ project_scope_id: PROJECT, raw_memories: [A, B], raw_catalog: catalog(), effective_memories: [], governance_events: [] })).toThrow()
    const e1 = event({ action: 'add_conflict', first: { memory_id: A.memory_id, content_sha256: A.content_sha256 }, second: { memory_id: B.memory_id, content_sha256: B.content_sha256 } }, 1); const effective = replayGovernanceV1({ project_scope_id: PROJECT, memories: [A, B, C].map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256, project_scope_id: PROJECT })), events: [e1] }).effective_memories.map((memory) => memory.memory_ref.memory_id === B.memory_id ? { ...memory, lifecycle_status: 'superseded' as const } : memory); expect(() => projectEffectiveWorldV1({ project_scope_id: PROJECT, raw_memories: [A, B, C], raw_catalog: catalog(), effective_memories: effective, governance_events: [e1] })).toThrow()
  })
})
