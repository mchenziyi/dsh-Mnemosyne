import type { RunStateSnapshot, ForgetRef } from './state-evidence.js'
import type { OKFMemoryRef } from '../protocol/okf-retrieval.js'

export interface PredicateResult {
  readonly pass: boolean
  readonly reason?: string
  readonly target_short_term_ref?: OKFMemoryRef
  readonly open_body_sha256?: string
  readonly promoted_long_term_ref?: OKFMemoryRef
  readonly forget_ref?: ForgetRef
}

export declare function predicateRun1_AutomaticCapture(params: {
  snapshotBefore?: RunStateSnapshot | null
  snapshotAfter?: RunStateSnapshot | null
  sessionEvidence?: unknown
  expectedSessionId?: string
  expectedSessionIdHash?: string
  expectedMemoryId?: string
  projectRoot?: string
}): Promise<PredicateResult>

export declare function predicateRun2_RestartPersistence(params: {
  snapshotAfter?: RunStateSnapshot | null
  sessionEvidence?: unknown
  sourceShortMemoryId?: string
  targetMemoryId?: string
  resumeReceipt?: { run_id: string; same_session: boolean; resumed_session_id_sha256: string; run_1_session_id_sha256: string } | null
  projectRoot?: string
}): Promise<PredicateResult>

export declare function predicateRun3_Promotion(params: {
  snapshotBefore?: RunStateSnapshot | null
  snapshotAfter?: RunStateSnapshot | null
  sessionEvidence?: unknown
  sourceShortMemoryId?: string
  sourceMemoryId?: string
  promotedLongMemoryId?: string
  targetMemoryId?: string
  resumeReceipt?: { run_id: string; same_session: boolean; resumed_session_id_sha256: string; run_1_session_id_sha256: string } | null
  projectRoot?: string
}): Promise<PredicateResult>

export declare function predicateRun4_CrossSessionReading(params: {
  snapshotAfter?: RunStateSnapshot | null
  sessionEvidence?: unknown
  targetMemoryId?: string
  sessionA1Hash?: string
  oldRetrievalId?: string
  projectRoot?: string
}): Promise<PredicateResult>

export declare function predicateRun5_ForgetAndGrantInvalidation(params: {
  snapshotAfter?: RunStateSnapshot | null
  sessionEvidence?: unknown
  targetMemoryId?: string
  projectRoot?: string
}): Promise<PredicateResult>

export declare function predicateRun6_ScopeIsolation(params: {
  snapshotProjectA_Before?: RunStateSnapshot | null
  snapshotProjectA_After?: RunStateSnapshot | null
  snapshotProjectB?: RunStateSnapshot | null
  sessionEvidenceB?: unknown
  projectScopeA?: string
  projectScopeB?: string
  projectRootA?: string
  projectRootB?: string
  projectARoot?: string
  projectBRoot?: string
  canaryContentText?: string
}): Promise<PredicateResult>
