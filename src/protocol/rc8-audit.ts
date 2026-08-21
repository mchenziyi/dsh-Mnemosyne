import {
  assertExactKeys,
  assertHash,
  assertObject,
  canonicalHash,
  compareCodePoints,
  ProtocolValidationError,
  sha256,
  withoutHash,
} from './canonical.js'

export interface DirectDshPackageAudit {
  name: string
  declared_version: string
  resolved_version: string
}

export interface PublicSeamsAudit {
  cordis_plugin: 'pass' | 'blocked'
  agent_loop: 'pass' | 'blocked'
  llm_adapter: 'pass' | 'blocked'
  session: 'pass' | 'blocked'
  tools: 'pass' | 'blocked'
  additional_contexts: 'pass' | 'blocked'
}

export interface CompatibilityAudit {
  canonical_goldens_unchanged: boolean
  fixture_hashes_unchanged: boolean
  receipt_contracts_unchanged: boolean
  production_exports_unchanged: boolean
  tarball_boundary_unchanged: boolean
}

export interface RC8BaselineAudit {
  schema_version: 1
  status: 'rc8_baseline_ready_for_sol_review' | 'blocked'
  source_version: '0.1.0-rc.6'
  target_version: '0.1.0-rc.8'
  npm_next_version: string
  package_json_sha256: string
  lockfile_sha256: string
  direct_dsh_packages: DirectDshPackageAudit[]
  public_seams: PublicSeamsAudit
  compatibility: CompatibilityAudit
  audit_sha256: string
}

const SEAM_KEYS = [
  'cordis_plugin',
  'agent_loop',
  'llm_adapter',
  'session',
  'tools',
  'additional_contexts',
] as const

const COMPAT_KEYS = [
  'canonical_goldens_unchanged',
  'fixture_hashes_unchanged',
  'receipt_contracts_unchanged',
  'production_exports_unchanged',
  'tarball_boundary_unchanged',
] as const

const MAX_DIRECT_PACKAGES = 64
const MAX_STRING_LEN = 128
const MAX_VERSION_LEN = 64

export function resolveDirectDshPackages(
  packageJsonContent: string,
  lockfileContent: string
): DirectDshPackageAudit[] {
  let pkgJson: Record<string, unknown>
  try {
    pkgJson = JSON.parse(packageJsonContent)
  } catch {
    throw new ProtocolValidationError()
  }

  assertObject(pkgJson)
  const peerDeps = (pkgJson.peerDependencies || {}) as Record<string, unknown>
  const devDeps = (pkgJson.devDependencies || {}) as Record<string, unknown>
  assertObject(peerDeps)
  assertObject(devDeps)

  const directMap = new Map<string, string>()

  for (const [name, ver] of Object.entries(peerDeps)) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      if (typeof ver !== 'string' || ver.length === 0 || ver.length > MAX_VERSION_LEN) {
        throw new ProtocolValidationError()
      }
      directMap.set(name, ver)
    }
  }

  for (const [name, ver] of Object.entries(devDeps)) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      if (typeof ver !== 'string' || ver.length === 0 || ver.length > MAX_VERSION_LEN) {
        throw new ProtocolValidationError()
      }
      if (directMap.has(name) && directMap.get(name) !== ver) {
        throw new ProtocolValidationError()
      }
      directMap.set(name, ver)
    }
  }

  if (directMap.size === 0 || directMap.size > MAX_DIRECT_PACKAGES) {
    throw new ProtocolValidationError()
  }

  // Scan lockfile for all package snapshots
  const lockMatches = [...lockfileContent.matchAll(/@deepseek-ai\/dsh-([a-z-]+)@([0-9a-z.-]+)/g)]
  const lockVersions = new Map<string, Set<string>>()
  for (const match of lockMatches) {
    const pkgName = `@deepseek-ai/dsh-${match[1]}`
    const ver = match[2]
    if (!lockVersions.has(pkgName)) {
      lockVersions.set(pkgName, new Set())
    }
    lockVersions.get(pkgName)!.add(ver)
  }

  const result: DirectDshPackageAudit[] = []

  for (const [name, declared_version] of directMap) {
    const resolvedSet = lockVersions.get(name)
    if (!resolvedSet || resolvedSet.size !== 1) {
      // Missing from lockfile or has conflicting multiple versions
      throw new ProtocolValidationError()
    }
    const resolved_version = [...resolvedSet][0]
    if (!resolved_version || resolved_version.length > MAX_VERSION_LEN) {
      throw new ProtocolValidationError()
    }
    result.push({
      name,
      declared_version,
      resolved_version,
    })
  }

  result.sort((a, b) => compareCodePoints(a.name, b.name))
  return result
}

