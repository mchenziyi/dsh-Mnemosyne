import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const REQUIRED_CANARY_RUNS = [
  'run_1',
  'run_2',
  'run_3',
  'run_4',
  'run_5',
  'run_6',
]

export const REQUIRED_RUNTIME_MODULE_ROLES = [
  'audit_sidecar',
  'resume_driver',
  'budget_ledger',
  'session_evidence',
]

export const FORBIDDEN_REPORT_KEYS = new Set([
  'prompt',
  'response',
  'command',
  'path',
  'messages',
  'api_key',
  'token',
  'secret',
  'authorization',
  'key',
  'stdout',
  'stderr',
])

export const VALID_REASON_CODES = new Set([
  'product_invariant_failed',
  'dsh_compatibility_failed',
  'model_noncompliance',
  'provider_failed',
  'credential_unavailable',
  'authorization_invalid',
  'budget_exhausted',
  'subprocess_timeout',
  'environment_failed',
  'security_boundary_failed',
  'cleanup_failed',
])

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
  return '{' + entries.join(',') + '}'
}

export function computeCanonicalHash(value) {
  const json = canonicalJson(value)
  return 'sha256_' + createHash('sha256').update(json).digest('hex')
}

export function computeProjectScopeId(projectRoot) {
  let norm = projectRoot
  try {
    norm = realpathSync(projectRoot)
  } catch {}
  return computeCanonicalHash({
    schema_version: 1,
    kind: 'project',
    project_root: norm,
  })
}

export function computeSessionScopeId(projectScopeId, sessionId) {
  return computeCanonicalHash({
    schema_version: 1,
    kind: 'session',
    project_scope_id: projectScopeId,
    session_id: sessionId,
  })
}

export function computeSha256(content) {
  return 'sha256_' + createHash('sha256').update(content, 'utf8').digest('hex')
}

export function computeExecutionManifestSha256(manifestWithoutHash) {
  return computeSha256(canonicalJson(manifestWithoutHash))
}

export function computePlanSha256(planWithoutHash) {
  const { plan_sha256, ...rest } = planWithoutHash
  return computeSha256(canonicalJson(rest))
}

export function computeApprovalSha256(approvalWithoutHash) {
  const { approval_sha256, ...rest } = approvalWithoutHash
  return computeSha256(canonicalJson(rest))
}

export function computeReportSha256(reportWithoutHash) {
  const { report_sha256, ...rest } = reportWithoutHash
  return computeSha256(canonicalJson(rest))
}

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/
const PLAN_ID_REGEX = /^canary_plan_[0-9a-f]{64}$/
const APPROVAL_ID_REGEX = /^canary_approval_[0-9a-f]{64}$/
const SAFE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/

export const FROZEN_CANARY_TASKS = Object.freeze({
  run_1: 'canary run 1: perform automatic memory capture for aurora envelope component',
  run_2: 'canary run 2: restart and search open aurora envelope',
  run_3: 'canary run 3: promote aurora envelope memory to long term',
  run_4: 'canary run 4: cross-session read aurora envelope long-term memory',
  run_5: 'canary run 5: forget aurora envelope memory',
  run_6: 'canary run 6: verify scope isolation in project b',
})

export function createExecutionManifest(params) {
  const {
    dsh_executable_realpath,
    tarball_realpath,
    tarball_sha256,
    profile_dependency_value,
    sidecar_patch_sha256,
    resume_patch_sha256,
    run_root_identity,
    runtime_module_files,
    runs,
    extra_patches = [],
  } = params

  return {
    schema_version: 1,
    dsh_executable_realpath,
    dsh_version: '0.1.1-rc.2',
    profile: 'headless',
    tarball_realpath,
    tarball_sha256,
    profile_dependency_value,
    sidecar_patch_sha256,
    resume_patch_sha256,
    run_root_identity,
    runtime_module_files,
    runs,
    extra_patches,
  }
}

