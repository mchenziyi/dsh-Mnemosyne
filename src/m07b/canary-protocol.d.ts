export interface CanaryBudgets {
  readonly max_headless_runs: 6
  readonly max_model_requests: 12
  readonly retry_count: 0
  readonly per_run_timeout_ms: 120000
  readonly total_timeout_ms: 720000
  readonly consecutive_provider_or_protocol_errors: 2
}

export interface CanaryChecks {
  readonly execution_wiring: 'pass' | 'fail' | 'not_run'
  readonly automatic_capture: 'pass' | 'fail' | 'not_run'
  readonly restart_persistence: 'pass' | 'fail' | 'not_run'
  readonly progressive_disclosure: 'pass' | 'fail' | 'not_run'
  readonly promotion: 'pass' | 'fail' | 'not_run'
  readonly forget_and_grant: 'pass' | 'fail' | 'not_run'
  readonly scope_isolation: 'pass' | 'fail' | 'not_run'
}

export interface ExecutionManifestRun {
  readonly id: 'run_1' | 'run_2' | 'run_3' | 'run_4' | 'run_5' | 'run_6'
  readonly is_resume: boolean
  readonly cwd_rel: string
  readonly task: string
  readonly patch_hashes: readonly string[]
}

export interface ExecutionManifestRuntimeModule {
  readonly role: 'audit_sidecar' | 'resume_driver' | 'budget_ledger' | 'session_evidence'
  readonly realpath: string
  readonly content_sha256: string
}

export interface ExecutionManifestExtraPatch {
  readonly name: string
  readonly patch_sha256: string
  readonly module_realpath: string
  readonly module_sha256: string
}

export interface ExecutionManifest {
  readonly schema_version: 1
  readonly dsh_executable_realpath: string
  readonly dsh_version: '0.1.1-rc.2'
  readonly profile: 'headless'
  readonly tarball_realpath: string
  readonly tarball_sha256: string
  readonly profile_dependency_value: string
  readonly sidecar_patch_sha256: string
  readonly resume_patch_sha256: string
  readonly run_root_identity: string
  readonly runtime_module_files: readonly ExecutionManifestRuntimeModule[]
  readonly runs: readonly ExecutionManifestRun[]
  readonly extra_patches: readonly ExecutionManifestExtraPatch[]
}

export declare const REQUIRED_RUNTIME_MODULE_ROLES: readonly [
  'audit_sidecar',
  'resume_driver',
  'budget_ledger',
  'session_evidence',
]

export declare const FROZEN_CANARY_TASKS: Readonly<Record<string, string>>

export interface RealCanaryPlan {
  readonly schema_version: 1
  readonly plan_id: string
  readonly plan_sha256: string
  readonly dsh_version: '0.1.1-rc.2'
  readonly package_version: '0.0.0-dev'
  readonly package_sha256: string
  readonly profile: 'headless'
  readonly run_root_identity: string
  readonly execution_manifest_sha256: string
  readonly credential_ref: 'temporary_dsh_home_credentials'
  readonly budgets: CanaryBudgets
  readonly runs: readonly string[]
  readonly created_at: string
  readonly expires_at: string
  readonly nonce: string
}

export interface ApprovalReceipt {
  readonly schema_version: 1
  readonly approval_id: string
  readonly plan_id: string
  readonly plan_sha256: string
  readonly approved: true
  readonly approved_at: string
  readonly expires_at: string
  readonly approval_sha256: string
}

export type CanaryReasonCode =
  | 'product_invariant_failed'
  | 'dsh_compatibility_failed'
  | 'model_noncompliance'
  | 'provider_failed'
  | 'credential_unavailable'
  | 'authorization_invalid'
  | 'budget_exhausted'
  | 'subprocess_timeout'
  | 'environment_failed'
  | 'security_boundary_failed'
  | 'cleanup_failed'

export interface RedactedCanaryReport {
  readonly schema_version: 1
  readonly status: 'pass' | 'fail' | 'aborted'
  readonly dsh_version: '0.1.1-rc.2'
  readonly package_version: '0.0.0-dev'
  readonly package_sha256: string
  readonly plan_sha256: string
  readonly approval_sha256: string
  readonly run_count: number
  readonly model_request_count: number
  readonly checks: CanaryChecks
  readonly reason_code: CanaryReasonCode | null
  readonly cleanup_clean: boolean
  readonly report_sha256: string
}

export declare const REQUIRED_CANARY_RUNS: readonly string[]
export declare const FORBIDDEN_REPORT_KEYS: ReadonlySet<string>
export declare const VALID_REASON_CODES: ReadonlySet<string>

export declare function canonicalJson(value: unknown): string
export declare function computeSha256(content: string): string
export declare function computeExecutionManifestSha256(manifestWithoutHash: unknown): string
export declare function computePlanSha256(planWithoutHash: Omit<RealCanaryPlan, 'plan_sha256'>): string
export declare function computeApprovalSha256(approvalWithoutHash: Omit<ApprovalReceipt, 'approval_sha256'>): string
export declare function computeReportSha256(reportWithoutHash: Omit<RedactedCanaryReport, 'report_sha256'>): string

export declare function createExecutionManifest(params: any): ExecutionManifest
export declare function validateExecutionManifest(manifest: unknown): ExecutionManifest

export declare function createRealCanaryPlan(params: {
  package_sha256: string
  run_root_identity: string
  created_at: string
  expires_at: string
  nonce: string
  execution_manifest_sha256?: string
  plan_id?: string
}): RealCanaryPlan

export declare function validateRealCanaryPlan(plan: unknown): RealCanaryPlan

export declare function createApprovalReceipt(params: {
  plan_id: string
  plan_sha256: string
  approved_at: string
  expires_at: string
  approval_id?: string
}): ApprovalReceipt

export declare function validateApprovalReceipt(receipt: unknown): ApprovalReceipt

export declare function createRedactedCanaryReport(params: {
  status: 'pass' | 'fail' | 'aborted'
  package_sha256: string
  plan_sha256: string
  approval_sha256: string
  run_count: number
  model_request_count: number
  checks: CanaryChecks
  reason_code?: CanaryReasonCode | null
  cleanup_clean: boolean
}): RedactedCanaryReport

export declare function validateRedactedCanaryReport(report: unknown): RedactedCanaryReport

export interface RedactedCanaryReportV2 {
  readonly schema_version: 2
  readonly evaluation_level: 'business'
  readonly status: 'pass' | 'fail' | 'aborted'
  readonly dsh_version: '0.1.1-rc.2'
  readonly package_version: '0.0.0-dev'
  readonly package_sha256: string
  readonly plan_sha256: string
  readonly approval_sha256: string
  readonly run_count: number
  readonly model_request_count: number
  readonly checks: CanaryChecks
  readonly reason_code: CanaryReasonCode | null
  readonly cleanup_clean: boolean
  readonly report_sha256: string
}

export declare function computeProjectScopeId(projectRoot: string): string

export declare function createRedactedCanaryReportV2(params: {
  status: 'pass' | 'fail' | 'aborted'
  package_sha256: string
  plan_sha256: string
  approval_sha256: string
  run_count: number
  model_request_count: number
  checks: CanaryChecks
  reason_code?: CanaryReasonCode | null
  cleanup_clean: boolean
}): RedactedCanaryReportV2

export declare function validateRedactedCanaryReportV2(report: unknown): RedactedCanaryReportV2
