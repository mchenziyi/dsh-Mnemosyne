import {
  assertArray,
  assertExactKeys,
  assertHash,
  assertNoDuplicate,
  assertObject,
  assertSafeText,
  canonicalHash,
  compareCodePoints,
  ProtocolValidationError,
  sha256,
  withoutHash,
} from '../protocol/canonical.js'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as dshDeepSeek from '@deepseek-ai/dsh-llm-deepseek'

export interface PublicContractsAudit {
  provider_plugin: 'pass' | 'missing' | 'incompatible'
  provider_route: 'pass' | 'missing' | 'incompatible'
  model_catalog: 'pass' | 'missing' | 'incompatible'
  credential_reference: 'pass' | 'missing' | 'incompatible'
  isolated_profile: 'pass' | 'missing' | 'incompatible'
  zero_retry_path: 'pass' | 'missing' | 'incompatible'
  max_output_cap: 'pass' | 'missing' | 'incompatible'
}

export interface OfficialReferenceAudit {
  repository: 'deepseek-ai/deepseek-harness'
  package: '@deepseek-ai/dsh-llm-deepseek'
  package_version: '0.1.0-rc.8'
  source_ref: 'npm:@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8'
}

export interface ProviderCompatibilityAudit {
  schema_version: 1
  audited_at: string
  project_dsh_version: '0.1.0-rc.8'
  project_lock_sha256: string
  official_reference: OfficialReferenceAudit
  public_contracts: PublicContractsAudit
  decision: 'compatible' | 'blocked'
  reasons: string[]
  audit_sha256: string
}

const PUBLIC_CONTRACT_KEYS = [
  'provider_plugin',
  'provider_route',
  'model_catalog',
  'credential_reference',
  'isolated_profile',
  'zero_retry_path',
  'max_output_cap',
] as const

const OFFICIAL_REF_KEYS = [
  'repository',
  'package',
  'package_version',
  'source_ref',
] as const

const TARGET_VERSION = '0.1.0-rc.8' as const
const EXPECTED_PACKAGE = '@deepseek-ai/dsh-llm-deepseek' as const
const EXPECTED_ROUTE = 'deepseek-official' as const
const EXPECTED_MODEL = 'deepseek-v4-flash' as const
const EXPECTED_REPO = 'deepseek-ai/deepseek-harness' as const
const EXPECTED_SOURCE_REF = 'npm:@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8' as const

const ALLOWED_REASONS = [
  'adapter_options_invalid',
  'adapter_options_resolution_failed',
  'credential_reference_invalid',
  'custom_options_resolution_failed',
  'direct_dsh_dependency_version_mismatch',
  'isolated_profile_unsupported',
  'max_tokens_override_failed',
  'model_catalog_missing_expected_model',
  'provider_package_missing',
  'provider_package_version_mismatch',
  'provider_route_incompatible',
  'root_exports_incomplete',
  'zero_retry_override_failed',
] as const

const MAX_REASONS_COUNT = 16

export function parseRfc3339Utc(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new ProtocolValidationError()
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) {
    throw new ProtocolValidationError()
  }

  const year = parseInt(match[1], 10)
  const month = parseInt(match[2], 10)
  const day = parseInt(match[3], 10)
  const hour = parseInt(match[4], 10)
  const minute = parseInt(match[5], 10)
  const second = parseInt(match[6], 10)
  const fractionStr = match[7]
  const tz = match[8]

  if (month < 1 || month > 12) throw new ProtocolValidationError()

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  if (day < 1 || day > daysInMonth[month - 1]) throw new ProtocolValidationError()
  if (hour > 23 || minute > 59 || second > 59) throw new ProtocolValidationError()

  let offsetMinutes = 0
  if (tz !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const tzHour = parseInt(match[10], 10)
    const tzMinute = parseInt(match[11], 10)
    if (tzHour > 23 || tzMinute > 59) throw new ProtocolValidationError()
    offsetMinutes = sign * (tzHour * 60 + tzMinute)
  }

  const millis = fractionStr ? parseInt(fractionStr.padEnd(3, '0'), 10) : 0

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60 * 1000
  if (isNaN(utcMillis)) throw new ProtocolValidationError()

  return utcMillis
}

export function assertRfc3339Utc(value: unknown): asserts value is string {
  parseRfc3339Utc(value)
}

