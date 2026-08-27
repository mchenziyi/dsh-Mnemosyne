export interface LlmClaimPayload {
  readonly schema_version: 1
  readonly seq: number
  readonly run_id: 'run_1' | 'run_2' | 'run_3' | 'run_4' | 'run_5' | 'run_6'
  readonly claimed_at: string
}

export interface LlmClaimResult {
  readonly seq: number
  readonly run_id: string
  readonly claimPath: string
}

export interface BudgetSummary {
  readonly total_claimed: number
  readonly completed_count: number
  readonly provider_error_count: number
  readonly protocol_error_count: number
  readonly aborted_count: number
  readonly circuit_broken: boolean
  readonly circuit_broken_reason: string | null
}

export declare const MAX_MODEL_REQUESTS: 18
export declare const MAX_HEADLESS_RUNS: 6
export declare const CONSECUTIVE_ERROR_THRESHOLD: 2
export declare const VALID_CANARY_RUN_IDS: ReadonlySet<string>

export declare function isValidStrictIsoUtc(value: unknown): boolean
export declare function validateLlmClaim(claim: unknown, expectedSeq?: number, expectedRunId?: string): LlmClaimPayload
export declare function readValidLlmClaims(evidenceDir: string): Promise<LlmClaimPayload[]>
export declare function claimLlmRequest(evidenceDir: string, runId: string): Promise<LlmClaimResult>
export declare function recordLlmOutcome(
  evidenceDir: string,
  seq: number,
  status: 'completed' | 'provider_error' | 'protocol_error' | 'aborted'
): Promise<void>
export declare function summarizeLlmBudget(evidenceDir: string): Promise<BudgetSummary>
