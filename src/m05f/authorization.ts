import {
  assertExactKeys,
  assertHash,
  assertInteger,
  assertObject,
  assertSafeText,
  canonicalHash,
  ProtocolValidationError,
  withoutHash,
} from '../protocol/canonical.js'
import {
  assertRfc3339Utc,
  createProviderCompatibilityAudit,
  parseRfc3339Utc,
  validateProviderCompatibilityAudit,
  type ProviderCompatibilityAudit,
} from './provider-audit.js'
import { runIsolatedProfileDryRun, type IsolatedDryRunResult } from './dry-run.js'

export interface RealCanaryRuntime {
  dsh_version: '0.1.0-rc.8'
  provider_package: '@deepseek-ai/dsh-llm-deepseek'
  provider_package_version: '0.1.0-rc.8'
  provider_route: 'deepseek-official'
  model: string
  credential_ref?: string
}

export interface RealCanaryLimits {
  task_calls: 24
  acquisition_calls: 6
  total_calls: 30
  max_output_tokens_per_call: 4096
  call_timeout_ms: 30000
  batch_timeout_ms: 600000
  automatic_retries: 0
  provider_error_circuit_breaker?: 2
}

export interface RealCanaryRuns {
  count: 6
  requested_seed: 101
}

export interface RealCanaryPlan {
  schema_version: 1
  status: 'dry_run_validated' | 'blocked'
  compatibility_audit_sha256: string
  fixture_manifest_sha256: string
  m05e_canary_plan_sha256: string
  runtime: {
    dsh_version: '0.1.0-rc.8'
    provider_package: '@deepseek-ai/dsh-llm-deepseek'
    provider_package_version: '0.1.0-rc.8'
    provider_route: 'deepseek-official'
    model: string
    credential_ref: string
  }
  limits: {
    task_calls: 24
    acquisition_calls: 6
    total_calls: 30
    max_output_tokens_per_call: 4096
    call_timeout_ms: 30000
    batch_timeout_ms: 600000
    automatic_retries: 0
    provider_error_circuit_breaker: 2
  }
  runs: RealCanaryRuns
  plan_sha256: string
}

export interface RealCanaryCost {
  status: 'verified' | 'unavailable'
  currency: 'USD' | null
  source_ref: string | null
  source_checked_at: string | null
  worst_case_upper_bound: string | null
}

export interface RealCanaryIsolation {
  temporary_dsh_home: true
  temporary_workspace: true
  user_state_access: false
}

export interface RealCanaryAuthorizationRequest {
  schema_version: 1
  authorization_id: string
  status: 'pending_user_approval'
  created_at: string
  expires_at: string
  compatibility_audit_sha256: string
  canary_plan_sha256: string
  fixture_manifest_sha256: string
  runtime: {
    dsh_version: '0.1.0-rc.8'
    provider_package: '@deepseek-ai/dsh-llm-deepseek'
    provider_package_version: '0.1.0-rc.8'
    provider_route: 'deepseek-official'
    model: string
  }
  limits: {
    task_calls: 24
    acquisition_calls: 6
    total_calls: 30
    max_output_tokens_per_call: 4096
    call_timeout_ms: 30000
    batch_timeout_ms: 600000
    automatic_retries: 0
  }
  cost: RealCanaryCost
  isolation: RealCanaryIsolation
  authorization_sha256: string
}

export interface PlanningGateOptions {
  audited_at: string
  created_at: string
  expires_at: string
  now: string
  package_json_content: string
  lockfile_content: string
  fixture_manifest_sha256: string
  m05e_canary_plan_sha256: string
  isolation_root: string
  model?: string
  credential_ref?: string
  cost?: RealCanaryCost
}

export interface PlanningGateResult {
  audit: ProviderCompatibilityAudit
  dry_run: IsolatedDryRunResult
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
}

const TARGET_VERSION = '0.1.0-rc.8' as const
const EXPECTED_PACKAGE = '@deepseek-ai/dsh-llm-deepseek' as const
const EXPECTED_ROUTE = 'deepseek-official' as const
const EXPECTED_MODEL = 'deepseek-v4-flash' as const

function assertDecimalString(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    !/^\d+(\.\d{1,6})?$/.test(value) ||
    Number.isNaN(Number.parseFloat(value)) ||
    Number.parseFloat(value) < 0
  ) {
    throw new ProtocolValidationError()
  }
}

export function computeAuthorizationId(preimage: Record<string, unknown>): string {
  const hash = canonicalHash(preimage)
  return `auth_${hash.slice(7, 39)}`
}

