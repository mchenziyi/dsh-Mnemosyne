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
  parseRfc3339Utc,
} from '../m05f/provider-audit.js'
import {
  validateRealCanaryAuthorizationRequest,
  type RealCanaryAuthorizationRequest,
} from '../m05f/authorization.js'

export interface AcceptedRuntime {
  provider_package: '@deepseek-ai/dsh-llm-deepseek'
  provider_package_version: '0.1.0-rc.8'
  provider_route: 'deepseek-official'
  model: string
}

export interface AcceptedLimits {
  runs: 6
  task_calls: 24
  acquisition_calls: 6
  total_calls: 30
  max_output_tokens_per_call: 4096
  call_timeout_ms: 30000
  batch_timeout_ms: 600000
  automatic_retries: 0
  provider_error_circuit_breaker: 2
}

export interface AcceptedCost {
  status: 'verified' | 'unavailable'
  worst_case_upper_bound: string | null
}

export interface RealCanaryApprovalReceipt {
  schema_version: 1
  approval_id: string
  authorization_id: string
  authorization_sha256: string
  decision: 'approved' | 'rejected'
  decided_at: string
  subject_id: string
  accepted_runtime: AcceptedRuntime
  accepted_limits: AcceptedLimits
  accepted_cost: AcceptedCost
  execution_root_sha256: string
  approval_sha256: string
}

export interface RealCanaryExecutionClaim {
  schema_version: 1
  execution_id: string
  authorization_sha256: string
  approval_sha256: string
  execution_root_sha256: string
  claimed_at: string
  claim_sha256: string
}

const TARGET_VERSION = '0.1.0-rc.8' as const
const EXPECTED_PACKAGE = '@deepseek-ai/dsh-llm-deepseek' as const
const EXPECTED_ROUTE = 'deepseek-official' as const

function assertDecimalStringOrNull(value: unknown): void {
  if (value === null) return
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

export function computeApprovalId(preimage: {
  authorization_id: string
  authorization_sha256: string
  decision: 'approved' | 'rejected'
  decided_at: string
  subject_id: string
  accepted_runtime: AcceptedRuntime
  accepted_limits: AcceptedLimits
  accepted_cost: AcceptedCost
  execution_root_sha256: string
}): string {
  const hash = canonicalHash({
    schema_version: 1 as const,
    authorization_id: preimage.authorization_id,
    authorization_sha256: preimage.authorization_sha256,
    decision: preimage.decision,
    decided_at: preimage.decided_at,
    subject_id: preimage.subject_id,
    accepted_runtime: preimage.accepted_runtime,
    accepted_limits: preimage.accepted_limits,
    accepted_cost: preimage.accepted_cost,
    execution_root_sha256: preimage.execution_root_sha256,
  })
  return `approval_${hash.slice(7, 39)}`
}

export function computeExecutionId(preimage: {
  authorization_sha256: string
  approval_sha256: string
  execution_root_sha256: string
}): string {
  const hash = canonicalHash({
    schema_version: 1 as const,
    authorization_sha256: preimage.authorization_sha256,
    approval_sha256: preimage.approval_sha256,
    execution_root_sha256: preimage.execution_root_sha256,
  })
  return `execution_${hash.slice(7, 39)}`
}

export function validateRealCanaryApprovalReceipt(value: unknown): RealCanaryApprovalReceipt {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'approval_id',
    'authorization_id',
    'authorization_sha256',
    'decision',
    'decided_at',
    'subject_id',
    'accepted_runtime',
    'accepted_limits',
    'accepted_cost',
    'execution_root_sha256',
    'approval_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  assertSafeText(value.approval_id, 64)
  if (!/^approval_[a-z0-9]{32}$/.test(value.approval_id as string)) {
    throw new ProtocolValidationError()
  }
  assertSafeText(value.authorization_id, 64)
  assertHash(value.authorization_sha256)
  assertHash(value.execution_root_sha256)
  assertHash(value.approval_sha256)

  if (value.decision !== 'approved' && value.decision !== 'rejected') {
    throw new ProtocolValidationError()
  }

  assertRfc3339Utc(value.decided_at)
  assertSafeText(value.subject_id, 64)
  if (!/^[a-z0-9_-]{1,64}$/i.test(value.subject_id as string)) {
    throw new ProtocolValidationError()
  }

  assertObject(value.accepted_runtime)
  assertExactKeys(value.accepted_runtime, [
    'provider_package',
    'provider_package_version',
    'provider_route',
    'model',
  ])
  const runtime = value.accepted_runtime as Record<string, unknown>
  if (
    runtime.provider_package !== EXPECTED_PACKAGE ||
    runtime.provider_package_version !== TARGET_VERSION ||
    runtime.provider_route !== EXPECTED_ROUTE
  ) {
    throw new ProtocolValidationError()
  }
  assertSafeText(runtime.model, 64)

  assertObject(value.accepted_limits)
  assertExactKeys(value.accepted_limits, [
    'runs',
    'task_calls',
    'acquisition_calls',
    'total_calls',
    'max_output_tokens_per_call',
    'call_timeout_ms',
    'batch_timeout_ms',
    'automatic_retries',
    'provider_error_circuit_breaker',
  ])
  const limits = value.accepted_limits as Record<string, unknown>
  if (
    limits.runs !== 6 ||
    limits.task_calls !== 24 ||
    limits.acquisition_calls !== 6 ||
    limits.total_calls !== 30 ||
    limits.max_output_tokens_per_call !== 4096 ||
    limits.call_timeout_ms !== 30000 ||
    limits.batch_timeout_ms !== 600000 ||
    limits.automatic_retries !== 0 ||
    limits.provider_error_circuit_breaker !== 2
  ) {
    throw new ProtocolValidationError()
  }

  assertObject(value.accepted_cost)
  assertExactKeys(value.accepted_cost, ['status', 'worst_case_upper_bound'])
  const cost = value.accepted_cost as Record<string, unknown>
  if (cost.status !== 'verified' && cost.status !== 'unavailable') {
    throw new ProtocolValidationError()
  }
  if (cost.status === 'unavailable' && cost.worst_case_upper_bound !== null) {
    throw new ProtocolValidationError()
  }
  assertDecimalStringOrNull(cost.worst_case_upper_bound)

  // Verify approval_id preimage
  const expectedApprovalId = computeApprovalId({
    authorization_id: value.authorization_id as string,
    authorization_sha256: value.authorization_sha256 as string,
    decision: value.decision as 'approved' | 'rejected',
    decided_at: value.decided_at as string,
    subject_id: value.subject_id as string,
    accepted_runtime: value.accepted_runtime as unknown as AcceptedRuntime,
    accepted_limits: value.accepted_limits as unknown as AcceptedLimits,
    accepted_cost: value.accepted_cost as unknown as AcceptedCost,
    execution_root_sha256: value.execution_root_sha256 as string,
  })
  if (value.approval_id !== expectedApprovalId) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'approval_sha256'))
  if (value.approval_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as RealCanaryApprovalReceipt
}

