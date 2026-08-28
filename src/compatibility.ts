export const AUDIT_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
export const DSH_VERSION = '0.1.1-rc.2'
export const CORDIS_VERSION = '4.0.1'
export const SCHEMASTERY_VERSION = '3.18.1'

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
