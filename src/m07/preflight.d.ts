import type { CanaryBudget } from './canary-schema.js'

export interface PreflightOptions {
  tarballPath: string
  isDryRun: boolean
}

export interface PreflightResult {
  status: 'awaiting_user_approval'
  package_name: 'dsh-mnemosyne'
  package_version: '0.0.0-dev' | '0.1.0'
  dsh_version: '0.1.1-rc.2'
  package_sha256: string
  plan_id: string
  plan_sha256: string
  budget: CanaryBudget
  model_calls_executed: 0
  mode: 'dry_run'
}

export function executeCanaryPreflight(options: PreflightOptions): Promise<PreflightResult>
