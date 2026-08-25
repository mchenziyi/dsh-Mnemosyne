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

export const forbiddenExportSymbols = [
  'createScopeRuntime',
  'validateAndNormalizeProjectRoot',
  'computeProjectScopeId',
  'computeSessionScopeId',
  'ResolvedScope',
  'ScopeRuntimeSnapshot',
  'openMemoryFactStore',
  'MemoryFactStore',
  'putShortTerm',
  'putLongTerm',
  'getShortTerm',
  'getLongTerm',
  'listShortTerm',
  'listLongTerm',
  'listShortTermSessionScopes',
  'ShortTermMemoryFact',
  'LongTermMemoryFact',
  'MemoryStoreError',
  'createOKFCompiler',
  'OKFCompiler',
  'OKFInputManifest',
  'OKFIndex',
  'OKFGenerationMetadata',
  'OKFCurrentPointer',
  'CompileOKFRequest',
  'CompileOKFResult',
  'readCurrent',
  'verifyGeneration',
  'createProductionRetrievalRuntime',
  'readVerifiedCurrentWorld',
  'readVerifiedGenerationWorld',
  'executeOKFSearch',
  'validateSearchInput',
  'validateOpenInput',
  'validateSearchDisclosure',
  'validateOpenDisclosure',
  'canonicalizeSearchDisclosure',
  'canonicalizeOpenDisclosure',
  'OKFSearchDisclosure',
  'OKFOpenDisclosure',
  'OKFGenerationRef',
  'buildExpectedIndex',
  'BuildExpectedIndexParams',
  'VerifiedCompilerLock',
  'readVerifiedCompilerLock',
  'createAcquisitionRuntime',
  'AcquisitionRuntime',
  'createRememberTool',
  'extractAcquisitionEvidence',
  'validateAcquisitionEvidence',
  'validateMemoryCandidate',
  'createAcquisitionEvidence',
  'computeEventKey',
  'computeManualEventKey',
  'computeAutoMemoryId',
  'computeManualMemoryId',
  'computeCandidateFingerprint',
  'computeCandidateSha256',
  'ACQUISITION_SYSTEM_PROMPT',
  'ACQUISITION_SYSTEM_PROMPT_SHA256',
  'buildAcquisitionUserPrompt',
]

export const forbiddenSeamSymbols = [
  'createFixtureRuntime',
  'FIXTURE_CATALOG',
  'memory-catalog.json',
  'operation_hint',
  'candidate_universe_sha256',
  'retrieval_ref',
  'aliases',
  'synthetic evaluation memories',
  'RetrievalTestHooks',
  '__setRetrievalTestHooks',
  'OKFCompilerTestHooks',
  '__setOKFCompilerTestHooks',
  'InternalStoreHooks',
  '__setInternalStoreHooks',
  'simulateManifestPublicationFailure',
  'simulateBeforeCurrentRenameFailure',
  'simulatePostCurrentRenameFsyncFailure',
  'simulateStagingWriteFailure',
  'simulateStagingSyncFailure',
  'simulateStagingCloseFailure',
  'simulateManifestTempWriteFailure',
  'simulateManifestTempSyncFailure',
  'simulateManifestTempCloseFailure',
  'simulateCurrentTempWriteFailure',
  'simulateCurrentTempSyncFailure',
  'simulateCurrentTempCloseFailure',
  'simulateLockWriteFailure',
  'simulateLockSyncFailure',
  'simulateLockCloseFailure',
  'simulateLockGrowthBeforeRead',
  'MemoryStoreTestHooks',
  '__setMemoryStoreTestHooks',
  'simulateTempFileFsyncFailure',
  'simulateTargetParentFsyncFailure',
  'simulateLinkFailure',
  'simulateReadbackFailure',
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
  'createDshBaselineAudit',
  'validateDshBaselineAudit',
  'dsh_baseline_ready_for_cto_review',
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
  'SanitizedFailureDiagnostic',
  'createSanitizedFailureDiagnostic',
  'validateSanitizedFailureDiagnostic',
  'classifyFailure',
  'ModelOutputValidationError',
  'createSafeStreamFinishError',
  'resolveClaimKind',
  'failure_diagnostics',
  'failure_categories',
  'authentication_rejected',
  'rate_limited',
  'provider_timeout',
  'network_failure',
  'provider_protocol_error',
  'request_rejected',
  'provider_server_error',
  'model_output_schema_error',
  'runner_protocol_error',
  'unknown_provider_error',
]

export const forbiddenSymbols = [...forbiddenExportSymbols, ...forbiddenSeamSymbols]

for (const symbol of forbiddenSeamSymbols) {
  if (bundledJs.includes(symbol)) {
    throw new Error(`pack:check: forbidden symbol "${symbol}" leaked into production bundle JS (package/dist/index.mjs)`)
  }
  if (bundledDts.includes(symbol)) {
    throw new Error(`pack:check: forbidden symbol "${symbol}" leaked into production DTS (package/dist/index.d.mts)`)
  }
}

const forbiddenPatterns = [
  /checkHook/i,
  /simulate[A-Z]/,
  /__set.*Hooks/,
  /simulated\s+.*\s+failure/i,
]

for (const pattern of forbiddenPatterns) {
  if (pattern.test(bundledJs)) {
    throw new Error(`pack:check: forbidden pattern ${pattern} matched in production bundle JS (package/dist/index.mjs)`)
  }
  if (pattern.test(bundledDts)) {
    throw new Error(`pack:check: forbidden pattern ${pattern} matched in production DTS (package/dist/index.d.mts)`)
  }
}

const jsExportMatch = bundledJs.match(/export\s*\{([^}]+)\}/)
const jsExports = jsExportMatch ? jsExportMatch[1].split(',').map((s) => s.trim()) : []
const dtsExportMatch = bundledDts.match(/export\s*\{([^}]+)\}/)
const dtsExports = dtsExportMatch ? dtsExportMatch[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]) : []

for (const symbol of forbiddenExportSymbols) {
  if (bundledDts.includes(symbol)) {
    throw new Error(`pack:check: forbidden internal symbol "${symbol}" leaked into production DTS (package/dist/index.d.mts)`)
  }
  if (jsExports.includes(symbol)) {
    throw new Error(`pack:check: forbidden internal symbol "${symbol}" leaked into JS exports (package/dist/index.mjs)`)
  }
  if (dtsExports.includes(symbol)) {
    throw new Error(`pack:check: forbidden internal symbol "${symbol}" leaked into DTS exports (package/dist/index.d.mts)`)
  }
}

console.log(`pack:check: PASS (${entries.length} files, dual JS/DTS and export scan clean)`)