export function validateRealCanaryPlan(value: unknown): RealCanaryPlan {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'status',
    'compatibility_audit_sha256',
    'fixture_manifest_sha256',
    'm05e_canary_plan_sha256',
    'runtime',
    'limits',
    'runs',
    'plan_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  if (value.status !== 'dry_run_validated' && value.status !== 'blocked') throw new ProtocolValidationError()
  assertHash(value.compatibility_audit_sha256)
  assertHash(value.fixture_manifest_sha256)
  assertHash(value.m05e_canary_plan_sha256)
  assertHash(value.plan_sha256)

  assertObject(value.runtime)
  assertExactKeys(value.runtime, [
    'dsh_version',
    'provider_package',
    'provider_package_version',
    'provider_route',
    'model',
    'credential_ref',
  ])
  if (value.runtime.dsh_version !== TARGET_VERSION) throw new ProtocolValidationError()
  if (value.runtime.provider_package !== EXPECTED_PACKAGE) throw new ProtocolValidationError()
  if (value.runtime.provider_package_version !== TARGET_VERSION) throw new ProtocolValidationError()
  if (value.runtime.provider_route !== EXPECTED_ROUTE) throw new ProtocolValidationError()
  assertSafeText(value.runtime.model, 64)
  assertSafeText(value.runtime.credential_ref, 64)

  assertObject(value.limits)
  assertExactKeys(value.limits, [
    'task_calls',
    'acquisition_calls',
    'total_calls',
    'max_output_tokens_per_call',
    'call_timeout_ms',
    'batch_timeout_ms',
    'automatic_retries',
    'provider_error_circuit_breaker',
  ])
  if (
    value.limits.task_calls !== 24 ||
    value.limits.acquisition_calls !== 6 ||
    value.limits.total_calls !== 30 ||
    value.limits.max_output_tokens_per_call !== 4096 ||
    value.limits.call_timeout_ms !== 30000 ||
    value.limits.batch_timeout_ms !== 600000 ||
    value.limits.automatic_retries !== 0 ||
    value.limits.provider_error_circuit_breaker !== 2
  ) {
    throw new ProtocolValidationError()
  }

  assertObject(value.runs)
  assertExactKeys(value.runs, ['count', 'requested_seed'])
  if (value.runs.count !== 6 || value.runs.requested_seed !== 101) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'plan_sha256'))
  if (value.plan_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as RealCanaryPlan
}

function createRealCanaryPlanInternal(options: {
  audit: ProviderCompatibilityAudit
  dry_run: IsolatedDryRunResult
  fixture_manifest_sha256: string
  m05e_canary_plan_sha256: string
  model: string
  credential_ref: string
}): RealCanaryPlan {
  const validatedAudit = validateProviderCompatibilityAudit(options.audit)
  if (validatedAudit.decision !== 'compatible') {
    throw new ProtocolValidationError()
  }

  if (
    options.dry_run.status !== 'dry_run_success' ||
    options.dry_run.real_stream_calls !== 1 ||
    options.dry_run.credential_resolve_calls !== 0 ||
    options.dry_run.network_calls !== 0 ||
    options.dry_run.cleanup_clean !== true ||
    options.dry_run.provider_route !== EXPECTED_ROUTE ||
    options.dry_run.model_resolved !== options.model ||
    options.dry_run.max_tokens_configured !== 4096 ||
    options.dry_run.max_retries_configured !== 0
  ) {
    throw new ProtocolValidationError()
  }

  assertHash(options.fixture_manifest_sha256)
  assertHash(options.m05e_canary_plan_sha256)
  assertSafeText(options.model, 64)
  assertSafeText(options.credential_ref, 64)

  const body = {
    schema_version: 1 as const,
    status: 'dry_run_validated' as const,
    compatibility_audit_sha256: validatedAudit.audit_sha256,
    fixture_manifest_sha256: options.fixture_manifest_sha256,
    m05e_canary_plan_sha256: options.m05e_canary_plan_sha256,
    runtime: {
      dsh_version: TARGET_VERSION,
      provider_package: EXPECTED_PACKAGE,
      provider_package_version: TARGET_VERSION,
      provider_route: EXPECTED_ROUTE,
      model: options.model,
      credential_ref: options.credential_ref,
    },
    limits: {
      task_calls: 24 as const,
      acquisition_calls: 6 as const,
      total_calls: 30 as const,
      max_output_tokens_per_call: 4096 as const,
      call_timeout_ms: 30000 as const,
      batch_timeout_ms: 600000 as const,
      automatic_retries: 0 as const,
      provider_error_circuit_breaker: 2 as const,
    },
    runs: {
      count: 6 as const,
      requested_seed: 101 as const,
    },
  }

  const plan: RealCanaryPlan = {
    ...body,
    plan_sha256: canonicalHash(body),
  }

  return validateRealCanaryPlan(plan)
}

