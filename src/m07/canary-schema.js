import { createHash } from 'node:crypto'

export const ALLOWED_FAILURE_REASONS = [
  'provider_error',
  'model_noncompliance',
  'schema_validation_error',
  'timeout',
  'environment_error',
  'security_violation',
]

export const REQUIRED_CANARY_STEPS = Object.freeze([
  Object.freeze({ run: 1, name: 'automatic_capture' }),
  Object.freeze({ run: 2, name: 'restart_and_read' }),
  Object.freeze({ run: 3, name: 'promote_to_long_term' }),
  Object.freeze({ run: 4, name: 'restart_and_search' }),
  Object.freeze({ run: 5, name: 'forget_and_grant' }),
  Object.freeze({ run: 6, name: 'scope_isolation' }),
])

export function compareCodePoints(left, right) {
  const a = Array.from(left)
  const b = Array.from(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const delta = a[index].codePointAt(0) - b[index].codePointAt(0)
    if (delta) return delta
  }
  return a.length - b.length
}

function isPlainObject(val) {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false
  const proto = Object.getPrototypeOf(val)
  if (proto !== Object.prototype && proto !== null) return false
  if (Object.getOwnPropertySymbols(val).length > 0) return false
  for (const key of Object.getOwnPropertyNames(val)) {
    const desc = Object.getOwnPropertyDescriptor(val, key)
    if (!desc || !desc.enumerable || !('value' in desc) || 'get' in desc || 'set' in desc) return false
  }
  return true
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number')
    if (Object.is(value, -0)) return 0
    return value
  }
  if (typeof value !== 'object') throw new Error('invalid_type')
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (!isPlainObject(value)) throw new Error('not_plain_object')
  const result = Object.create(null)
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    result[key] = canonicalValue(value[key])
  }
  return result
}

export function canonicalHash(value) {
  const json = JSON.stringify(canonicalValue(value))
  return 'sha256_' + createHash('sha256').update(json, 'utf8').digest('hex')
}

function assertExactKeys(val, allowedKeys) {
  const keys = Object.keys(val).sort(compareCodePoints)
  const expected = [...allowedKeys].sort(compareCodePoints)
  if (keys.length !== expected.length) {
    throw new Error('invalid_keys_count')
  }
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== expected[i]) {
      throw new Error('unexpected_or_missing_key')
    }
  }
}

function assertSafeCanaryText(text, maxLen, fieldName) {
  if (typeof text !== 'string' || text.length === 0 || text.length > maxLen) {
    throw new Error(`invalid_${fieldName}_length`)
  }
  if (/[\r\n\0]/.test(text)) {
    throw new Error(`invalid_${fieldName}_control_characters`)
  }
  if (/\/Users|\/home|\/var|\/tmp|[a-zA-Z]:\\/i.test(text)) {
    throw new Error(`invalid_${fieldName}_absolute_path`)
  }
  if (/bearer|api_key|token|credential|secret/i.test(text)) {
    throw new Error(`invalid_${fieldName}_credential_pattern`)
  }
}

export function computePlanId(planWithoutId) {
  const hash = canonicalHash(planWithoutId)
  return 'plan_' + hash.slice(7, 39)
}

export function computePlanSha256(plan) {
  return canonicalHash(plan)
}

export function createCanaryPlan(params) {
  const planBase = {
    schema_version: 1,
    dsh_version: '0.1.1-rc.2',
    tarball_sha256: params.tarball_sha256,
    budget: {
      max_runs: 6,
      max_model_requests: 12,
      max_run_timeout_seconds: 120,
      max_total_timeout_seconds: 720,
      max_consecutive_provider_errors: 2,
    },
    steps: REQUIRED_CANARY_STEPS.map((s) => ({ ...s })),
    knowledge: {
      topic: params.knowledge.topic,
      canary_fact: params.knowledge.canary_fact,
    },
  }
  const plan_id = computePlanId(planBase)
  const plan = {
    ...planBase,
    plan_id,
  }
  return validateCanaryPlan(plan)
}