export function validateExecutionManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('invalid_execution_manifest')
  }

  const expectedKeys = new Set([
    'schema_version',
    'dsh_executable_realpath',
    'dsh_version',
    'profile',
    'tarball_realpath',
    'tarball_sha256',
    'profile_dependency_value',
    'sidecar_patch_sha256',
    'resume_patch_sha256',
    'run_root_identity',
    'runtime_module_files',
    'runs',
    'extra_patches',
  ])

  for (const k of Object.keys(manifest)) {
    if (!expectedKeys.has(k)) {
      throw new Error('invalid_execution_manifest')
    }
  }

  if (manifest.schema_version !== 1) throw new Error('invalid_execution_manifest')
  if (typeof manifest.dsh_executable_realpath !== 'string' || !manifest.dsh_executable_realpath || !isAbsolute(manifest.dsh_executable_realpath)) throw new Error('invalid_execution_manifest')
  if (manifest.dsh_version !== '0.1.1-rc.2') throw new Error('invalid_execution_manifest')
  if (manifest.profile !== 'headless') throw new Error('invalid_execution_manifest')
  if (typeof manifest.tarball_realpath !== 'string' || !manifest.tarball_realpath || !isAbsolute(manifest.tarball_realpath)) throw new Error('invalid_execution_manifest')
  if (typeof manifest.tarball_sha256 !== 'string' || !HASH_REGEX.test(manifest.tarball_sha256)) throw new Error('invalid_execution_manifest')
  if (typeof manifest.profile_dependency_value !== 'string' || !manifest.profile_dependency_value) throw new Error('invalid_execution_manifest')
  if (typeof manifest.sidecar_patch_sha256 !== 'string' || !HASH_REGEX.test(manifest.sidecar_patch_sha256)) throw new Error('invalid_execution_manifest')
  if (typeof manifest.resume_patch_sha256 !== 'string' || !HASH_REGEX.test(manifest.resume_patch_sha256)) throw new Error('invalid_execution_manifest')
  if (typeof manifest.run_root_identity !== 'string' || !HASH_REGEX.test(manifest.run_root_identity)) throw new Error('invalid_execution_manifest')

  // Validate runtime_module_files closure
  if (!Array.isArray(manifest.runtime_module_files) || manifest.runtime_module_files.length !== 4) {
    throw new Error('invalid_execution_manifest')
  }
  const runtimeModuleKeySet = new Set(['role', 'realpath', 'content_sha256'])
  for (let i = 0; i < 4; i++) {
    const item = manifest.runtime_module_files[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_execution_manifest')
    for (const k of Object.keys(item)) {
      if (!runtimeModuleKeySet.has(k)) throw new Error('invalid_execution_manifest')
    }
    if (item.role !== REQUIRED_RUNTIME_MODULE_ROLES[i]) throw new Error('invalid_execution_manifest')
    if (typeof item.realpath !== 'string' || !item.realpath || !isAbsolute(item.realpath)) throw new Error('invalid_execution_manifest')
    if (typeof item.content_sha256 !== 'string' || !HASH_REGEX.test(item.content_sha256)) throw new Error('invalid_execution_manifest')
  }

  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 6) throw new Error('invalid_execution_manifest')
  const expectedRunIds = ['run_1', 'run_2', 'run_3', 'run_4', 'run_5', 'run_6']
  const runKeySet = new Set(['id', 'is_resume', 'cwd_rel', 'task', 'patch_hashes'])

  for (let i = 0; i < 6; i++) {
    const r = manifest.runs[i]
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('invalid_execution_manifest')

    for (const rk of Object.keys(r)) {
      if (!runKeySet.has(rk)) throw new Error('invalid_execution_manifest')
    }

    if (r.id !== expectedRunIds[i]) throw new Error('invalid_execution_manifest')

    const expectedResume = (r.id === 'run_2' || r.id === 'run_3')
    if (r.is_resume !== expectedResume) throw new Error('invalid_execution_manifest')

    const expectedCwd = (r.id === 'run_6') ? 'project-b' : 'project-a'
    if (r.cwd_rel !== expectedCwd) throw new Error('invalid_execution_manifest')

    if (r.task !== FROZEN_CANARY_TASKS[r.id]) throw new Error('invalid_execution_manifest')

    if (!Array.isArray(r.patch_hashes)) throw new Error('invalid_execution_manifest')
    for (const ph of r.patch_hashes) {
      if (typeof ph !== 'string' || !HASH_REGEX.test(ph)) throw new Error('invalid_execution_manifest')
    }
  }

  if (!Array.isArray(manifest.extra_patches)) throw new Error('invalid_execution_manifest')
  const seenExtraNames = new Set()
  const extraKeySet = new Set(['name', 'patch_sha256', 'module_realpath', 'module_sha256'])

  for (const ep of manifest.extra_patches) {
    if (!ep || typeof ep !== 'object' || Array.isArray(ep)) throw new Error('invalid_execution_manifest')

    for (const ek of Object.keys(ep)) {
      if (!extraKeySet.has(ek)) throw new Error('invalid_execution_manifest')
    }

    if (typeof ep.name !== 'string' || !SAFE_NAME_REGEX.test(ep.name) || ep.name.includes('/') || ep.name.includes('\\') || ep.name.includes('..')) {
      throw new Error('invalid_execution_manifest')
    }
    if (seenExtraNames.has(ep.name)) {
      throw new Error('invalid_execution_manifest')
    }
    seenExtraNames.add(ep.name)

    if (typeof ep.patch_sha256 !== 'string' || !HASH_REGEX.test(ep.patch_sha256)) {
      throw new Error('invalid_execution_manifest')
    }

    if (typeof ep.module_realpath !== 'string' || (ep.module_realpath && !isAbsolute(ep.module_realpath))) {
      throw new Error('invalid_execution_manifest')
    }
    if (typeof ep.module_sha256 !== 'string' || (ep.module_sha256 && !HASH_REGEX.test(ep.module_sha256))) {
      throw new Error('invalid_execution_manifest')
    }
  }

  return manifest
}

