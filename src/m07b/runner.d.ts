import type { RealCanaryPlan, RedactedCanaryReport } from './canary-protocol.js'

export declare function executeDryRun(params: {
  tarballPath: string
}): Promise<{
  status: 'awaiting_user_approval'
  plan_id: string
  plan_sha256: string
  package_sha256: string
  budgets: RealCanaryPlan['budgets']
  runs: RealCanaryPlan['runs']
  mode: 'dry_run'
}>

export declare function executePrepare(params: {
  tarballPath: string
  tempParent: string
  dshExecutable?: string
  extraPatches?: Array<{ name: string; content?: string; path?: string; modulePath?: string; module_realpath?: string } | string>
}): Promise<{
  status: 'prepared'
  plan_id: string
  plan_sha256: string
  package_sha256: string
  run_root: string
  credential_target: string
  evidence_dir: string
}>

export declare function executeCanary(params: {
  runRoot: string
  approvalSha256: string
  reportOutPath?: string
  dshExecutable?: string
  extraTestPatches?: string[]
}): Promise<RedactedCanaryReport>
