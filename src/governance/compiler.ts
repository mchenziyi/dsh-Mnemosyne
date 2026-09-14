import { canonicalBytes, canonicalHash, compareCodePoints, sha256 } from '../protocol/canonical.js'
import { catalogId, validateOKFCatalogV1, type OKFCatalogV1 } from '../v2/okf-catalog.js'
import { validateOKFMemoryV2, type OKFMemoryV2 } from '../v2/okf-memory.js'
import { createGovernedGenerationManifestV1, validateGovernedGenerationManifestV1, type GovernedGenerationManifestV1 } from './generation.js'
import { projectEffectiveWorldV1, type EffectiveWorldProjectionV1 } from './projection.js'
import type { GovernanceEventV1, GovernanceHeadV1 } from '../protocol/governance.js'
import type { EffectiveMemoryV1 } from './replay.js'

export interface CompiledGovernedGenerationV1 { generation_id: string; manifest: GovernedGenerationManifestV1; files: Map<string, string> }

function json(value: unknown): string { return canonicalBytes(value) }

export function compileGovernedGenerationV1(input: { project_scope_id: string; raw_catalog: OKFCatalogV1; raw_memories: readonly OKFMemoryV2[]; effective_memories: readonly EffectiveMemoryV1[]; governance_events: readonly GovernanceEventV1[]; governance_head: GovernanceHeadV1; created_at: string }): CompiledGovernedGenerationV1 {
  const catalog = validateOKFCatalogV1(input.raw_catalog)
  const memories = input.raw_memories.map(validateOKFMemoryV2)
  const world: EffectiveWorldProjectionV1 = projectEffectiveWorldV1({ project_scope_id: input.project_scope_id, raw_catalog: catalog, raw_memories: memories, effective_memories: input.effective_memories, governance_events: input.governance_events, governance_head: input.governance_head })
  const memoryById = new Map(memories.map((memory) => [memory.memory_id, memory]))
  const outputById = new Map(world.effective_memory_outputs.map((output) => [output.source_memory_ref.memory_id, output]))
  const files = new Map<string, string>()
  const root = world.effective_catalog.nodes.find((node) => node.node_id === world.effective_catalog.root_node_id)
  if (!root) throw new Error('governed_root_missing')
  files.set('indexes/root.json', json({ schema_version: 1, root_node_id: root.node_id, children: root.child_node_refs.map((id) => { const node = world.effective_catalog.nodes.find((candidate) => candidate.node_id === id)!; return { ref: id, title: node.title } }) }))
  for (const node of [...world.effective_catalog.nodes].sort((a, b) => compareCodePoints(a.node_id, b.node_id))) files.set(`indexes/nodes/${node.node_id}.json`, json({ schema_version: 1, node_id: node.node_id, title: node.title, summary: node.summary, children: node.child_node_refs.map((id) => { const child = world.effective_catalog.nodes.find((candidate) => candidate.node_id === id)!; return { ref: id, title: child.title } }), memories: node.memory_refs.map((id) => { const memory = memoryById.get(id)!; const output = outputById.get(id)!; return { ref: id, title: memory.title, conflicts: output.conflicts } }) }))
  for (const output of world.effective_memory_outputs) {
    const memory = memoryById.get(output.source_memory_ref.memory_id)!; files.set(`summaries/${memory.memory_id}.json`, json({ schema_version: 1, memory_id: memory.memory_id, title: output.title, summary: output.summary, conflicts: output.conflicts, related_memory_refs: output.related_memory_refs }))
    const related = output.related_memory_refs.map((ref) => `- ${memoryById.get(ref.memory_id)!.title} (${ref.memory_id})`)
    const conflict = output.conflicts.length ? `\n\n## 未解决冲突\n\n${output.conflicts.map((item) => `- ${item.peer.title} (${item.peer.memory_ref.memory_id}) [${item.conflict_event.event_id}]`).join('\n')}` : ''
    files.set(`contents/${memory.memory_id}.md`, `# ${output.title}\n\n${output.content}${conflict}\n\n## 相关记忆\n\n${related.length ? related.join('\n') : '- 无'}\n`)
  }
  const outputRefs = [...files].map(([path, content]) => ({ path, content_sha256: sha256(content), byte_length: Buffer.byteLength(content, 'utf8') })).sort((a, b) => compareCodePoints(a.path, b.path))
  const manifest = createGovernedGenerationManifestV1({ schema_version: 2, project_scope_id: input.project_scope_id, compiler_version: 'dsh-mnemosyne-okf-governance-v1/1', catalog_id: catalogId(catalog), catalog_sha256: catalog.content_sha256, memory_refs: world.raw_memory_refs, output_refs: outputRefs, created_at: input.created_at, visible_memory_refs: world.visible_memory_refs, governance_head: input.governance_head, effective_catalog_id: world.effective_catalog_id, effective_catalog_sha256: world.effective_catalog_sha256, effective_state_sha256: world.effective_state_sha256 })
  files.set('manifest.json', json(manifest))
  return { generation_id: manifest.generation_id, manifest, files: new Map([...files].sort(([a], [b]) => compareCodePoints(a, b))) }
}

export function verifyGovernedGenerationV1(manifest: unknown): GovernedGenerationManifestV1 { return validateGovernedGenerationManifestV1(manifest) }
