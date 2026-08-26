export interface CanaryBudget {
  max_runs: 6
  max_model_requests: 12
  max_run_timeout_seconds: 120
  max_total_timeout_seconds: 720
  max_consecutive_provider_errors: 2
}

export interface CanaryStep {
  run: number
  name: string
}

export interface CanaryKnowledge {
  topic: string
  canary_fact: string
}

export interface CanaryPlan {
  schema_version: 1
  plan_id: string
  dsh_version: '0.1.1-rc.2'
  tarball_sha256: string
  budget: CanaryBudget
  steps: CanaryStep[]
  knowledge: CanaryKnowledge
}

export type CanaryCheckStatus = 'pass' | 'fail' | 'not_run'

export interface CanaryReportChecks {
  automatic_capture: CanaryCheckStatus
  restart_persistence: CanaryCheckStatus
  progressive_disclosure: CanaryCheckStatus
  promotion: CanaryCheckStatus
  forget_and_grant: CanaryCheckStatus
  scope_isolation: CanaryCheckStatus
}

export const ALLOWED_FAILURE_REASONS: readonly [
  'provider_error',
  'model_noncompliance',
  'schema_validation_error',
  'timeout',
  'environment_error',
  'security_violation',
]

export type CanaryFailureReason = (typeof ALLOWED_FAILURE_REASONS)[number]

export interface CanaryReport {
  schema_version: 1
  status: 'pass' | 'fail' | 'aborted' | 'dry_run_ready'
  dsh_version: '0.1.1-rc.2'
  package_version: '0.0.0-dev' | '0.1.0'
  package_sha256: string
  run_count: number
  model_request_count: number
  checks: CanaryReportChecks
  reason_code: CanaryFailureReason | null
  cleanup_clean: boolean
  report_sha256: string
}

export const REQUIRED_CANARY_STEPS: CanaryStep[]

export function computePlanId(planWithoutId: Omit<CanaryPlan, 'plan_id'>): string
export function computePlanSha256(plan: CanaryPlan): string
export function createCanaryPlan(params: {
  tarball_sha256: string
  knowledge: CanaryKnowledge
}): CanaryPlan
export function validateCanaryPlan(val: unknown): CanaryPlan
export function computeReportSha256(report: Omit<CanaryReport, 'report_sha256'> | CanaryReport): string
export function validateCanaryReport(val: unknown): CanaryReport
