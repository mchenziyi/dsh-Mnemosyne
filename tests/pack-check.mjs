import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const artifactDir = new URL('../', import.meta.url)
const names = await readdir(artifactDir)
const tarball = names.find((name) => name.endsWith('.tgz'))
if (!tarball) throw new Error('pack:check: no tarball found')
const { stdout } = await execFileAsync('tar', ['-tzf', join(artifactDir.pathname, tarball)])
const entries = stdout.trim().split('\n').filter(Boolean)
const allowed = /^(package\/(dist\/|cordis\.patch\.yml$|README\.md$|package\.json$))/
const forbidden = entries.filter((entry) => !allowed.test(entry))
if (forbidden.length) throw new Error(`pack:check: unexpected files: ${forbidden.join(', ')}`)
const { stdout: bundled } = await execFileAsync('tar', ['-xOzf', join(artifactDir.pathname, tarball), 'package/dist/index.mjs'])
if (bundled.includes('mnemosyne_eval_recall_context') || bundled.includes('createRecallContextTool')) throw new Error('pack:check: evaluation-only recall tool leaked into production bundle')
if (['runOfflineM05D', 'FakeProvider', 'validateOfflineReceipts', 'offline_fake_provider', 'createCanaryPlan', 'runCanaryPreflight', 'BudgetLedger', 'prepareIsolationRoot', 'adversarial_preflight', 'createRC8BaselineAudit', 'validateRC8BaselineAudit', 'resolveDirectDshPackages', 'rc8_baseline_ready_for_sol_review', 'createProviderCompatibilityAudit', 'validateProviderCompatibilityAudit', 'runIsolatedProfileDryRun', 'runCountingFakeZeroRetryProof', 'createRealCanaryPlan', 'validateRealCanaryPlan', 'createRealCanaryAuthorizationRequest', 'validateRealCanaryAuthorizationRequest', 'real_canary_ready_for_user_approval', 'runM05F1PlanningGate', 'parseRfc3339Utc', 'computeAuthorizationId'].some((symbol) => bundled.includes(symbol))) throw new Error('pack:check: evaluation-only M0.5D/M0.5E/M0.5F symbols leaked into production bundle')
console.log(`pack:check: PASS (${entries.length} files)`)
