import { createGovernanceEventV1, validateGovernanceEventReferencesV1, type GovernanceEventDraftV1, type GovernanceEventPayloadV1, type GovernanceEvidenceRefV1, type GovernanceHeadV1 } from '../protocol/governance.js'
import { ProtocolValidationError } from '../protocol/canonical.js'
import { validateGovernanceProposalV1, sameGovernanceHeadV1, type GovernanceProposalV1 } from './proposal.js'
import { openOKFMemoryV2Store } from '../v2/okf-memory-store.js'
import { readCurrentVersionedGenerationV1, publishImmutableVersionedGenerationV1, withV2CurrentTransaction } from '../v2/versioned-generation-store.js'
import { readV2CurrentSnapshotV1 } from '../v2/current-transaction.js'
import { openGovernanceLedgerStore, createMemoryCurrentBoundary } from './ledger-store.js'
import { replayGovernanceV1 } from './replay.js'
import { compileGovernedGenerationV1 } from './compiler.js'
import type { ResolvedScope } from '../runtime-scope.js'

export interface GovernanceProductionCommitInputV1 { scope: ResolvedScope; payload: GovernanceEventPayloadV1; evidence_refs: GovernanceEvidenceRefV1[]; reason_code: string; created_at: string }
export interface GovernanceProductionCommitResultV1 { event: ReturnType<typeof createGovernanceEventV1>; generation_id: string; governance_head: GovernanceHeadV1 }
export type GovernanceProposalApplyResultV1 =
  | ({ status: 'committed' } & GovernanceProductionCommitResultV1)
  | { status: 'stale_proposal'; current_generation_id: string; current_governance_head: GovernanceHeadV1 | null }
  | { status: 'rejected'; reason_code: 'proposal_invalid' | 'project_scope_mismatch' | 'governance_event_rejected' }
export interface GovernanceProductionRuntimeV1 {
  commit(input: GovernanceProductionCommitInputV1): Promise<GovernanceProductionCommitResultV1>
  applyProposal(input: { scope: ResolvedScope; proposal: unknown }): Promise<GovernanceProposalApplyResultV1>
}

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

export function createGovernanceProductionRuntimeV1(options: { coordinator?: { run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T> }; before_current_switch?: () => void | Promise<void>; now?: () => string } = {}): GovernanceProductionRuntimeV1 {
  const commitWithinCurrentTransaction = async (input: GovernanceProductionCommitInputV1, currentOverride?: Awaited<ReturnType<typeof readCurrentVersionedGenerationV1>>): Promise<GovernanceProductionCommitResultV1> => {
      const current = currentOverride ?? await readCurrentVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
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
      const candidateChain = [...chain, event]
      const replay = replayGovernanceV1({ project_scope_id: input.scope.project_scope_id, memories: records, events: candidateChain })
      const compiled = compileGovernedGenerationV1({ project_scope_id: input.scope.project_scope_id, raw_catalog: await store.getCatalog(current.manifest.catalog_id), raw_memories: rawMemories, effective_memories: replay.effective_memories, governance_events: candidateChain, governance_head: { sequence: event.sequence, event_id: event.event_id, event_sha256: event.event_sha256 }, created_at: input.created_at })
      await ledger.writeEventExclusive(event)
      await publishImmutableVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id, compiled, expected: await readV2CurrentSnapshotV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id }), before_current_switch: options.before_current_switch })
      return { event, generation_id: compiled.generation_id, governance_head: { sequence: event.sequence, event_id: event.event_id, event_sha256: event.event_sha256 } }
  }
  const runWithTransaction = <T>(scope: ResolvedScope, operation: () => Promise<T>): Promise<T> => {
    const execute = () => withV2CurrentTransaction({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }, operation)
    return options.coordinator ? options.coordinator.run(scope.project_scope_id, execute) : execute()
  }
  return {
    commit: (input: GovernanceProductionCommitInputV1): Promise<GovernanceProductionCommitResultV1> => runWithTransaction(input.scope, () => commitWithinCurrentTransaction(input)),
    applyProposal: async (input): Promise<GovernanceProposalApplyResultV1> => {
      let proposal: GovernanceProposalV1
      try { proposal = validateGovernanceProposalV1(input.proposal) } catch { return { status: 'rejected', reason_code: 'proposal_invalid' } }
      if (proposal.project_scope_id !== input.scope.project_scope_id) return { status: 'rejected', reason_code: 'project_scope_mismatch' }
      return await runWithTransaction(input.scope, async () => {
          const current = await readCurrentVersionedGenerationV1({ project_root: input.scope.project_root, project_scope_id: input.scope.project_scope_id })
          const currentHead = current.kind === 'governed' ? current.governance_head : null
          if (current.generation_id !== proposal.base_generation_id || !sameGovernanceHeadV1(currentHead, proposal.base_governance_head)) {
            return { status: 'stale_proposal', current_generation_id: current.generation_id, current_governance_head: currentHead }
          }
          const created_at = options.now ? options.now() : new Date().toISOString()
          try {
            const result = await commitWithinCurrentTransaction({ scope: input.scope, payload: proposal.payload, evidence_refs: proposal.evidence_refs, reason_code: proposal.reason_code, created_at }, current)
            return { status: 'committed', ...result }
          } catch (error) {
            if (error instanceof ProtocolValidationError) return { status: 'rejected', reason_code: 'governance_event_rejected' as const }
            throw error
          }
        })
    },
  }
}

export const commitGovernanceEventProductionV1: typeof createGovernanceProductionRuntimeV1 = createGovernanceProductionRuntimeV1