export function validateRC8BaselineAudit(value: unknown): RC8BaselineAudit {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'status',
    'source_version',
    'target_version',
    'npm_next_version',
    'package_json_sha256',
    'lockfile_sha256',
    'direct_dsh_packages',
    'public_seams',
    'compatibility',
    'audit_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  if (value.source_version !== '0.1.0-rc.6') throw new ProtocolValidationError()
  if (value.target_version !== '0.1.0-rc.8') throw new ProtocolValidationError()
  if (
    typeof value.npm_next_version !== 'string' ||
    value.npm_next_version.length === 0 ||
    value.npm_next_version.length > MAX_VERSION_LEN
  ) {
    throw new ProtocolValidationError()
  }
  assertHash(value.package_json_sha256)
  assertHash(value.lockfile_sha256)
  assertHash(value.audit_sha256)

  if (!Array.isArray(value.direct_dsh_packages)) throw new ProtocolValidationError()
  const packages = value.direct_dsh_packages as DirectDshPackageAudit[]
  if (packages.length === 0 || packages.length > MAX_DIRECT_PACKAGES) {
    throw new ProtocolValidationError()
  }

  let prevName = ''
  for (const pkg of packages) {
    assertObject(pkg)
    assertExactKeys(pkg, ['name', 'declared_version', 'resolved_version'])
    if (
      typeof pkg.name !== 'string' ||
      !pkg.name.startsWith('@deepseek-ai/dsh-') ||
      pkg.name.length > MAX_STRING_LEN
    ) {
      throw new ProtocolValidationError()
    }
    if (
      typeof pkg.declared_version !== 'string' ||
      pkg.declared_version.length === 0 ||
      pkg.declared_version.length > MAX_VERSION_LEN
    ) {
      throw new ProtocolValidationError()
    }
    if (
      typeof pkg.resolved_version !== 'string' ||
      pkg.resolved_version.length === 0 ||
      pkg.resolved_version.length > MAX_VERSION_LEN
    ) {
      throw new ProtocolValidationError()
    }
    if (prevName && compareCodePoints(prevName, pkg.name) >= 0) {
      // Must be strictly sorted
      throw new ProtocolValidationError()
    }
    prevName = pkg.name
  }

  assertObject(value.public_seams)
  assertExactKeys(value.public_seams, SEAM_KEYS)
  const seams = value.public_seams as Record<string, unknown>
  for (const key of SEAM_KEYS) {
    if (seams[key] !== 'pass' && seams[key] !== 'blocked') throw new ProtocolValidationError()
  }

  assertObject(value.compatibility)
  assertExactKeys(value.compatibility, COMPAT_KEYS)
  const compat = value.compatibility as Record<string, unknown>
  for (const key of COMPAT_KEYS) {
    if (typeof compat[key] !== 'boolean') throw new ProtocolValidationError()
  }

  const allSeamsPassed = SEAM_KEYS.every((k) => seams[k] === 'pass')
  const allCompatPassed = COMPAT_KEYS.every((k) => compat[k] === true)
  const allPkgsMatch =
    packages.length > 0 &&
    packages.every(
      (p) =>
        p.declared_version === value.target_version &&
        p.resolved_version === value.target_version
    )
  const npmNextMatch = value.npm_next_version === value.target_version

  const canBeReady = allSeamsPassed && allCompatPassed && allPkgsMatch && npmNextMatch
  const expectedStatus = canBeReady ? 'rc8_baseline_ready_for_sol_review' : 'blocked'

  if (value.status !== expectedStatus) {
    throw new ProtocolValidationError()
  }

  const expectedHash = canonicalHash(withoutHash(value, 'audit_sha256'))
  if (value.audit_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return value as unknown as RC8BaselineAudit
}

export function createRC8BaselineAudit(options: {
  npm_next_version: string
  package_json_content: string
  lockfile_content: string
  public_seams: PublicSeamsAudit
  compatibility: CompatibilityAudit
}): RC8BaselineAudit {
  const source_version = '0.1.0-rc.6' as const
  const target_version = '0.1.0-rc.8' as const

  const direct_dsh_packages = resolveDirectDshPackages(
    options.package_json_content,
    options.lockfile_content
  )

  const sortedPkgs = [...direct_dsh_packages].sort((a, b) =>
    compareCodePoints(a.name, b.name)
  )

  assertObject(options.public_seams)
  assertExactKeys(options.public_seams, SEAM_KEYS)
  assertObject(options.compatibility)
  assertExactKeys(options.compatibility, COMPAT_KEYS)

  const allSeamsPass = SEAM_KEYS.every((k) => options.public_seams[k] === 'pass')
  const allCompatPass = COMPAT_KEYS.every((k) => options.compatibility[k] === true)
  const allPkgsMatch =
    sortedPkgs.length > 0 &&
    sortedPkgs.every(
      (p) =>
        p.declared_version === target_version &&
        p.resolved_version === target_version
    )
  const npmNextMatch = options.npm_next_version === target_version

  const status =
    allSeamsPass && allCompatPass && allPkgsMatch && npmNextMatch
      ? ('rc8_baseline_ready_for_sol_review' as const)
      : ('blocked' as const)

  const body = {
    schema_version: 1 as const,
    status,
    source_version,
    target_version,
    npm_next_version: options.npm_next_version,
    package_json_sha256: sha256(options.package_json_content),
    lockfile_sha256: sha256(options.lockfile_content),
    direct_dsh_packages: sortedPkgs,
    public_seams: options.public_seams,
    compatibility: options.compatibility,
  }

  const audit: RC8BaselineAudit = {
    ...body,
    audit_sha256: canonicalHash(body),
  }

  return validateRC8BaselineAudit(audit)
}
