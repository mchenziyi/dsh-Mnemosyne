export const AUDIT_COMMIT = '82a5fd61a7cf5c293cec4bdff68f455398d685e9'
export const DSH_VERSION = '0.1.3-alpha.2'
export const CORDIS_VERSION = '4.0.2'
export const SCHEMASTERY_VERSION = '3.18.2'

export interface CompatibilityReport {
  readonly audit_commit: typeof AUDIT_COMMIT
  readonly dsh_version: typeof DSH_VERSION
  readonly cordis_version: typeof CORDIS_VERSION
  readonly schemastery_version: typeof SCHEMASTERY_VERSION
}

export const COMPATIBILITY: CompatibilityReport = Object.freeze({
  audit_commit: AUDIT_COMMIT,
  dsh_version: DSH_VERSION,
  cordis_version: CORDIS_VERSION,
  schemastery_version: SCHEMASTERY_VERSION,
})
