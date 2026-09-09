import type { CanaryBudget } from './canary-schema.js'

export interface PreflightOptions {
  tarballPath: string
  isDryRun: boolean
}

export interface PreflightResult {
  status: 'awaiting_user_approval'
  package_name: '@cziyi/dsh-mnemosyne'
  package_version: '0.0.0-dev' | '0.1.0' | '0.2.0' | '0.2.1' | '0.2.2' | '0.2.3' | '0.2.4' | '0.2.5' | '0.2.6' | '0.2.7' | '0.2.8' | '0.2.9' | '0.2.10' | '0.2.11' | '0.2.12' | '0.2.13' | '0.2.14' | '0.2.15' | '0.2.16' | '0.2.17' | '0.2.18' | '0.2.19' | '0.2.20'
  dsh_version: '0.1.1-rc.2'
  package_sha256: string
  plan_id: string
  plan_sha256: string
  budget: CanaryBudget
  model_calls_executed: 0
  mode: 'dry_run'
}

export function executeCanaryPreflight(options: PreflightOptions): Promise<PreflightResult>