export function validateRealCanaryAuthorizationRequest(
  value: unknown
): RealCanaryAuthorizationRequest {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'authorization_id',
    'status',
    'created_at',
    'expires_at',
    'compatibility_audit_sha256',
    'canary_plan_sha256',
    'fixture_manifest_sha256',
    'runtime',
    'limits',
    'cost',
    'isolation',
    'authorization_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  if (value.status !== 'pending_user_approval') throw new ProtocolValidationError()

  const createdEpoch = parseRfc3339Utc(value.created_at)
  const expiresEpoch = parseRfc3339Utc(value.expires_at)
  if (createdEpoch >= expiresEpoch) {
    throw new ProtocolValidationError()
  }

  assertHash(value.compatibility_audit_sha256)
  assertHash(value.canary_plan_sha256)
  assertHash(value.fixture_manifest_sha256)
  assertHash(value.authorization_sha256)

  assertObject(value.runtime)
  assertExactKeys(value.runtime, [
    'dsh_version',
    'provider_package',
    'provider_package_version',
    'provider_route',
    'model',
  ])
  if (value.runtime.dsh_version !== TARGET_VERSION) throw new ProtocolValidationError()
  if (value.runtime.provider_package !== EXPECTED_PACKAGE) throw new ProtocolValidationError()
  if (value.runtime.provider_package_version !== TARGET_VERSION) throw new ProtocolValidationError()
  if (value.runtime.provider_route !== EXPECTED_ROUTE) throw new ProtocolValidationError()
  assertSafeText(value.runtime.model, 64)

  assertObject(value.limits)
  assertExactKeys(value.limits, [
    'task_calls',
    'acquisition_calls',
    'total_calls',
    'max_output_tokens_per_call',
    'call_timeout_ms',
    'batch_timeout_ms',
    'automatic_retries',
  ])
  if (
    value.limits.task_calls !== 24 ||
    value.limits.acquisition_calls !== 6 ||
    value.limits.total_calls !== 30 ||
    value.limits.max_output_tokens_per_call !== 4096 ||
    value.limits.call_timeout_ms !== 30000 ||
    value.limits.batch_timeout_ms !== 600000 ||
    value.limits.automatic_retries !== 0
  ) {
    throw new ProtocolValidationError()
  }

  assertObject(value.cost)
  assertExactKeys(value.cost, [
    'status',
    'currency',
    'source_ref',
    'source_checked_at',
    'worst_case_upper_bound',
  ])
  if (value.cost.status === 'unavailable') {
    if (
      value.cost.currency !== null ||
      value.cost.source_ref !== null ||
      value.cost.source_checked_at !== null ||
      value.cost.worst_case_upper_bound !== null
    ) {
      throw new ProtocolValidationError()
    }
  } else if (value.cost.status === 'verified') {
    if (value.cost.currency !== 'USD') throw new ProtocolValidationError()
    assertSafeText(value.cost.source_ref, 128)
    const sourceCheckedEpoch = parseRfc3339Utc(value.cost.source_checked_at)
    if (sourceCheckedEpoch > createdEpoch) {
      throw new ProtocolValidationError()
    }
    assertDecimalString(value.cost.worst_case_upper_bound)
  } else {
    throw new ProtocolValidationError()
  }

  assertObject(value.isolation)
  assertExactKeys(value.isolation, [
    'temporary_dsh_home',
    'temporary_workspace',
    'user_state_access',
  ])
  if (
    value.isolation.temporary_dsh_home !== true ||
    value.isolation.temporary_workspace !== true ||
    value.isolation.user_state_access !== false
  ) {
    throw new ProtocolValidationError()
  }

  // Preimage integrity check for authorization_id
  const preimage = {
    schema_version: 1,
    status: value.status,
    created_at: value.created_at,
    expires_at: value.expires_at,
    compatibility_audit_sha256: value.compatibility_audit_sha256,
    canary_plan_sha256: value.canary_plan_sha256,
    fixture_manifest_sha256: value.fixture_manifest_sha256,
    runtime: value.runtime,
    limits: value.limits,
    cost: value.cost,
    isolation: value.isolation,
  }
  const expectedId = computeAuthorizationId(preimage)
  if (value.authorization_id !== expectedId) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'authorization_sha256'))
  if (value.authorization_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as RealCanaryAuthorizationRequest
}

