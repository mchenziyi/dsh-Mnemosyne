import type { MemoryShortTermFact, MemoryLongTermFact, MemoryForgetFact } from '../protocol/memory-fact.js'
import type { VerifiedGenerationWorld } from '../generation-store.js'

export interface FactStoreState {
  readonly project_scope_id: string
  readonly shortTerm: readonly MemoryShortTermFact[]
  readonly longTerm: readonly MemoryLongTermFact[]
  readonly forget: readonly MemoryForgetFact[]
}

export interface CurrentGenerationState {
  readonly current: {
    readonly generation_id: string
    readonly manifest_sha256: string
    readonly updated_at: string
  }
  readonly world: VerifiedGenerationWorld
}

export declare function inspectFactStoreState(projectRoot: string): Promise<FactStoreState>
export declare function inspectCurrentGeneration(projectRoot: string): Promise<CurrentGenerationState | null>
