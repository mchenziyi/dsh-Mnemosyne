import { createGovernanceEventV1, validateGovernanceEventReferencesV1, type GovernanceEventDraftV1, type GovernanceEventPayloadV1, type GovernanceEvidenceRefV1, type GovernanceHeadV1 } from '../protocol/governance.js'
import { openOKFMemoryV2Store } from '../v2/okf-memory-store.js'
import { readCurrentVersionedGenerationV1, publishImmutableVersionedGenerationV1, withV2CurrentTransaction } from '../v2/versioned-generation-store.js'
import { readV2CurrentSnapshotV1 } from '../v2/current-transaction.js'
import { openGovernanceLedgerStore, createMemoryCurrentBoundary } from './ledger-store.js'
import { replayGovernanceV1 } from './replay.js'
import { compileGovernedGenerationV1 } from './compiler.js'
import type { ResolvedScope } from '../runtime-scope.js'

export interface GovernanceProductionCommitInputV1 { scope: ResolvedScope; payload: GovernanceEventPayloadV1; evidence_refs: GovernanceEvidenceRefV1[]; reason_code: string; created_at: string }
export interface GovernanceProductionCommitResultV1 { event: ReturnType<typeof createGovernanceEventV1>; generation_id: string; governance_head: GovernanceHeadV1 }
export interface GovernanceProductionRuntimeV1 { commit(input: GovernanceProductionCommitInputV1): Promise<GovernanceProductionCommitResultV1> }

export async function rebuildGovernedGenerationV1(input: { scope: ResolvedScope; catalog_id: string; created_at: string; lock_held?: boolean }): Promise<{ generation_id: string }> {
  const operation = async () => {
    const current = await readCurrentVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
    if (current.kind !== 'governed') throw new Error('governed_generation_required')
    const governanceHead = current.governance_head
    if (!governanceHead) throw new Error('governed_generation_head_missing')
    const store = openOKFMemoryV2Store({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
    const catalog = await store.getCatalog(input.catalog_id)
    const rawMemories = await Promise.all([...new Set(catalog.nodes.flatMap((node) => node.memory_refs))].map((id) => store.getMemory(id)))
    const records = rawMemories.map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256, project_scope_id: input.scope.project_scope_id }))
    const ledger = openGovernanceLedgerStore({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id, current: createMemoryCurrentBoundary(input.scope.project_scope_id, governanceHead) })
    const chain = await ledger.loadCommittedChain(governanceHead)
    const replay = replayGovernanceV1({ project_scope_id: input.scope.project_scope_id, memories: records, events: chain })
    const compiled = compileGovernedGenerationV1({ project_scope_id: input.scope.project_scope_id, raw_catalog: catalog, raw_memories: rawMemories, effective_memories: replay.effective_memories, governance_events: chain, governance_head: governanceHead, created_at: input.created_at })
    await publishImmutableVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id, compiled, expected: await readV2CurrentSnapshotV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id }) })
    return { generation_id: compiled.generation_id }
  }
  return input.lock_held
    ? await operation()
    : await withV2CurrentTransaction({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id }, operation)
}

export function createGovernanceProductionRuntimeV1(options: { coordinator?: { run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T> }; before_current_switch?: () => void | Promise<void> } = {}): GovernanceProductionRuntimeV1 {
  return { commit: async (input: GovernanceProductionCommitInputV1): Promise<GovernanceProductionCommitResultV1> => {
    const execute = async () => withV2CurrentTransaction({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id }, async () => {
      const current = await readCurrentVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
      const head = current.kind === 'governed' ? current.governance_head : null
      const ledger = openGovernanceLedgerStore({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id, current: createMemoryCurrentBoundary(input.scope.project_scope_id, head) })
      const chain = await ledger.loadCommittedChain(head)
      const store = openOKFMemoryV2Store({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
      const rawRefs = current.manifest.memory_refs
      const rawMemories = await Promise.all(rawRefs.map((ref) => store.getMemory(ref.memory_id)))
      const records = rawMemories.map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256, project_scope_id: input.scope.project_scope_id }))
      const draft: GovernanceEventDraftV1 = { schema_version: 1, project_scope_id: input.scope.project_scope_id, sequence: head ? head.sequence + 1 : 1, prev_event_hash: head?.event_sha256 ?? null, payload: input.payload, evidence_refs: input.evidence_refs, reason_code: input.reason_code, created_at: input.created_at }
      const event = createGovernanceEventV1(draft)
      validateGovernanceEventReferencesV1(event, { project_scope_id: input.scope.project_scope_id, current_head: head, memories: records, committed_events: chain })
      await ledger.writeEventExclusive(event)
      const candidateChain = [...chain, event]
      const replay = replayGovernanceV1({ project_scope_id: input.scope.project_scope_id, memories: records, events: candidateChain })
      const compiled = compileGovernedGenerationV1({ project_scope_id: input.scope.project_scope_id, raw_catalog: await store.getCatalog(current.manifest.catalog_id), raw_memories: rawMemories, effective_memories: replay.effective_memories, governance_events: candidateChain, governance_head: { sequence: event.sequence, event_id: event.event_id, event_sha256: event.event_sha256 }, created_at: input.created_at })
      await publishImmutableVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id, compiled, expected: await readV2CurrentSnapshotV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id }), before_current_switch: options.before_current_switch })
      return { event, generation_id: compiled.generation_id, governance_head: { sequence: event.sequence, event_id: event.event_id, event_sha256: event.event_sha256 } }
    })
    return options.coordinator ? options.coordinator.run(input.scope.project_scope_id, execute) : execute()
  } }
}

export const commitGovernanceEventProductionV1: typeof createGovernanceProductionRuntimeV1 = createGovernanceProductionRuntimeV1