export function validateProviderCompatibilityAudit(value: unknown): ProviderCompatibilityAudit {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'audited_at',
    'project_dsh_version',
    'project_lock_sha256',
    'official_reference',
    'public_contracts',
    'decision',
    'reasons',
    'audit_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  assertRfc3339Utc(value.audited_at)
  if (value.project_dsh_version !== TARGET_VERSION) throw new ProtocolValidationError()
  assertHash(value.project_lock_sha256)
  assertHash(value.audit_sha256)

  assertObject(value.official_reference)
  assertExactKeys(value.official_reference, OFFICIAL_REF_KEYS)
  const ref = value.official_reference as Record<string, unknown>
  if (
    ref.repository !== EXPECTED_REPO ||
    ref.package !== EXPECTED_PACKAGE ||
    ref.package_version !== TARGET_VERSION ||
    ref.source_ref !== EXPECTED_SOURCE_REF
  ) {
    throw new ProtocolValidationError()
  }

  assertObject(value.public_contracts)
  assertExactKeys(value.public_contracts, PUBLIC_CONTRACT_KEYS)
  const contracts = value.public_contracts as Record<string, unknown>
  for (const key of PUBLIC_CONTRACT_KEYS) {
    const val = contracts[key]
    if (val !== 'pass' && val !== 'missing' && val !== 'incompatible') {
      throw new ProtocolValidationError()
    }
  }

  if (!Array.isArray(value.reasons) || value.reasons.length > MAX_REASONS_COUNT) {
    throw new ProtocolValidationError()
  }
  assertNoDuplicate(value.reasons as string[])
  const sorted = [...(value.reasons as string[])].sort(compareCodePoints)
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== (value.reasons as string[])[i]) throw new ProtocolValidationError()
    if (!ALLOWED_REASONS.includes(sorted[i] as (typeof ALLOWED_REASONS)[number])) {
      throw new ProtocolValidationError()
    }
  }

  const allPass = PUBLIC_CONTRACT_KEYS.every((k) => contracts[k] === 'pass')
  if (allPass && value.reasons.length > 0) {
    throw new ProtocolValidationError()
  }
  if (!allPass && value.reasons.length === 0) {
    throw new ProtocolValidationError()
  }

  const expectedDecision = allPass ? 'compatible' : 'blocked'
  if (value.decision !== expectedDecision) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'audit_sha256'))
  if (value.audit_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as ProviderCompatibilityAudit
}