export function createRealCanaryPlan(params) {
  const {
    package_sha256,
    run_root_identity,
    created_at,
    expires_at,
    nonce,
    execution_manifest_sha256 = 'sha256_' + createHash('sha256').update(nonce + 'dry_run_manifest').digest('hex'),
    plan_id = 'canary_plan_' + createHash('sha256').update(nonce + created_at).digest('hex'),
  } = params

  const base = {
    schema_version: 1,
    plan_id,
    dsh_version: '0.1.1-rc.2',
    package_version: '0.0.0-dev',
    package_sha256,
    profile: 'headless',
    run_root_identity,
    execution_manifest_sha256,
    credential_ref: 'temporary_dsh_home_credentials',
    budgets: {
      max_headless_runs: 6,
      max_model_requests: 12,
      retry_count: 0,
      per_run_timeout_ms: 120000,
      total_timeout_ms: 720000,
      consecutive_provider_or_protocol_errors: 2,
    },
    runs: REQUIRED_CANARY_RUNS,
    created_at,
    expires_at,
    nonce,
  }

  const plan_sha256 = computePlanSha256(base)
  return {
    ...base,
    plan_sha256,
  }
}

export function validateRealCanaryPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('invalid_plan')
  }

  const expectedTopKeys = new Set([
    'schema_version',
    'plan_id',
    'plan_sha256',
    'dsh_version',
    'package_version',
    'package_sha256',
    'profile',
    'run_root_identity',
    'execution_manifest_sha256',
    'credential_ref',
    'budgets',
    'runs',
    'created_at',
    'expires_at',
    'nonce',
  ])

  for (const k of Object.keys(plan)) {
    if (!expectedTopKeys.has(k)) {
      throw new Error('invalid_plan')
    }
  }

  if (plan.schema_version !== 1) throw new Error('invalid_plan')
  if (typeof plan.plan_id !== 'string' || !PLAN_ID_REGEX.test(plan.plan_id)) throw new Error('invalid_plan')
  if (plan.dsh_version !== '0.1.1-rc.2') throw new Error('invalid_plan')
  if (plan.package_version !== '0.0.0-dev') throw new Error('invalid_plan')
  if (typeof plan.package_sha256 !== 'string' || !HASH_REGEX.test(plan.package_sha256)) throw new Error('invalid_plan')
  if (plan.profile !== 'headless') throw new Error('invalid_plan')
  if (typeof plan.run_root_identity !== 'string' || !HASH_REGEX.test(plan.run_root_identity)) throw new Error('invalid_plan')
  if (typeof plan.execution_manifest_sha256 !== 'string' || !HASH_REGEX.test(plan.execution_manifest_sha256)) throw new Error('invalid_plan')
  if (plan.credential_ref !== 'temporary_dsh_home_credentials') throw new Error('invalid_plan')

  if (!plan.budgets || typeof plan.budgets !== 'object') throw new Error('invalid_plan')
  const expectedBudgetKeys = new Set([
    'max_headless_runs',
    'max_model_requests',
    'retry_count',
    'per_run_timeout_ms',
    'total_timeout_ms',
    'consecutive_provider_or_protocol_errors',
  ])
  for (const bk of Object.keys(plan.budgets)) {
    if (!expectedBudgetKeys.has(bk)) throw new Error('invalid_plan')
  }

  if (plan.budgets.max_headless_runs !== 6) throw new Error('invalid_plan')
  if (plan.budgets.max_model_requests !== 12) throw new Error('invalid_plan')
  if (plan.budgets.retry_count !== 0) throw new Error('invalid_plan')
  if (plan.budgets.per_run_timeout_ms !== 120000) throw new Error('invalid_plan')
  if (plan.budgets.total_timeout_ms !== 720000) throw new Error('invalid_plan')
  if (plan.budgets.consecutive_provider_or_protocol_errors !== 2) throw new Error('invalid_plan')

  if (!Array.isArray(plan.runs) || plan.runs.length !== 6) throw new Error('invalid_plan')
  for (let i = 0; i < 6; i++) {
    if (plan.runs[i] !== REQUIRED_CANARY_RUNS[i]) throw new Error('invalid_plan')
  }

  if (typeof plan.created_at !== 'string' || Number.isNaN(Date.parse(plan.created_at))) throw new Error('invalid_plan')
  if (typeof plan.expires_at !== 'string' || Number.isNaN(Date.parse(plan.expires_at))) throw new Error('invalid_plan')
  if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) throw new Error('invalid_plan')
  if (typeof plan.nonce !== 'string' || plan.nonce.length < 8) throw new Error('invalid_plan')

  const computedHash = computePlanSha256(plan)
  if (plan.plan_sha256 !== computedHash) {
    throw new Error('invalid_plan')
  }

  return plan
}

