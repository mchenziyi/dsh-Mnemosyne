import type { OKFGenerationRef, OKFMemoryRef } from '../protocol/okf-retrieval.js'

export interface ForgetRef {
  forget_id: string
  target_memory_id: string
  target_tier: string
  generation_id: string | null
  content_sha256?: string
}

export interface RunStateSnapshot {
  run_id: string
  project_scope_id: string
  session_id_sha256: string
  short_term_refs: OKFMemoryRef[]
  long_term_refs: OKFMemoryRef[]
  forget_refs: ForgetRef[]
  current_ref: OKFGenerationRef | null
  index_memory_refs: OKFMemoryRef[]
  snapshot_sha256: string
}

export interface FactDiff {
  added_short_term: OKFMemoryRef[]
  removed_short_term: OKFMemoryRef[]
  added_long_term: OKFMemoryRef[]
  removed_long_term: OKFMemoryRef[]
  added_forget: ForgetRef[]
  current_changed: boolean
}

export interface CanaryIdentityLedger {
  schema_version: 1
  project_scope_a: string
  project_scope_b: string
  session_a1_sha256: string | null
  run_1_short_term_ref: OKFMemoryRef | null
  run_2_retrieval_id: string | null
  run_2_search_disclosure_sha256: string | null
  run_2_open_body_sha256: string | null
  run_3_promoted_long_term_ref: OKFMemoryRef | null
  session_a3_sha256: string | null
  run_5_forget_ref: ForgetRef | null
  run_6_project_b_isolated: boolean
  ledger_sha256: string
}

export declare function computeRunStateSnapshotSha256(snapshot: Omit<RunStateSnapshot, 'snapshot_sha256'>): string

export declare function createRunStateSnapshot(params: {
  run_id: string
  project_scope_id: string
  session_id_sha256: string
  short_term_refs?: OKFMemoryRef[]
  long_term_refs?: OKFMemoryRef[]
  forget_refs?: ForgetRef[]
  current_ref?: OKFGenerationRef | null
  index_memory_refs?: OKFMemoryRef[]
}): RunStateSnapshot

export declare function validateRunStateSnapshot(snapshot: unknown): RunStateSnapshot

export declare function captureRunStateSnapshot(params: {
  runId: string
  projectRoot: string
  sessionId?: string
  sessionIdSha256?: string
}): Promise<RunStateSnapshot>

export declare function computeFactDiff(
  beforeSnapshot: RunStateSnapshot,
  afterSnapshot: RunStateSnapshot
): FactDiff

export declare function computeLedgerSha256(ledger: Omit<CanaryIdentityLedger, 'ledger_sha256'>): string

export declare function createCanaryIdentityLedger(params: {
  project_scope_a: string
  project_scope_b: string
}): CanaryIdentityLedger

export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_1',
  update: { session_id_sha256: string; short_term_ref: OKFMemoryRef }
): CanaryIdentityLedger
export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_2',
  update: { search_retrieval_id: string; search_disclosure_sha256: string; open_body_sha256: string }
): CanaryIdentityLedger
export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_3',
  update: { promoted_long_term_ref: OKFMemoryRef }
): CanaryIdentityLedger
export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_4',
  update: { session_a3_sha256: string }
): CanaryIdentityLedger
export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_5',
  update: { forget_ref: ForgetRef }
): CanaryIdentityLedger
export declare function advanceCanaryIdentityLedger(
  ledger: CanaryIdentityLedger,
  runId: 'run_6',
  update: { project_b_isolated: true }
): CanaryIdentityLedger

export declare function validateCanaryIdentityLedger(ledger: unknown): CanaryIdentityLedger

export declare function inspectFactStoreState(projectRoot: string): Promise<{
  project_scope_id: string
  shortTerm: unknown[]
  longTerm: unknown[]
  forget: unknown[]
}>

export declare function inspectCurrentGeneration(projectRoot: string): Promise<unknown>
