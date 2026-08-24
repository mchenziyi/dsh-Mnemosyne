import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const artifactDir = new URL('../', import.meta.url)
const names = await readdir(artifactDir)
const tarball = names.find((name) => name.endsWith('.tgz'))
if (!tarball) throw new Error('pack:check: no tarball found')
const tarballPath = join(artifactDir.pathname, tarball)
const { stdout } = await execFileAsync('tar', ['-tzf', tarballPath])
const entries = stdout.trim().split('\n').filter(Boolean)
const allowed = /^(package\/(dist\/|cordis\.patch\.yml$|README\.md$|package\.json$))/
const forbidden = entries.filter((entry) => !allowed.test(entry))
if (forbidden.length) throw new Error(`pack:check: unexpected files: ${forbidden.join(', ')}`)

const { stdout: bundledJs } = await execFileAsync('tar', ['-xOzf', tarballPath, 'package/dist/index.mjs'])
const { stdout: bundledDts } = await execFileAsync('tar', ['-xOzf', tarballPath, 'package/dist/index.d.mts'])

const forbiddenSymbols = [
  'PersistenceInternalTestHooks',
  '__setPersistenceTestHooksForTest',
  'simulateFileFsyncFailure',
  'simulateDirFsyncFailure',
  'simulateReadbackMismatch',
  'mnemosyne_eval_recall_context',
  'createRecallContextTool',
  'runOfflineM05D',
  'FakeProvider',
  'validateOfflineReceipts',
  'offline_fake_provider',
  'createCanaryPlan',
  'runCanaryPreflight',
  'BudgetLedger',
  'prepareIsolationRoot',
  'adversarial_preflight',
  'createRC8BaselineAudit',
  'validateRC8BaselineAudit',
  'resolveDirectDshPackages',
  'rc8_baseline_ready_for_sol_review',
  'createProviderCompatibilityAudit',
  'validateProviderCompatibilityAudit',
  'runIsolatedProfileDryRun',
  'runCountingFakeZeroRetryProof',
  'createRealCanaryPlan',
  'validateRealCanaryPlan',
  'createRealCanaryAuthorizationRequest',
  'validateRealCanaryAuthorizationRequest',
  'real_canary_ready_for_user_approval',
  'runM05F1PlanningGate',
  'parseRfc3339Utc',
  'computeAuthorizationId',
  'createRealCanaryApprovalReceipt',
  'validateRealCanaryApprovalReceipt',
  'runRealCanaryD2',
  'validateRealCanaryReceipt',
  'validateRealCanarySummary',
  'real_provider_canary',
  'real_provider_plumbing_pass',
  'persistExecutionClaim',
  'persistReceipt',
  'persistSummary',
  'verifyPersistenceRoot',
  'createRealProviderBridge',
  'runRealCanaryPreflight',
  'validateAcquisitionCandidate',
  'validateExecutionWorld',
  'LocalCredentialProvider',
  'createRealCanaryApprovalCli',
  'executeRealCanaryCli',
  'ApprovalCliError',
  'ExecutionCliError',
  'ApprovalInternalTestHooks',
  '__setApprovalTestHooksForTest',
]

for (const symbol of forbiddenSymbols) {
  if (bundledJs.includes(symbol)) {
    throw new Error(`pack:check: forbidden symbol "${symbol}" leaked into production bundle JS (package/dist/index.mjs)`)
  }
  if (bundledDts.includes(symbol)) {
    throw new Error(`pack:check: forbidden symbol "${symbol}" leaked into production DTS (package/dist/index.d.mts)`)
  }
}

console.log(`pack:check: PASS (${entries.length} files, dual JS/DTS scan clean)`)