export function createApprovalReceipt(params) {
  const {
    plan_id,
    plan_sha256,
    approved_at,
    expires_at,
    approval_id = 'canary_approval_' + createHash('sha256').update(plan_id + approved_at).digest('hex'),
  } = params

  const base = {
    schema_version: 1,
    approval_id,
    plan_id,
    plan_sha256,
    approved: true,
    approved_at,
    expires_at,
  }

  const approval_sha256 = computeApprovalSha256(base)
  return {
    ...base,
    approval_sha256,
  }
}

export function validateApprovalReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('invalid_approval')
  }

  const expectedKeys = new Set([
    'schema_version',
    'approval_id',
    'plan_id',
    'plan_sha256',
    'approved',
    'approved_at',
    'expires_at',
    'approval_sha256',
  ])

  for (const k of Object.keys(receipt)) {
    if (!expectedKeys.has(k)) {
      throw new Error('invalid_approval')
    }
  }

  if (receipt.schema_version !== 1) throw new Error('invalid_approval')
  if (typeof receipt.approval_id !== 'string' || !APPROVAL_ID_REGEX.test(receipt.approval_id)) throw new Error('invalid_approval')
  if (typeof receipt.plan_id !== 'string' || !PLAN_ID_REGEX.test(receipt.plan_id)) throw new Error('invalid_approval')
  if (typeof receipt.plan_sha256 !== 'string' || !HASH_REGEX.test(receipt.plan_sha256)) throw new Error('invalid_approval')
  if (receipt.approved !== true) throw new Error('invalid_approval')
  if (typeof receipt.approved_at !== 'string' || Number.isNaN(Date.parse(receipt.approved_at))) throw new Error('invalid_approval')
  if (typeof receipt.expires_at !== 'string' || Number.isNaN(Date.parse(receipt.expires_at))) throw new Error('invalid_approval')
  if (Date.parse(receipt.expires_at) <= Date.parse(receipt.approved_at)) throw new Error('invalid_approval')

  const computed = computeApprovalSha256(receipt)
  if (receipt.approval_sha256 !== computed) {
    throw new Error('invalid_approval')
  }

  return receipt
}

