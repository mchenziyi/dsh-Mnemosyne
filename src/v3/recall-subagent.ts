import { MemoryStoreError } from '../memory-store-error.js'
import { canonicalHash, compareCodePoints } from '../protocol/canonical.js'
import type { PinnedGenerationV3 } from './map-offer.js'

export interface RecallSubagentRequestV3 {
  readonly task: string
  readonly generation_id: string
  readonly project_scope_id: string
  readonly offered_refs: readonly string[]
  readonly signal: AbortSignal
}

export interface RecallSubagentDecisionV3 {
  readonly summary_refs: readonly string[]
  readonly content_refs: readonly string[]
}

export interface DisclosureReceiptV3 {
  readonly schema_version: 1
  readonly generation_id: string
  readonly project_scope_id: string
  readonly offered_refs: readonly string[]
  readonly summary_refs: readonly string[]
  readonly content_refs: readonly string[]
  readonly receipt_sha256: string
}

export type RecallSubagentInvokerV3 = (request: RecallSubagentRequestV3) => Promise<RecallSubagentDecisionV3>

function fail(): never { throw new MemoryStoreError('memory_store_invalid_input') }

function sortedRefs(refs: readonly string[]): string[] {
  if (new Set(refs).size !== refs.length || refs.some((ref) => typeof ref !== 'string' || !/^(?:node|mem)_[a-z0-9][a-z0-9._-]{0,63}$/.test(ref))) fail()
  return [...refs].sort(compareCodePoints)
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}

export function createDisclosureReceiptV3(input: Omit<DisclosureReceiptV3, 'receipt_sha256'>): DisclosureReceiptV3 {
  if (!/^gen_[0-9a-f]{64}$/.test(input.generation_id) || !/^sha256_[0-9a-f]{64}$/.test(input.project_scope_id)) fail()
  const identity = {
    schema_version: 1 as const,
    generation_id: input.generation_id,
    project_scope_id: input.project_scope_id,
    offered_refs: sortedRefs(input.offered_refs),
    summary_refs: sortedRefs(input.summary_refs),
    content_refs: sortedRefs(input.content_refs),
  }
  const offered = new Set(identity.offered_refs)
  if (identity.summary_refs.length > 5 || identity.content_refs.length > 3) fail()
  if (identity.summary_refs.some((ref) => !offered.has(ref)) || identity.content_refs.some((ref) => !offered.has(ref))) fail()
  if (identity.content_refs.some((ref) => !identity.summary_refs.includes(ref))) fail()
  return freeze({ ...identity, receipt_sha256: canonicalHash(identity) })
}

export function runRecallSubagentV3(pin: PinnedGenerationV3, task: string, offeredRefs: readonly string[], invoke: RecallSubagentInvokerV3, signal: AbortSignal): Promise<DisclosureReceiptV3> {
  if (typeof task !== 'string' || task.length === 0 || task.length > 32768) return Promise.reject(new MemoryStoreError('memory_store_invalid_input'))
  const offered = sortedRefs(offeredRefs)
  return invoke({ task, generation_id: pin.generation_id, project_scope_id: pin.project_scope_id, offered_refs: offered, signal })
    .then((decision) => createDisclosureReceiptV3({
      schema_version: 1,
      generation_id: pin.generation_id,
      project_scope_id: pin.project_scope_id,
      offered_refs: offered,
      summary_refs: decision.summary_refs,
      content_refs: decision.content_refs,
    }))
}