export function createRealCanaryApprovalReceipt(options: {
  authorization: RealCanaryAuthorizationRequest
  decision: 'approved' | 'rejected'
  decided_at: string
  subject_id: string
  execution_root_sha256: string
}): RealCanaryApprovalReceipt {
  const auth = validateRealCanaryAuthorizationRequest(options.authorization)
  assertRfc3339Utc(options.decided_at)
  assertSafeText(options.subject_id, 64)
  assertHash(options.execution_root_sha256)

  const createdEpoch = parseRfc3339Utc(auth.created_at)
  const expiresEpoch = parseRfc3339Utc(auth.expires_at)
  const decidedEpoch = parseRfc3339Utc(options.decided_at)

  if (decidedEpoch < createdEpoch || decidedEpoch >= expiresEpoch) {
    throw new ProtocolValidationError()
  }

  if (options.decision !== 'approved' && options.decision !== 'rejected') {
    throw new ProtocolValidationError()
  }

  const accepted_runtime: AcceptedRuntime = {
    provider_package: auth.runtime.provider_package,
    provider_package_version: auth.runtime.provider_package_version,
    provider_route: auth.runtime.provider_route,
    model: auth.runtime.model,
  }

  const accepted_limits: AcceptedLimits = {
    runs: 6,
    task_calls: auth.limits.task_calls,
    acquisition_calls: auth.limits.acquisition_calls,
    total_calls: auth.limits.total_calls,
    max_output_tokens_per_call: auth.limits.max_output_tokens_per_call,
    call_timeout_ms: auth.limits.call_timeout_ms,
    batch_timeout_ms: auth.limits.batch_timeout_ms,
    automatic_retries: auth.limits.automatic_retries,
    provider_error_circuit_breaker: 2,
  }

  const accepted_cost: AcceptedCost = {
    status: auth.cost.status,
    worst_case_upper_bound: auth.cost.worst_case_upper_bound,
  }

  const preimage = {
    schema_version: 1 as const,
    authorization_id: auth.authorization_id,
    authorization_sha256: auth.authorization_sha256,
    decision: options.decision,
    decided_at: options.decided_at,
    subject_id: options.subject_id,
    accepted_runtime,
    accepted_limits,
    accepted_cost,
    execution_root_sha256: options.execution_root_sha256,
  }

  const approval_id = computeApprovalId(preimage)

  const body = {
    ...preimage,
    approval_id,
  }

  const approval: RealCanaryApprovalReceipt = {
    ...body,
    approval_sha256: canonicalHash(body),
  }

  return validateRealCanaryApprovalReceipt(approval)
}

