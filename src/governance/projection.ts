import { canonicalHash, compareCodePoints, ProtocolValidationError } from '../protocol/canonical.js'
import { compareGovernanceEventRefsV1, compareGovernanceMemoryRefsV1, validateGovernanceEventV1, type GovernanceEventRefV1, type GovernanceEventV1 } from '../protocol/governance.js'
import { catalogId, validateOKFCatalogV1, type OKFCatalogV1, type OKFCatalogNodeV1 } from '../v2/okf-catalog.js'
import { validateOKFMemoryV2, type OKFMemoryV2 } from '../v2/okf-memory.js'
import { replayGovernanceV1, type EffectiveMemoryV1 } from './replay.js'

export interface EffectiveConflictMetadataV1 { conflict_event: GovernanceEventRefV1; status: 'unresolved'; peer: { memory_ref: { memory_id: string; content_sha256: string }; title: string; lifecycle_status: 'active' } }
export interface EffectiveMemoryOutputV1 { schema_version: 1; project_scope_id: string; source_memory_ref: { memory_id: string; content_sha256: string }; title: string; summary: string; content: string; related_memory_refs: Array<{ memory_id: string; content_sha256: string }>; conflicts: EffectiveConflictMetadataV1[]; governance_event_refs: GovernanceEventRefV1[]; effective_output_sha256: string }
export interface EffectiveCatalogV1 { schema_version: 1; project_scope_id: string; source_catalog: { catalog_id: string; catalog_sha256: string }; governance_head: { sequence: number; event_id: string; event_sha256: string } | null; root_node_id: string; visible_memory_refs: Array<{ memory_id: string; content_sha256: string }>; nodes: OKFCatalogNodeV1[]; content_sha256: string }
export interface EffectiveWorldProjectionV1 { raw_memory_refs: Array<{ memory_id: string; content_sha256: string }>; visible_memory_refs: Array<{ memory_id: string; content_sha256: string }>; effective_catalog: EffectiveCatalogV1; effective_catalog_id: string; effective_catalog_sha256: string; effective_memory_outputs: EffectiveMemoryOutputV1[]; effective_state_sha256: string }
export interface EffectiveWorldProjectionInputV1 { project_scope_id: string; governance_head?: { sequence: number; event_id: string; event_sha256: string } | null; raw_memories: readonly OKFMemoryV2[]; raw_catalog: OKFCatalogV1; effective_memories: readonly EffectiveMemoryV1[]; governance_events?: readonly GovernanceEventV1[] }

function invalid(message = 'effective_projection_invalid'): never { throw new ProtocolValidationError(message) }
function ref(memory: OKFMemoryV2) { return { memory_id: memory.memory_id, content_sha256: memory.content_sha256 } }
function eventRef(event: GovernanceEventV1): GovernanceEventRefV1 { return { event_id: event.event_id, event_sha256: event.event_sha256 } }