export function validateCanaryPlan(val) {
  if (!isPlainObject(val)) throw new Error('plan_not_object')
  assertExactKeys(val, ['schema_version', 'plan_id', 'dsh_version', 'tarball_sha256', 'budget', 'steps', 'knowledge'])

  if (val.schema_version !== 1) throw new Error('invalid_schema_version')
  if (val.dsh_version !== '0.1.1-rc.2') throw new Error('invalid_dsh_version')
  if (typeof val.tarball_sha256 !== 'string' || !/^sha256_[0-9a-f]{64}$/.test(val.tarball_sha256)) {
    throw new Error('invalid_tarball_sha256')
  }

  // Validate budget
  const b = val.budget
  if (!isPlainObject(b)) throw new Error('invalid_budget')
  assertExactKeys(b, [
    'max_runs',
    'max_model_requests',
    'max_run_timeout_seconds',
    'max_total_timeout_seconds',
    'max_consecutive_provider_errors',
  ])

  if (!Number.isSafeInteger(b.max_runs) || b.max_runs !== 6) throw new Error('invalid_max_runs')
  if (!Number.isSafeInteger(b.max_model_requests) || b.max_model_requests !== 12) {
    throw new Error('invalid_max_model_requests')
  }
  if (!Number.isSafeInteger(b.max_run_timeout_seconds) || b.max_run_timeout_seconds !== 120) {
    throw new Error('invalid_max_run_timeout_seconds')
  }
  if (!Number.isSafeInteger(b.max_total_timeout_seconds) || b.max_total_timeout_seconds !== 720) {
    throw new Error('invalid_max_total_timeout_seconds')
  }
  if (!Number.isSafeInteger(b.max_consecutive_provider_errors) || b.max_consecutive_provider_errors !== 2) {
    throw new Error('invalid_max_consecutive_provider_errors')
  }

  // Validate steps
  if (!Array.isArray(val.steps) || val.steps.length !== 6) {
    throw new Error('invalid_steps_length')
  }
  for (let i = 0; i < 6; i++) {
    const step = val.steps[i]
    if (!isPlainObject(step)) throw new Error('invalid_step')
    assertExactKeys(step, ['run', 'name'])
    if (step.run !== REQUIRED_CANARY_STEPS[i].run || step.name !== REQUIRED_CANARY_STEPS[i].name) {
      throw new Error('invalid_step_sequence')
    }
  }

  // Validate knowledge
  const k = val.knowledge
  if (!isPlainObject(k)) throw new Error('invalid_knowledge')
  assertExactKeys(k, ['topic', 'canary_fact'])
  assertSafeCanaryText(k.topic, 128, 'topic')
  assertSafeCanaryText(k.canary_fact, 512, 'canary_fact')

  // Validate plan_id derivation
  const { plan_id, ...rest } = val
  const expectedPlanId = computePlanId(rest)
  if (plan_id !== expectedPlanId) {
    throw new Error('invalid_plan_id')
  }

  return val
}

export function computeReportSha256(report) {
  const { report_sha256: _, ...rest } = report
  return canonicalHash(rest)
}

export function validateCanaryReport(val) {
  if (!isPlainObject(val)) throw new Error('report_not_object')
  assertExactKeys(val, [
    'schema_version',
    'status',
    'dsh_version',
    'package_version',
    'package_sha256',
    'run_count',
    'model_request_count',
    'checks',
    'reason_code',
    'cleanup_clean',
    'report_sha256',
  ])

  if (val.schema_version !== 1) throw new Error('invalid_schema_version')
  if (val.dsh_version !== '0.1.1-rc.2') throw new Error('invalid_dsh_version')
  if (val.package_version !== '0.0.0-dev' && val.package_version !== '0.1.0') {
    throw new Error('invalid_package_version')
  }
  if (typeof val.package_sha256 !== 'string' || !/^sha256_[0-9a-f]{64}$/.test(val.package_sha256)) {
    throw new Error('invalid_package_sha256')
  }

  if (!Number.isSafeInteger(val.run_count) || val.run_count < 0 || val.run_count > 6) {
    throw new Error('invalid_run_count')
  }
  if (
    !Number.isSafeInteger(val.model_request_count) ||
    val.model_request_count < 0 ||
    val.model_request_count > 12
  ) {
    throw new Error('invalid_model_request_count')
  }

  const c = val.checks
  if (!isPlainObject(c)) throw new Error('invalid_checks')
  assertExactKeys(c, [
    'automatic_capture',
    'restart_persistence',
    'progressive_disclosure',
    'promotion',
    'forget_and_grant',
    'scope_isolation',
  ])

  const checkValues = ['pass', 'fail', 'not_run']
  for (const k of Object.keys(c)) {
    if (!checkValues.includes(c[k])) {
      throw new Error('invalid_check_status')
    }
  }

  if (typeof val.cleanup_clean !== 'boolean') throw new Error('invalid_cleanup_clean')

  // Check status matrix
  const status = val.status
  const checksList = Object.values(c)

  if (status === 'pass') {
    if (val.run_count !== 6) throw new Error('invalid_pass_run_count')
    if (checksList.some((st) => st !== 'pass')) throw new Error('invalid_pass_checks')
    if (val.cleanup_clean !== true) throw new Error('invalid_pass_cleanup')
    if (val.reason_code !== null) throw new Error('invalid_pass_reason_code')
  } else if (status === 'dry_run_ready') {
    if (val.run_count !== 0) throw new Error('invalid_dry_run_run_count')
    if (val.model_request_count !== 0) throw new Error('invalid_dry_run_model_count')
    if (checksList.some((st) => st !== 'not_run')) throw new Error('invalid_dry_run_checks')
    if (val.cleanup_clean !== true) throw new Error('invalid_dry_run_cleanup')
    if (val.reason_code !== null) throw new Error('invalid_dry_run_reason_code')
  } else if (status === 'fail' || status === 'aborted') {
    if (checksList.every((st) => st === 'pass')) throw new Error('invalid_fail_checks')
    if (!ALLOWED_FAILURE_REASONS.includes(val.reason_code)) {
      throw new Error('invalid_failure_reason_code')
    }
  } else {
    throw new Error('invalid_status')
  }

  // Validate report_sha256 exact match
  const expectedHash = computeReportSha256(val)
  if (val.report_sha256 !== expectedHash) {
    throw new Error('invalid_report_sha256')
  }

  return val
}
