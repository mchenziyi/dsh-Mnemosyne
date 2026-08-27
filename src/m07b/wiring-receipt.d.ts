export interface SidecarLoadedReceipt {
  readonly schema_version: 1
  readonly receipt_type: 'sidecar_loaded'
  readonly run_id: 'run_1' | 'run_2' | 'run_3' | 'run_4' | 'run_5' | 'run_6'
  readonly module_role: 'audit_sidecar'
  readonly module_sha256: string
  readonly loaded_at: string
  readonly receipt_sha256: string
}

export interface ResumeCompletedReceipt {
  readonly schema_version: 1
  readonly receipt_type: 'resume_completed'
  readonly run_id: 'run_2' | 'run_3'
  readonly module_role: 'resume_driver'
  readonly module_sha256: string
  readonly resumed_session_id_sha256: string
  readonly run_1_session_id_sha256: string
  readonly same_session: true
  readonly completed_at: string
  readonly receipt_sha256: string
}

export declare function isValidStrictIsoUtc(value: unknown): boolean

export declare function createSidecarLoadedReceipt(params: {
  run_id: 'run_1' | 'run_2' | 'run_3' | 'run_4' | 'run_5' | 'run_6'
  module_sha256: string
  loaded_at?: string
}): SidecarLoadedReceipt

export declare function validateSidecarLoadedReceipt(receipt: unknown): SidecarLoadedReceipt

export declare function createResumeCompletedReceipt(params: {
  run_id: 'run_2' | 'run_3'
  module_sha256: string
  resumed_session_id_sha256: string
  run_1_session_id_sha256: string
  same_session?: true
  completed_at?: string
}): ResumeCompletedReceipt

export declare function validateResumeCompletedReceipt(receipt: unknown): ResumeCompletedReceipt

export declare function writeSidecarLoadedReceipt(evidenceDir: string, receipt: SidecarLoadedReceipt): Promise<void>
export declare function writeSidecarLoadedReceiptSync(evidenceDir: string, receipt: SidecarLoadedReceipt): void
export declare function writeResumeCompletedReceipt(evidenceDir: string, receipt: ResumeCompletedReceipt): Promise<void>
export declare function writeResumeCompletedReceiptSync(evidenceDir: string, receipt: ResumeCompletedReceipt): void

export declare function readSidecarLoadedReceipt(evidenceDir: string, runId: string): Promise<SidecarLoadedReceipt>
export declare function readResumeCompletedReceipt(evidenceDir: string, runId: string): Promise<ResumeCompletedReceipt>