export function createRedactedCanaryReport(params) {
  const {
    status,
    package_sha256,
    plan_sha256,
    approval_sha256,
    run_count,
    model_request_count,
    checks,
    reason_code = null,
    cleanup_clean,
  } = params

  const base = {
    schema_version: 1,
    status,
    dsh_version: '0.1.1-rc.2',
    package_version: '0.0.0-dev',
    package_sha256,
    plan_sha256,
    approval_sha256,
    run_count,
    model_request_count,
    checks,
    reason_code,
    cleanup_clean,
  }

  const report_sha256 = computeReportSha256(base)
  return {
    ...base,
    report_sha256,
  }
}

export function validateRedactedCanaryReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('invalid_report')
  }

  const expectedTopKeys = new Set([
    'schema_version',
    'status',
    'dsh_version',
    'package_version',
    'package_sha256',
    'plan_sha256',
    'approval_sha256',
    'run_count',
    'model_request_count',
    'checks',
    'reason_code',
    'cleanup_clean',
    'report_sha256',
  ])

  for (const k of Object.keys(report)) {
    if (!expectedTopKeys.has(k) || FORBIDDEN_REPORT_KEYS.has(k)) {
      throw new Error('invalid_report')
    }
  }

  if (report.schema_version !== 1) throw new Error('invalid_report')
  if (!['pass', 'fail', 'aborted'].includes(report.status)) throw new Error('invalid_report')
  if (report.dsh_version !== '0.1.1-rc.2') throw new Error('invalid_report')
  if (report.package_version !== '0.0.0-dev') throw new Error('invalid_report')
  if (typeof report.package_sha256 !== 'string' || !HASH_REGEX.test(report.package_sha256)) throw new Error('invalid_report')
  if (typeof report.plan_sha256 !== 'string' || !HASH_REGEX.test(report.plan_sha256)) throw new Error('invalid_report')
  if (typeof report.approval_sha256 !== 'string' || !HASH_REGEX.test(report.approval_sha256)) throw new Error('invalid_report')

  if (typeof report.run_count !== 'number' || !Number.isInteger(report.run_count) || report.run_count < 0 || report.run_count > 6) throw new Error('invalid_report')
  if (typeof report.model_request_count !== 'number' || !Number.isInteger(report.model_request_count) || report.model_request_count < 0 || report.model_request_count > 12) throw new Error('invalid_report')

  if (!report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks)) throw new Error('invalid_report')
  const requiredCheckKeys = [
    'execution_wiring',
    'automatic_capture',
    'restart_persistence',
    'progressive_disclosure',
    'promotion',
    'forget_and_grant',
    'scope_isolation',
  ]
  const checkKeys = Object.keys(report.checks)
  if (checkKeys.length !== 7) throw new Error('invalid_report')
  for (const k of requiredCheckKeys) {
    if (!Object.prototype.hasOwnProperty.call(report.checks, k)) {
      throw new Error('invalid_report')
    }
  }

  // In I1, the 6 business predicates must be strictly 'not_run'
  const businessKeys = [
    'automatic_capture',
    'restart_persistence',
    'progressive_disclosure',
    'promotion',
    'forget_and_grant',
    'scope_isolation',
  ]
  for (const bk of businessKeys) {
    if (report.checks[bk] !== 'not_run') {
      throw new Error('invalid_report')
    }
  }

  const ew = report.checks.execution_wiring
  if (ew !== 'pass' && ew !== 'fail') {
    throw new Error('invalid_report')
  }

  if (report.status === 'pass') {
    if (ew !== 'pass') throw new Error('invalid_report')
    if (report.run_count !== 6) throw new Error('invalid_report')
    if (report.model_request_count <= 0 || !Number.isInteger(report.model_request_count)) throw new Error('invalid_report')
    if (report.cleanup_clean !== true) throw new Error('invalid_report')
    if (report.reason_code !== null) throw new Error('invalid_report')
  } else if (report.status === 'fail' || report.status === 'aborted') {
    if (ew === 'pass') throw new Error('invalid_report')
    if (report.reason_code === null || typeof report.reason_code !== 'string' || !VALID_REASON_CODES.has(report.reason_code)) {
      throw new Error('invalid_report')
    }
  }

  if (typeof report.cleanup_clean !== 'boolean') throw new Error('invalid_report')

  const computed = computeReportSha256(report)
  if (report.report_sha256 !== computed) {
    throw new Error('invalid_report')
  }

  return report
}