export function createProviderCompatibilityAudit(options: {
  audited_at: string
  package_json_content: string
  lockfile_content: string
}): ProviderCompatibilityAudit {
  assertRfc3339Utc(options.audited_at)

  const reasons: string[] = []

  let provider_plugin: 'pass' | 'missing' | 'incompatible' = 'missing'
  let provider_route: 'pass' | 'missing' | 'incompatible' = 'missing'
  let model_catalog: 'pass' | 'missing' | 'incompatible' = 'missing'
  let credential_reference: 'pass' | 'missing' | 'incompatible' = 'missing'
  let isolated_profile: 'pass' | 'missing' | 'incompatible' = 'missing'
  let zero_retry_path: 'pass' | 'missing' | 'incompatible' = 'missing'
  let max_output_cap: 'pass' | 'missing' | 'incompatible' = 'missing'

  // 1. Scan all 4 package.json sections for direct DSH packages
  let pkgJson: Record<string, unknown>
  try {
    pkgJson = JSON.parse(options.package_json_content)
    assertObject(pkgJson)
  } catch {
    throw new ProtocolValidationError()
  }

  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
  const directDshMap = new Map<string, string>()

  for (const section of sections) {
    const deps = (pkgJson[section] || {}) as Record<string, unknown>
    if (typeof deps === 'object' && deps !== null && !Array.isArray(deps)) {
      for (const [name, ver] of Object.entries(deps)) {
        if (name.startsWith('@deepseek-ai/dsh-')) {
          if (typeof ver !== 'string') {
            provider_plugin = 'incompatible'
            reasons.push('direct_dsh_dependency_version_mismatch')
            continue
          }
          // Must be exact 0.1.0-rc.8 without range/workspace prefix
          if (ver !== TARGET_VERSION) {
            provider_plugin = 'incompatible'
            reasons.push('direct_dsh_dependency_version_mismatch')
          }
          if (directDshMap.has(name) && directDshMap.get(name) !== ver) {
            provider_plugin = 'incompatible'
            reasons.push('direct_dsh_dependency_version_mismatch')
          }
          directDshMap.set(name, ver)
        }
      }
    }
  }

  // Check provider package existence
  if (!directDshMap.has(EXPECTED_PACKAGE) || directDshMap.get(EXPECTED_PACKAGE) !== TARGET_VERSION) {
    provider_plugin = 'missing'
    reasons.push('provider_package_missing')
  }

  // Scan lockfile for all package snapshots
  const lockMatches = [...options.lockfile_content.matchAll(/@deepseek-ai\/dsh-([a-z-]+)@([0-9a-z.-]+)/g)]
  const lockVersions = new Map<string, Set<string>>()
  for (const match of lockMatches) {
    const pkgName = `@deepseek-ai/dsh-${match[1]}`
    const ver = match[2]
    if (!lockVersions.has(pkgName)) {
      lockVersions.set(pkgName, new Set())
    }
    lockVersions.get(pkgName)!.add(ver)
  }

  // Check lockfile consistency for all direct DSH dependencies
  for (const [name, declaredVer] of directDshMap) {
    const lockSet = lockVersions.get(name)
    if (!lockSet || lockSet.size !== 1 || !lockSet.has(TARGET_VERSION) || declaredVer !== TARGET_VERSION) {
      provider_plugin = 'missing'
      reasons.push('provider_package_missing')
    }
  }

  if (reasons.length === 0 && directDshMap.has(EXPECTED_PACKAGE)) {
    provider_plugin = 'pass'
  }

  // 2. Check official root exports
  if (
    typeof dshDeepSeek.Config !== 'function' ||
    typeof dshDeepSeek.DeepSeekAdapter !== 'function' ||
    typeof dshDeepSeek.apply !== 'function' ||
    typeof dshDeepSeek.resolveAdapterOptions !== 'function'
  ) {
    provider_plugin = 'incompatible'
    reasons.push('root_exports_incomplete')
  }

  // 3. Isolated profile registration metadata smoke
  if (
    dshDeepSeek.name === 'llm-deepseek' &&
    Array.isArray(dshDeepSeek.inject) &&
    dshDeepSeek.inject.includes('llm')
  ) {
    isolated_profile = 'pass'
  } else {
    isolated_profile = 'incompatible'
    reasons.push('isolated_profile_unsupported')
  }

  // 4. Verify default adapter options, route, and model catalog smoke
  try {
    const defaultOpts = dshDeepSeek.resolveAdapterOptions({})
    if (!defaultOpts || !Array.isArray(defaultOpts.models)) {
      provider_route = 'incompatible'
      reasons.push('adapter_options_invalid')
    } else {
      // Test providerInfo route
      const adapterProto = dshDeepSeek.DeepSeekAdapter.prototype
      const pInfo = adapterProto.providerInfo(EXPECTED_ROUTE)
      if (!pInfo || pInfo.id !== EXPECTED_ROUTE || pInfo.name !== 'DeepSeek') {
        provider_route = 'incompatible'
        reasons.push('provider_route_incompatible')
      } else {
        provider_route = 'pass'
      }

      const hasFlashModel = defaultOpts.models.some((m: { id?: string }) => m.id === EXPECTED_MODEL)
      if (hasFlashModel) {
        model_catalog = 'pass'
      } else {
        model_catalog = 'incompatible'
        reasons.push('model_catalog_missing_expected_model')
      }

      if (defaultOpts.apiKeyEnv === 'DEEPSEEK_API_KEY') {
        credential_reference = 'pass'
      } else {
        credential_reference = 'incompatible'
        reasons.push('credential_reference_invalid')
      }
    }
  } catch {
    provider_route = 'incompatible'
    reasons.push('adapter_options_resolution_failed')
  }

  // 5. Verify zero retry path and maxTokens override smoke
  try {
    const customOpts = dshDeepSeek.resolveAdapterOptions({
      maxTokens: 4096,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    })
    if (customOpts.maxTokens === 4096) {
      max_output_cap = 'pass'
    } else {
      max_output_cap = 'incompatible'
      reasons.push('max_tokens_override_failed')
    }

    if (customOpts.retryPolicy?.mode === 'normal' && customOpts.retryPolicy.maxRetries === 0) {
      zero_retry_path = 'pass'
    } else {
      zero_retry_path = 'incompatible'
      reasons.push('zero_retry_override_failed')
    }
  } catch {
    zero_retry_path = 'incompatible'
    max_output_cap = 'incompatible'
    reasons.push('custom_options_resolution_failed')
  }

  // Sort and deduplicate reasons stably
  const uniqueReasons = [...new Set(reasons)].sort(compareCodePoints)

  const public_contracts: PublicContractsAudit = {
    provider_plugin,
    provider_route,
    model_catalog,
    credential_reference,
    isolated_profile,
    zero_retry_path,
    max_output_cap,
  }

  const allPass = PUBLIC_CONTRACT_KEYS.every((k) => public_contracts[k] === 'pass')
  const decision = allPass && uniqueReasons.length === 0 ? ('compatible' as const) : ('blocked' as const)

  const body = {
    schema_version: 1 as const,
    audited_at: options.audited_at,
    project_dsh_version: TARGET_VERSION,
    project_lock_sha256: sha256(options.lockfile_content),
    official_reference: {
      repository: EXPECTED_REPO,
      package: EXPECTED_PACKAGE,
      package_version: TARGET_VERSION,
      source_ref: EXPECTED_SOURCE_REF,
    },
    public_contracts,
    decision,
    reasons: uniqueReasons,
  }

  const audit: ProviderCompatibilityAudit = {
    ...body,
    audit_sha256: canonicalHash(body),
  }

  return validateProviderCompatibilityAudit(audit)
}