function createRealCanaryAuthorizationRequestInternal(options: {
  plan: RealCanaryPlan
  audit: ProviderCompatibilityAudit
  fixture_manifest_sha256: string
  model: string
  created_at: string
  expires_at: string
  now: string
  cost?: RealCanaryCost
}): RealCanaryAuthorizationRequest {
  const validatedPlan = validateRealCanaryPlan(options.plan)
  if (validatedPlan.status !== 'dry_run_validated') {
    throw new ProtocolValidationError()
  }
  const validatedAudit = validateProviderCompatibilityAudit(options.audit)
  if (validatedAudit.decision !== 'compatible') {
    throw new ProtocolValidationError()
  }

  if (validatedPlan.compatibility_audit_sha256 !== validatedAudit.audit_sha256) {
    throw new ProtocolValidationError()
  }
  if (validatedPlan.fixture_manifest_sha256 !== options.fixture_manifest_sha256) {
    throw new ProtocolValidationError()
  }
  if (validatedPlan.runtime.model !== options.model) {
    throw new ProtocolValidationError()
  }

  const createdEpoch = parseRfc3339Utc(options.created_at)
  const expiresEpoch = parseRfc3339Utc(options.expires_at)
  const nowEpoch = parseRfc3339Utc(options.now)

  // Enforce created_at <= now < expires_at
  if (createdEpoch > nowEpoch || nowEpoch >= expiresEpoch || createdEpoch >= expiresEpoch) {
    throw new ProtocolValidationError()
  }

  if (options.cost?.status === 'verified' && options.cost.source_checked_at) {
    const checkedEpoch = parseRfc3339Utc(options.cost.source_checked_at)
    if (checkedEpoch > nowEpoch || checkedEpoch > createdEpoch) {
      throw new ProtocolValidationError()
    }
  }

  const cost: RealCanaryCost = options.cost ?? {
    status: 'unavailable',
    currency: null,
    source_ref: null,
    source_checked_at: null,
    worst_case_upper_bound: null,
  }

  const preimage = {
    schema_version: 1 as const,
    status: 'pending_user_approval' as const,
    created_at: options.created_at,
    expires_at: options.expires_at,
    compatibility_audit_sha256: validatedAudit.audit_sha256,
    canary_plan_sha256: validatedPlan.plan_sha256,
    fixture_manifest_sha256: options.fixture_manifest_sha256,
    runtime: {
      dsh_version: TARGET_VERSION,
      provider_package: EXPECTED_PACKAGE,
      provider_package_version: TARGET_VERSION,
      provider_route: EXPECTED_ROUTE,
      model: options.model,
    },
    limits: {
      task_calls: 24 as const,
      acquisition_calls: 6 as const,
      total_calls: 30 as const,
      max_output_tokens_per_call: 4096 as const,
      call_timeout_ms: 30000 as const,
      batch_timeout_ms: 600000 as const,
      automatic_retries: 0 as const,
    },
    cost,
    isolation: {
      temporary_dsh_home: true as const,
      temporary_workspace: true as const,
      user_state_access: false as const,
    },
  }

  const authorization_id = computeAuthorizationId(preimage)

  const body = {
    ...preimage,
    authorization_id,
  }

  const request: RealCanaryAuthorizationRequest = {
    ...body,
    authorization_sha256: canonicalHash(body),
  }

  return validateRealCanaryAuthorizationRequest(request)
}

export async function runM05F1PlanningGate(
  options: PlanningGateOptions
): Promise<PlanningGateResult> {
  const model = options.model ?? EXPECTED_MODEL
  const credentialRef = options.credential_ref ?? 'DEEPSEEK_API_KEY'

  // 1. Provider Compatibility Audit
  const audit = createProviderCompatibilityAudit({
    audited_at: options.audited_at,
    package_json_content: options.package_json_content,
    lockfile_content: options.lockfile_content,
  })
  if (audit.decision !== 'compatible') {
    throw new ProtocolValidationError()
  }

  // 2. Real Isolated Dry-run
  const dryRun = await runIsolatedProfileDryRun({
    isolation_root: options.isolation_root,
    model,
    max_tokens: 4096,
    max_retries: 0,
  })
  if (dryRun.status !== 'dry_run_success') {
    throw new ProtocolValidationError()
  }

  // 3. Real Canary Plan created from internal evidence
  const plan = createRealCanaryPlanInternal({
    audit,
    dry_run: dryRun,
    fixture_manifest_sha256: options.fixture_manifest_sha256,
    m05e_canary_plan_sha256: options.m05e_canary_plan_sha256,
    model,
    credential_ref: credentialRef,
  })

  // 4. Real Canary Authorization Request
  const authorization = createRealCanaryAuthorizationRequestInternal({
    plan,
    audit,
    fixture_manifest_sha256: options.fixture_manifest_sha256,
    model,
    created_at: options.created_at,
    expires_at: options.expires_at,
    now: options.now,
    cost: options.cost,
  })

  return {
    audit,
    dry_run: dryRun,
    plan,
    authorization,
  }
}

export function checkAuthorizationExpiry(
  request: RealCanaryAuthorizationRequest,
  nowIso: string
): boolean {
  validateRealCanaryAuthorizationRequest(request)
  const nowEpoch = parseRfc3339Utc(nowIso)
  const expiresEpoch = parseRfc3339Utc(request.expires_at)
  return nowEpoch >= expiresEpoch
}