export function validateApprovalAuthorizationBinding(
  approval: RealCanaryApprovalReceipt,
  authorization: RealCanaryAuthorizationRequest,
  nowIso: string
): void {
  const checkedApproval = validateRealCanaryApprovalReceipt(approval)
  const checkedAuth = validateRealCanaryAuthorizationRequest(authorization)
  assertRfc3339Utc(nowIso)

  if (checkedApproval.authorization_id !== checkedAuth.authorization_id) {
    throw new ProtocolValidationError()
  }
  if (checkedApproval.authorization_sha256 !== checkedAuth.authorization_sha256) {
    throw new ProtocolValidationError()
  }
  if (checkedApproval.decision !== 'approved') {
    throw new ProtocolValidationError()
  }

  // Runtime matching
  if (
    checkedApproval.accepted_runtime.provider_package !== checkedAuth.runtime.provider_package ||
    checkedApproval.accepted_runtime.provider_package_version !== checkedAuth.runtime.provider_package_version ||
    checkedApproval.accepted_runtime.provider_route !== checkedAuth.runtime.provider_route ||
    checkedApproval.accepted_runtime.model !== checkedAuth.runtime.model
  ) {
    throw new ProtocolValidationError()
  }

  // Limits matching
  if (
    checkedApproval.accepted_limits.task_calls !== checkedAuth.limits.task_calls ||
    checkedApproval.accepted_limits.acquisition_calls !== checkedAuth.limits.acquisition_calls ||
    checkedApproval.accepted_limits.total_calls !== checkedAuth.limits.total_calls ||
    checkedApproval.accepted_limits.max_output_tokens_per_call !== checkedAuth.limits.max_output_tokens_per_call ||
    checkedApproval.accepted_limits.call_timeout_ms !== checkedAuth.limits.call_timeout_ms ||
    checkedApproval.accepted_limits.batch_timeout_ms !== checkedAuth.limits.batch_timeout_ms ||
    checkedApproval.accepted_limits.automatic_retries !== checkedAuth.limits.automatic_retries
  ) {
    throw new ProtocolValidationError()
  }

  // Cost matching
  if (
    checkedApproval.accepted_cost.status !== checkedAuth.cost.status ||
    checkedApproval.accepted_cost.worst_case_upper_bound !== checkedAuth.cost.worst_case_upper_bound
  ) {
    throw new ProtocolValidationError()
  }

  const nowEpoch = parseRfc3339Utc(nowIso)
  const decidedEpoch = parseRfc3339Utc(checkedApproval.decided_at)
  const createdEpoch = parseRfc3339Utc(checkedAuth.created_at)
  const expiresEpoch = parseRfc3339Utc(checkedAuth.expires_at)

  if (decidedEpoch < createdEpoch || decidedEpoch >= expiresEpoch) {
    throw new ProtocolValidationError()
  }
  if (nowEpoch < decidedEpoch || nowEpoch >= expiresEpoch) {
    throw new ProtocolValidationError()
  }
}

export function validateRealCanaryExecutionClaim(value: unknown): RealCanaryExecutionClaim {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'execution_id',
    'authorization_sha256',
    'approval_sha256',
    'execution_root_sha256',
    'claimed_at',
    'claim_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  assertSafeText(value.execution_id, 64)
  if (!/^execution_[a-z0-9]{32}$/.test(value.execution_id as string)) {
    throw new ProtocolValidationError()
  }
  assertHash(value.authorization_sha256)
  assertHash(value.approval_sha256)
  assertHash(value.execution_root_sha256)
  assertHash(value.claim_sha256)
  assertRfc3339Utc(value.claimed_at)

  // P0-3: execution_id is derived strictly from authorization_sha256 + approval_sha256 + execution_root_sha256
  const expectedExecutionId = computeExecutionId({
    authorization_sha256: value.authorization_sha256 as string,
    approval_sha256: value.approval_sha256 as string,
    execution_root_sha256: value.execution_root_sha256 as string,
  })
  if (value.execution_id !== expectedExecutionId) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'claim_sha256'))
  if (value.claim_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as RealCanaryExecutionClaim
}

export function createRealCanaryExecutionClaim(options: {
  authorization_sha256: string
  approval_sha256: string
  execution_root_sha256: string
  claimed_at: string
}): RealCanaryExecutionClaim {
  assertHash(options.authorization_sha256)
  assertHash(options.approval_sha256)
  assertHash(options.execution_root_sha256)
  assertRfc3339Utc(options.claimed_at)

  // P0-3: execution_id does not contain claimed_at
  const execution_id = computeExecutionId({
    authorization_sha256: options.authorization_sha256,
    approval_sha256: options.approval_sha256,
    execution_root_sha256: options.execution_root_sha256,
  })

  const body = {
    schema_version: 1 as const,
    execution_id,
    authorization_sha256: options.authorization_sha256,
    approval_sha256: options.approval_sha256,
    execution_root_sha256: options.execution_root_sha256,
    claimed_at: options.claimed_at,
  }

  const claim: RealCanaryExecutionClaim = {
    ...body,
    claim_sha256: canonicalHash(body),
  }

  return validateRealCanaryExecutionClaim(claim)
}
