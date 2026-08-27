import type { SessionEventSummary } from './session-evidence.js'

export interface PredicateResult {
  readonly pass: boolean
  readonly reason?: string
}

export declare function predicateRun1_AutomaticCapture(params: {
  projectRoot: string
  expectedSessionId: string
  expectedMemoryId: string
  sessionEvidence?: SessionEventSummary | null
}): Promise<PredicateResult>

export declare function predicateRun2_RestartPersistence(params: {
  projectRoot: string
  sessionEvidence?: SessionEventSummary | null
}): Promise<PredicateResult>

export declare function predicateRun3_Promotion(params: {
  projectRoot: string
  sourceShortMemoryId: string
  promotedLongMemoryId: string
  sessionEvidence?: SessionEventSummary | null
}): Promise<PredicateResult>

export declare function predicateRun4_CrossSessionReading(params: {
  projectRoot: string
  sessionEvidence?: SessionEventSummary | null
}): Promise<PredicateResult>

export declare function predicateRun5_ForgetAndGrantInvalidation(params: {
  projectRoot: string
  targetMemoryId: string
  sessionEvidence?: SessionEventSummary | null
}): Promise<PredicateResult>

export declare function predicateRun6_ScopeIsolation(params: {
  projectRootA: string
  projectRootB: string
  canaryContentText?: string
}): Promise<PredicateResult>