export function projectEffectiveWorldV1(input: EffectiveWorldProjectionInputV1): EffectiveWorldProjectionV1 {
  if (typeof input.project_scope_id !== 'string') invalid()
  const rawCatalog = validateOKFCatalogV1(input.raw_catalog)
  if (rawCatalog.project_scope_id !== input.project_scope_id) invalid('catalog_scope_mismatch')
  const memories = input.raw_memories.map((raw) => validateOKFMemoryV2(raw))
  const byId = new Map<string, OKFMemoryV2>()
  for (const memory of memories) { if (memory.project_scope_id !== input.project_scope_id || byId.has(memory.memory_id)) invalid('raw_memory_invalid'); byId.set(memory.memory_id, memory) }
  const catalogRefs = rawCatalog.nodes.flatMap((node) => node.memory_refs)
  const rawIds = [...byId.keys()].sort(compareCodePoints)
  if (catalogRefs.length !== rawIds.length || [...new Set(catalogRefs)].sort(compareCodePoints).join('\0') !== rawIds.join('\0')) invalid('raw_world_inconsistent')
  for (const memory of memories) for (const related of memory.related_memory_refs) if (!byId.has(related)) invalid('raw_related_ref_missing')
  const effectiveById = new Map<string, EffectiveMemoryV1>()
  for (const effective of input.effective_memories) { if (effective.memory_ref.content_sha256 !== byId.get(effective.memory_ref.memory_id)?.content_sha256) invalid('effective_memory_unresolved'); if (effective.unresolved_conflict_refs.length > 0 && effective.lifecycle_status !== 'active') invalid('conflict_requires_active'); if (effectiveById.has(effective.memory_ref.memory_id)) invalid('duplicate_effective_memory'); effectiveById.set(effective.memory_ref.memory_id, effective) }
  if (effectiveById.size !== byId.size) invalid('effective_memory_set_mismatch')
  const visible = memories.filter((memory) => effectiveById.get(memory.memory_id)!.lifecycle_status === 'active').sort((a, b) => compareGovernanceMemoryRefsV1(ref(a), ref(b)))
  const visibleIds = new Set(visible.map((memory) => memory.memory_id))
  const events = new Map<string, GovernanceEventV1>()
  for (const raw of input.governance_events ?? []) { const event = validateGovernanceEventV1(raw); if (event.project_scope_id !== input.project_scope_id || events.has(event.event_id)) invalid('conflict_event_invalid'); events.set(event.event_id, event) }
  const nodes = new Map(rawCatalog.nodes.map((node) => [node.node_id, node]))
  const projectNode = (nodeId: string): OKFCatalogNodeV1 | null => {
    const source = nodes.get(nodeId); if (!source) invalid('catalog_node_missing')
    const children = source.child_node_refs.map((child) => projectNode(child)).filter((child): child is OKFCatalogNodeV1 => child !== null).sort((a, b) => compareCodePoints(a.node_id, b.node_id))
    const memoryRefs = source.memory_refs.filter((id) => visibleIds.has(id)).sort(compareCodePoints)
    if (nodeId !== rawCatalog.root_node_id && children.length === 0 && memoryRefs.length === 0) return null
    return { node_id: source.node_id, title: source.title, summary: source.summary, parent_node_id: source.parent_node_id, child_node_refs: children.map((child) => child.node_id), memory_refs: memoryRefs }
  }
  const root = projectNode(rawCatalog.root_node_id); if (!root) invalid('root_pruned')
  const projectedNodes = [root, ...rawCatalog.nodes.filter((node) => node.node_id !== rawCatalog.root_node_id).map((node) => projectNode(node.node_id)).filter((node): node is OKFCatalogNodeV1 => node !== null)].filter((node, index, all) => all.findIndex((candidate) => candidate.node_id === node.node_id) === index).sort((a, b) => compareCodePoints(a.node_id, b.node_id))
  const visibleRefs = visible.map(ref).sort(compareGovernanceMemoryRefsV1)
  const effectiveCatalogBody = { schema_version: 1 as const, project_scope_id: input.project_scope_id, source_catalog: { catalog_id: catalogId(rawCatalog), catalog_sha256: rawCatalog.content_sha256 }, governance_head: input.governance_head ?? null, root_node_id: rawCatalog.root_node_id, visible_memory_refs: visibleRefs, nodes: projectedNodes }
  const effectiveHash = canonicalHash(effectiveCatalogBody)
  const effectiveCatalog: EffectiveCatalogV1 = { ...effectiveCatalogBody, content_sha256: effectiveHash }
  const visibleCatalogRefs = projectedNodes.flatMap((node) => node.memory_refs).sort(compareCodePoints)
  if (visibleCatalogRefs.join('\0') !== visible.map((memory) => memory.memory_id).sort(compareCodePoints).join('\0')) invalid('effective_catalog_memory_mismatch')
  const outputs = visible.map((memory) => {
    const effective = effectiveById.get(memory.memory_id)!
    const conflicts = effective.unresolved_conflict_refs.map((conflictRef) => {
      const event = events.get(conflictRef.event_id); if (!event || event.event_sha256 !== conflictRef.event_sha256 || event.payload.action !== 'add_conflict') invalid('conflict_event_unresolved')
      const peer = event.payload.first.memory_id === memory.memory_id ? event.payload.second : event.payload.first
      const peerMemory = byId.get(peer.memory_id); if (!peerMemory || !visibleIds.has(peer.memory_id)) invalid('conflict_peer_not_visible')
      return { conflict_event: eventRef(event), status: 'unresolved' as const, peer: { memory_ref: ref(peerMemory), title: peerMemory.title, lifecycle_status: 'active' as const } }
    }).sort((a, b) => compareGovernanceEventRefsV1(a.conflict_event, b.conflict_event) || compareGovernanceMemoryRefsV1(a.peer.memory_ref, b.peer.memory_ref))
    const related_memory_refs = memory.related_memory_refs.filter((id) => visibleIds.has(id)).map((id) => ref(byId.get(id)!)).sort(compareGovernanceMemoryRefsV1)
    const outputBody = { schema_version: 1 as const, project_scope_id: input.project_scope_id, source_memory_ref: ref(memory), title: memory.title, summary: memory.summary, content: memory.content, related_memory_refs, conflicts, governance_event_refs: effective.governance_event_refs.map((eventRef) => ({ ...eventRef })).sort(compareGovernanceEventRefsV1) }
    return { ...outputBody, effective_output_sha256: canonicalHash(outputBody) }
  })
  const rawRefs = memories.map(ref).sort(compareGovernanceMemoryRefsV1)
  const state = { schema_version: 1 as const, project_scope_id: input.project_scope_id, source_catalog: { catalog_id: catalogId(rawCatalog), catalog_sha256: rawCatalog.content_sha256 }, raw_memory_refs: rawRefs, visible_memory_refs: visibleRefs, governance_head: input.governance_head ?? null, effective_catalog: { effective_catalog_id: `ecatalog_${effectiveHash.slice(7)}`, effective_catalog_sha256: effectiveHash }, effective_memory_outputs: outputs.map((output) => ({ source_memory_ref: output.source_memory_ref, effective_output_sha256: output.effective_output_sha256 })) }
  return { raw_memory_refs: rawRefs, visible_memory_refs: visibleRefs, effective_catalog: effectiveCatalog, effective_catalog_id: `ecatalog_${effectiveHash.slice(7)}`, effective_catalog_sha256: effectiveHash, effective_memory_outputs: outputs, effective_state_sha256: canonicalHash(state) }
}

export const projectEffectiveWorld: typeof projectEffectiveWorldV1 = projectEffectiveWorldV1
