import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyCanaryArtifact } from '../m07/artifact.js'
import {
  createRealCanaryPlan,
  validateRealCanaryPlan,
  validateApprovalReceipt,
  createRedactedCanaryReport,
  createRedactedCanaryReportV2,
  createExecutionManifest,
  validateExecutionManifest,
  computeExecutionManifestSha256,
  computeSha256,
  computeProjectScopeId,
  FROZEN_CANARY_TASKS,
  VALID_REASON_CODES,
  REQUIRED_RUNTIME_MODULE_ROLES,
} from './canary-protocol.js'
import {
  setupRunRootLayout,
  verifyCredentialMetadataOnly,
  cleanupRunRoot,
  isInsideOrSameDirectory,
  createSanitizedEnv,
  spawnProcessGroup,
  resolveExecutableRealpath,
} from './isolation.js'
import { verifyApprovalBinding, claimApproval } from './authorization.js'
import { summarizeLlmBudget, readValidLlmClaims, MAX_MODEL_REQUESTS } from './budget-ledger.js'
import { writeRedactedCanaryReport } from './report.js'
import { readSidecarLoadedReceipt, readResumeCompletedReceipt } from './wiring-receipt.js'
import { readSessionEvidence } from './session-evidence.js'
import { readStrictSessionEvidence } from './business-evidence.js'
import {
  predicateRun1_AutomaticCapture,
  predicateRun2_RestartPersistence,
  predicateRun3_Promotion,
  predicateRun4_CrossSessionReading,
  predicateRun5_ForgetAndGrantInvalidation,
  predicateRun6_ScopeIsolation,
} from './predicates.js'
import {
  captureRunStateSnapshot,
  createCanaryIdentityLedger,
  advanceCanaryIdentityLedger,
} from './state-evidence.js'

const execFileAsync = promisify(execFile)

export async function executeDryRun(params) {
  const { tarballPath, dshExecutable = 'dsh' } = params
  const artifact = await verifyCanaryArtifact(tarballPath)

  let realDsh = dshExecutable
  try {
    realDsh = await resolveExecutableRealpath(dshExecutable)
  } catch {}

  const realTarball = await realpath(tarballPath)

  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
  const nonce = 'dry_run_nonce_' + Math.random().toString(36).slice(2)
  const runRootIdentity = computeSha256(nonce)

  const runs = [
    { id: 'run_1', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_1, patch_hashes: ['sha256_' + '0'.repeat(64)] },
    { id: 'run_2', is_resume: true, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_2, patch_hashes: ['sha256_' + '0'.repeat(64), 'sha256_' + '1'.repeat(64)] },
    { id: 'run_3', is_resume: true, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_3, patch_hashes: ['sha256_' + '0'.repeat(64), 'sha256_' + '1'.repeat(64)] },
    { id: 'run_4', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_4, patch_hashes: ['sha256_' + '0'.repeat(64)] },
    { id: 'run_5', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_5, patch_hashes: ['sha256_' + '0'.repeat(64)] },
    { id: 'run_6', is_resume: false, cwd_rel: 'project-b', task: FROZEN_CANARY_TASKS.run_6, patch_hashes: ['sha256_' + '0'.repeat(64)] },
  ]

  const mockRuntimeModules = REQUIRED_RUNTIME_MODULE_ROLES.map((role) => ({
    role,
    realpath: `/app/${role.replace(/_/g, '-')}.js`,
    content_sha256: 'sha256_' + '0'.repeat(64),
  }))

  const manifest = createExecutionManifest({
    dsh_executable_realpath: realDsh,
    tarball_realpath: realTarball,
    tarball_sha256: artifact.packageSha256,
    profile_dependency_value: 'file:' + realTarball,
    sidecar_patch_sha256: 'sha256_' + '0'.repeat(64),
    resume_patch_sha256: 'sha256_' + '1'.repeat(64),
    run_root_identity: runRootIdentity,
    runtime_module_files: mockRuntimeModules,
    runs,
    extra_patches: [],
  })

  const manifestHash = computeExecutionManifestSha256(manifest)

  const plan = createRealCanaryPlan({
    package_version: artifact.packageVersion,
    package_sha256: artifact.packageSha256,
    run_root_identity: runRootIdentity,
    execution_manifest_sha256: manifestHash,
    created_at: createdAt,
    expires_at: expiresAt,
    nonce,
  })

  return {
    status: 'awaiting_user_approval',
    plan_id: plan.plan_id,
    plan_sha256: plan.plan_sha256,
    package_sha256: plan.package_sha256,
    budgets: plan.budgets,
    runs: plan.runs,
    mode: 'dry_run',
  }
}

export async function executePrepare(params) {
  const { tarballPath, tempParent, dshExecutable = 'dsh', extraPatches = [] } = params
  const artifact = await verifyCanaryArtifact(tarballPath)
  const layout = await setupRunRootLayout(tempParent)

  const realTarball = await realpath(tarballPath)
  const realDsh = await resolveExecutableRealpath(dshExecutable)

  // Verify DSH version before prepare
  let dshVersionOut = ''
  try {
    const { stdout } = await execFileAsync(realDsh, ['--version'], {
      env: createSanitizedEnv(),
    })
    dshVersionOut = stdout.trim()
  } catch {
    throw new Error('dsh_version_check_failed')
  }

  if (dshVersionOut !== '0.1.1-rc.2') {
    throw new Error('dsh_version_mismatch')
  }

  // 1. Install tarball into isolated DSH_HOME profile
  await execFileAsync(realDsh, ['plugin', '--profile', 'headless', 'add', realTarball], {
    env: createSanitizedEnv({ DSH_HOME: layout.dshHomePath }),
  })

  // 2. Verify Profile package.json exact binding
  const profilePkgJsonPath = join(layout.dshHomePath, 'profiles', 'headless', 'package.json')
  const profilePkgRaw = JSON.parse(await readFile(profilePkgJsonPath, 'utf8'))
  const depVal = profilePkgRaw?.dependencies?.['dsh-mnemosyne']
  if (!depVal || typeof depVal !== 'string' || !depVal.startsWith('file:')) {
    throw new Error('package_binding_invalid')
  }
  const boundPath = depVal.slice('file:'.length)
  const resolvedBoundPath = await realpath(resolve(join(layout.dshHomePath, 'profiles', 'headless'), boundPath))
  if (resolvedBoundPath !== realTarball) {
    throw new Error('package_binding_path_mismatch')
  }

  // 3. Create Canary-only static patch files & resolve all runtime module files
  const patchesDir = join(layout.evidencePath, 'patches')
  await mkdir(patchesDir, { recursive: true })

  const sidecarModulePath = resolve(join(new URL('.', import.meta.url).pathname, 'audit-sidecar.js'))
  const resumeModulePath = resolve(join(new URL('.', import.meta.url).pathname, 'resume-headless-driver.js'))
  const budgetModulePath = resolve(join(new URL('.', import.meta.url).pathname, 'budget-ledger.js'))
  const sessionModulePath = resolve(join(new URL('.', import.meta.url).pathname, 'session-evidence.js'))

  const sidecarRealpath = await realpath(sidecarModulePath)
  const resumeRealpath = await realpath(resumeModulePath)
  const budgetRealpath = await realpath(budgetModulePath)
  const sessionRealpath = await realpath(sessionModulePath)

  const sidecarModuleSha256 = computeSha256(await readFile(sidecarRealpath, 'utf8'))
  const resumeModuleSha256 = computeSha256(await readFile(resumeRealpath, 'utf8'))
  const budgetModuleSha256 = computeSha256(await readFile(budgetRealpath, 'utf8'))
  const sessionModuleSha256 = computeSha256(await readFile(sessionRealpath, 'utf8'))

  const runtimeModuleFiles = [
    { role: 'audit_sidecar', realpath: sidecarRealpath, content_sha256: sidecarModuleSha256 },
    { role: 'resume_driver', realpath: resumeRealpath, content_sha256: resumeModuleSha256 },
    { role: 'budget_ledger', realpath: budgetRealpath, content_sha256: budgetModuleSha256 },
    { role: 'session_evidence', realpath: sessionRealpath, content_sha256: sessionModuleSha256 },
  ]

  const sidecarPatchContent = [
    '- insert:',
    '    - id: canary-audit-sidecar',
    `      name: '${sidecarRealpath}'`,
    '      config:',
    `        evidenceDir: '${layout.evidencePath}'`,
    `        expectedModuleSha256: '${sidecarModuleSha256}'`,
  ].join('\n') + '\n'

  const resumePatchContent = [
    '- id: headless-runner',
    '  disabled: true',
    '- insert:',
    '    - id: canary-resume-headless-driver',
    `      name: '${resumeRealpath}'`,
    '      config:',
    `        evidenceDir: '${layout.evidencePath}'`,
    `        expectedModuleSha256: '${resumeModuleSha256}'`,
  ].join('\n') + '\n'

  const sidecarPatchPath = join(patchesDir, 'sidecar-patch.yml')
  const resumePatchPath = join(patchesDir, 'resume-patch.yml')

  await writeFile(sidecarPatchPath, sidecarPatchContent, { mode: 0o600 })
  await writeFile(resumePatchPath, resumePatchContent, { mode: 0o600 })

  const sidecarPatchHash = computeSha256(sidecarPatchContent)
  const resumePatchHash = computeSha256(resumePatchContent)

  // Handle extra patches (e.g. offline test mock interceptor) if declared in prepare
  const SAFE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/
  const RELATIVE_IMPORT_REGEX = /(?:import\s+(?:[^;]+from\s+)?|import\s*\(|require\s*\(|export\s+(?:[^;]+from\s+)?)['"]\.\.?\//
  const manifestedExtraPatches = []
  const seenExtraNames = new Set()
  let extraIdx = 0

  for (const ep of extraPatches) {
    extraIdx++
    const epName = typeof ep === 'string' ? basename(ep) : ep.name || `extra-patch-${extraIdx}.yml`

    if (typeof epName !== 'string' || !SAFE_NAME_REGEX.test(epName) || epName.includes('/') || epName.includes('\\') || epName.includes('..')) {
      throw new Error('invalid_extra_patch_name')
    }
    if (seenExtraNames.has(epName)) {
      throw new Error('duplicate_extra_patch_name')
    }
    seenExtraNames.add(epName)

    const epPath = typeof ep === 'string' ? ep : ep.path
    const epContent = ep.content || (epPath ? await readFile(epPath, 'utf8') : '')
    const epHash = computeSha256(epContent)
    const targetFile = join(patchesDir, epName.endsWith('.yml') ? epName : `${epName}.yml`)
    await writeFile(targetFile, epContent, { mode: 0o600 })

    // Find and realpath module
    let epModuleRealpath = ''
    let epModuleSha256 = ''
    let candidateModPath = (typeof ep === 'object' && (ep.modulePath || ep.module_realpath)) ? (ep.modulePath || ep.module_realpath) : ''
    if (!candidateModPath) {
      const m = epContent.match(/name:\s*['"]?([^'"\s\n]+)['"]?/)
      if (m && (m[1].startsWith('/') || m[1].startsWith('.'))) {
        candidateModPath = m[1]
      }
    }
    if (candidateModPath) {
      epModuleRealpath = await realpath(candidateModPath)
      const modContent = await readFile(epModuleRealpath, 'utf8')
      if (RELATIVE_IMPORT_REGEX.test(modContent)) {
        throw new Error('extra_module_relative_import_forbidden')
      }
      epModuleSha256 = computeSha256(modContent)
    }

    manifestedExtraPatches.push({
      name: epName,
      patch_sha256: epHash,
      module_realpath: epModuleRealpath,
      module_sha256: epModuleSha256,
      path: targetFile,
    })
  }

  const extraHashes = manifestedExtraPatches.map((p) => p.patch_sha256)

  // Construct deterministic run descriptors
  const runs = [
    { id: 'run_1', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_1, patch_hashes: [sidecarPatchHash, ...extraHashes] },
    { id: 'run_2', is_resume: true, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_2, patch_hashes: [sidecarPatchHash, resumePatchHash, ...extraHashes] },
    { id: 'run_3', is_resume: true, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_3, patch_hashes: [sidecarPatchHash, resumePatchHash, ...extraHashes] },
    { id: 'run_4', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_4, patch_hashes: [sidecarPatchHash, ...extraHashes] },
    { id: 'run_5', is_resume: false, cwd_rel: 'project-a', task: FROZEN_CANARY_TASKS.run_5, patch_hashes: [sidecarPatchHash, ...extraHashes] },
    { id: 'run_6', is_resume: false, cwd_rel: 'project-b', task: FROZEN_CANARY_TASKS.run_6, patch_hashes: [sidecarPatchHash, ...extraHashes] },
  ]

  // 4. Create and write ExecutionManifest
  const executionManifest = createExecutionManifest({
    dsh_executable_realpath: realDsh,
    tarball_realpath: realTarball,
    tarball_sha256: artifact.packageSha256,
    profile_dependency_value: depVal,
    sidecar_patch_sha256: sidecarPatchHash,
    resume_patch_sha256: resumePatchHash,
    run_root_identity: layout.rootIdentity,
    runtime_module_files: runtimeModuleFiles,
    runs,
    extra_patches: manifestedExtraPatches.map((p) => ({
      name: p.name,
      patch_sha256: p.patch_sha256,
      module_realpath: p.module_realpath,
      module_sha256: p.module_sha256,
    })),
  })

  const manifestSha256 = computeExecutionManifestSha256(executionManifest)

  await writeFile(
    join(layout.evidencePath, 'canary-execution-manifest.json'),
    JSON.stringify(executionManifest, null, 2),
    { mode: 0o600 }
  )

  // 5. Save prepared receipt
  const preparedReceipt = {
    schema_version: 1,
    tarball_sha256: artifact.packageSha256,
    tarball_path: realTarball,
    dsh_version: '0.1.1-rc.2',
    run_root_identity: layout.rootIdentity,
    profile: 'headless',
    execution_manifest_sha256: manifestSha256,
    patch_hashes: {
      sidecar: sidecarPatchHash,
      resume: resumePatchHash,
    },
    prepared_at: new Date().toISOString(),
  }

  await writeFile(
    join(layout.evidencePath, 'canary-prepared-receipt.json'),
    JSON.stringify(preparedReceipt, null, 2),
    { mode: 0o600 }
  )

  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  const nonce = 'canary_nonce_' + Math.random().toString(36).slice(2)

  const plan = createRealCanaryPlan({
    package_sha256: artifact.packageSha256,
    run_root_identity: layout.rootIdentity,
    execution_manifest_sha256: manifestSha256,
    created_at: createdAt,
    expires_at: expiresAt,
    nonce,
  })

  await writeFile(
    join(layout.evidencePath, 'canary-plan.json'),
    JSON.stringify(plan, null, 2),
    { mode: 0o600 }
  )

  return {
    status: 'prepared',
    plan_id: plan.plan_id,
    plan_sha256: plan.plan_sha256,
    package_sha256: plan.package_sha256,
    execution_manifest_sha256: manifestSha256,
    run_root: layout.rootPath,
    credential_target: join(layout.dshHomePath, '.credentials.yaml'),
    evidence_dir: layout.evidencePath,
  }
}

export async function executeCanary(params) {
  const {
    runRoot,
    approvalSha256,
    reportOutPath,
    dshExecutable = 'dsh',
    extraTestPatches = [],
    evaluationLevel = params.evaluation_level || 'wiring_only',
  } = params

  if (reportOutPath) {
    if (isInsideOrSameDirectory(runRoot, reportOutPath)) {
      throw new Error('report_out_must_be_outside_run_root')
    }
  }

  const evidenceDir = join(runRoot, 'evidence')
  const planPath = join(evidenceDir, 'canary-plan.json')
  const approvalPath = join(evidenceDir, 'canary-approval.json')
  const manifestPath = join(evidenceDir, 'canary-execution-manifest.json')

  // Step 1: Read and validate Plan & Approval
  const planRaw = JSON.parse(await readFile(planPath, 'utf8'))
  const plan = validateRealCanaryPlan(planRaw)

  const approvalRaw = JSON.parse(await readFile(approvalPath, 'utf8'))
  const approval = validateApprovalReceipt(approvalRaw)

  if (approval.approval_sha256 !== approvalSha256) {
    throw new Error('approval_sha256_mismatch')
  }

  verifyApprovalBinding(plan, approval)

  // Step 2: Verify DSH Executable realpath & version
  let realDsh = ''
  let dshVersionOut = ''
  try {
    realDsh = await resolveExecutableRealpath(dshExecutable)
    const { stdout } = await execFileAsync(realDsh, ['--version'], {
      env: createSanitizedEnv(),
    })
    dshVersionOut = stdout.trim()
  } catch {
    throw new Error('dsh_version_check_failed')
  }

  if (dshVersionOut !== '0.1.1-rc.2') {
    throw new Error('dsh_version_mismatch')
  }

  // Step 3: Read and validate ExecutionManifest
  const manifestRaw = JSON.parse(await readFile(manifestPath, 'utf8'))
  const manifest = validateExecutionManifest(manifestRaw)

  const computedManifestSha256 = computeExecutionManifestSha256(manifest)
  if (computedManifestSha256 !== plan.execution_manifest_sha256) {
    throw new Error('execution_manifest_hash_mismatch')
  }

  if (manifest.dsh_executable_realpath !== realDsh) {
    throw new Error('dsh_executable_realpath_mismatch')
  }
  if (manifest.dsh_version !== '0.1.1-rc.2') {
    throw new Error('dsh_version_mismatch')
  }

  // Step 4: Verify Tarball, Profile package.json, Module Hashes, and Patch Hashes against ExecutionManifest
  const currentArtifact = await verifyCanaryArtifact(manifest.tarball_realpath)
  if (currentArtifact.packageSha256 !== manifest.tarball_sha256 || currentArtifact.packageSha256 !== plan.package_sha256) {
    throw new Error('tarball_hash_mismatch')
  }

  const dshHome = join(runRoot, 'dsh-home')
  const homePath = join(runRoot, 'home')
  const tmpPath = join(runRoot, 'tmp')

  const profilePkgJsonPath = join(dshHome, 'profiles', 'headless', 'package.json')
  const profilePkgRaw = JSON.parse(await readFile(profilePkgJsonPath, 'utf8'))
  const depVal = profilePkgRaw?.dependencies?.['dsh-mnemosyne']
  if (!depVal || typeof depVal !== 'string' || !depVal.startsWith('file:')) {
    throw new Error('package_binding_invalid')
  }
  const boundPath = depVal.slice('file:'.length)
  const resolvedBoundPath = await realpath(resolve(join(dshHome, 'profiles', 'headless'), boundPath))
  if (resolvedBoundPath !== manifest.tarball_realpath || depVal !== manifest.profile_dependency_value) {
    throw new Error('package_binding_path_mismatch')
  }

  // Verify Runtime Module Files closure
  for (const rmf of manifest.runtime_module_files) {
    const curRealpath = await realpath(rmf.realpath)
    if (curRealpath !== rmf.realpath) {
      throw new Error(`runtime_module_${rmf.role}_realpath_mismatch`)
    }
    const curBytes = await readFile(curRealpath, 'utf8')
    if (computeSha256(curBytes) !== rmf.content_sha256) {
      throw new Error(`runtime_module_${rmf.role}_hash_mismatch`)
    }
  }

  const sidecarPatchPath = join(evidenceDir, 'patches', 'sidecar-patch.yml')
  const resumePatchPath = join(evidenceDir, 'patches', 'resume-patch.yml')
  const sidecarContent = await readFile(sidecarPatchPath, 'utf8')
  const resumeContent = await readFile(resumePatchPath, 'utf8')

  if (computeSha256(sidecarContent) !== manifest.sidecar_patch_sha256) {
    throw new Error('sidecar_patch_hash_mismatch')
  }
  if (computeSha256(resumeContent) !== manifest.resume_patch_sha256) {
    throw new Error('resume_patch_hash_mismatch')
  }

  // Verify extra patches declared in manifest and their modules
  const extraPatchPaths = []
  const RELATIVE_IMPORT_REGEX_EXEC = /(?:import\s+(?:[^;]+from\s+)?|import\s*\(|require\s*\(|export\s+(?:[^;]+from\s+)?)['"]\.\.?\//
  for (const ep of manifest.extra_patches) {
    const epPath = join(evidenceDir, 'patches', ep.name.endsWith('.yml') ? ep.name : `${ep.name}.yml`)
    const epContent = await readFile(epPath, 'utf8')
    if (computeSha256(epContent) !== ep.patch_sha256) {
      throw new Error(`extra_patch_${ep.name}_hash_mismatch`)
    }
    if (ep.module_realpath) {
      const curEpModRealpath = await realpath(ep.module_realpath)
      if (curEpModRealpath !== ep.module_realpath) {
        throw new Error(`extra_module_${ep.name}_realpath_mismatch`)
      }
      const epModBytes = await readFile(curEpModRealpath, 'utf8')
      if (RELATIVE_IMPORT_REGEX_EXEC.test(epModBytes)) {
        throw new Error('extra_module_relative_import_forbidden')
      }
      if (computeSha256(epModBytes) !== ep.module_sha256) {
        throw new Error(`extra_module_${ep.name}_hash_mismatch`)
      }
    }
    extraPatchPaths.push(epPath)
  }

  // Verify no unmanifested extraTestPatches were passed
  if (extraTestPatches && extraTestPatches.length > 0) {
    for (const ep of extraTestPatches) {
      const epContent = await readFile(ep, 'utf8')
      const epHash = computeSha256(epContent)
      const found = manifest.extra_patches.some((p) => p.patch_sha256 === epHash)
      if (!found) {
        throw new Error('unmanifested_extra_patch_rejected')
      }
    }
  }

  // Step 5: Verify Credential metadata (read-only precheck)
  await verifyCredentialMetadataOnly(dshHome)

  // Step 6: Atomic Claim Approval (ALL prechecks passed, now claim!)
  await claimApproval(evidenceDir, plan, approval)

  // Step 7: Unified try/finally execution block with guaranteed cleanup
  const checks = {
    execution_wiring: 'not_run',
    automatic_capture: 'not_run',
    restart_persistence: 'not_run',
    progressive_disclosure: 'not_run',
    promotion: 'not_run',
    forget_and_grant: 'not_run',
    scope_isolation: 'not_run',
  }

  let executedRuns = 0
  let canaryStatus = 'pass'
  let reasonCode = null
  let totalClaimedBudget = 0
  let memoryReport = null

  const realRunRoot = await realpath(runRoot)
  const projectRootA = join(realRunRoot, 'project-a')
  const projectRootB = join(realRunRoot, 'project-b')
  const scopeA = computeProjectScopeId(projectRootA)
  const scopeB = computeProjectScopeId(projectRootB)

  let canaryLedger = createCanaryIdentityLedger({
    project_scope_a: scopeA,
    project_scope_b: scopeB,
  })

  let snapA_Prior = null
  try {
    snapA_Prior = await captureRunStateSnapshot({
      runId: 'run_1',
      projectRoot: projectRootA,
      sessionId: 'canary_init_session',
    })
  } catch {}

  let snapA_BeforeRun6 = null

  const totalTimeoutMs = plan.budgets?.total_timeout_ms || 720000
  const perRunTimeoutMs = plan.budgets?.per_run_timeout_ms || 120000
  const startTimestamp = Date.now()
  const deadline = startTimestamp + totalTimeoutMs

  const sanitizedEnv = createSanitizedEnv({
    DSH_HOME: dshHome,
    HOME: homePath,
    TMPDIR: tmpPath,
  })

  const mapReasonCode = (code) => {
    if (code && VALID_REASON_CODES.has(code)) return code
    return 'product_invariant_failed'
  }

  const buildReport = (status, clean, reason) => {
    if (evaluationLevel === 'business') {
      const isWiringPass = executedRuns === 6 && status === 'pass' && totalClaimedBudget > 0 && totalClaimedBudget <= MAX_MODEL_REQUESTS
      const allBusinessPass =
        checks.execution_wiring === 'pass' &&
        checks.automatic_capture === 'pass' &&
        checks.restart_persistence === 'pass' &&
        checks.progressive_disclosure === 'pass' &&
        checks.promotion === 'pass' &&
        checks.forget_and_grant === 'pass' &&
        checks.scope_isolation === 'pass'

      const finalStatus = status === 'pass' && allBusinessPass && isWiringPass ? 'pass' : 'fail'
      return createRedactedCanaryReportV2({
        package_version: plan.package_version,
        status: finalStatus,
        package_sha256: plan.package_sha256,
        plan_sha256: plan.plan_sha256,
        approval_sha256: approval.approval_sha256,
        run_count: executedRuns,
        model_request_count: totalClaimedBudget,
        checks,
        reason_code: finalStatus === 'pass' ? null : mapReasonCode(reason || reasonCode),
        cleanup_clean: clean,
      })
    } else {
      return createRedactedCanaryReport({
        package_version: plan.package_version,
        status,
        package_sha256: plan.package_sha256,
        plan_sha256: plan.plan_sha256,
        approval_sha256: approval.approval_sha256,
        run_count: executedRuns,
        model_request_count: totalClaimedBudget,
        checks,
        reason_code: status === 'pass' ? null : mapReasonCode(reason || reasonCode),
        cleanup_clean: clean,
      })
    }
  }

  try {
    for (const runCfg of manifest.runs) {
      if (canaryStatus !== 'pass') break

      const now = Date.now()
      const remainingTime = deadline - now
      if (remainingTime <= 0) {
        canaryStatus = 'fail'
        reasonCode = 'subprocess_timeout'
        break
      }

      const effectiveTimeout = Math.min(perRunTimeoutMs, remainingTime)
      const runCwd = join(runRoot, runCfg.cwd_rel)

      const args = ['--profile', 'headless']
      args.push('--patch', sidecarPatchPath)
      if (runCfg.is_resume) {
        args.push('--patch', resumePatchPath)
      }
      for (const epPath of extraPatchPaths) {
        args.push('--patch', epPath)
      }
      args.push(runCfg.task)

      try {
        const childExec = await spawnProcessGroup(realDsh, args, {
          cwd: runCwd,
          env: sanitizedEnv,
          timeout: effectiveTimeout,
          maxBuffer: 1048576,
        })
        await childExec.promise
      } catch {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      // Step 7.1: Verify SidecarLoadedReceipt for this run
      let sidecarReceipt = null
      try {
        sidecarReceipt = await readSidecarLoadedReceipt(evidenceDir, runCfg.id)
      } catch {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      if (!sidecarReceipt || sidecarReceipt.run_id !== runCfg.id) {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      const expectedSidecarHash = manifest.runtime_module_files.find((f) => f.role === 'audit_sidecar')?.content_sha256
      if (sidecarReceipt.module_sha256 !== expectedSidecarHash) {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      // Step 7.2: Verify LLM Claim for this run
      let validClaims = []
      try {
        validClaims = await readValidLlmClaims(evidenceDir)
      } catch {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      const currentRunClaims = validClaims.filter((c) => c.run_id === runCfg.id || c.claim?.run_id === runCfg.id)
      if (currentRunClaims.length === 0) {
        canaryStatus = 'fail'
        reasonCode = 'dsh_compatibility_failed'
        break
      }

      // Step 7.3: Verify Resume Receipt if this is a resume run
      if (runCfg.is_resume) {
        let resumeReceipt = null
        try {
          resumeReceipt = await readResumeCompletedReceipt(evidenceDir, runCfg.id)
        } catch {
          canaryStatus = 'fail'
          reasonCode = 'dsh_compatibility_failed'
          break
        }

        if (!resumeReceipt || resumeReceipt.run_id !== runCfg.id) {
          canaryStatus = 'fail'
          reasonCode = 'dsh_compatibility_failed'
          break
        }

        if (resumeReceipt.same_session !== true) {
          canaryStatus = 'fail'
          reasonCode = 'dsh_compatibility_failed'
          break
        }

        let run1SessionHash = null
        try {
          if (evaluationLevel === 'business') {
            const r1Ev = await readStrictSessionEvidence(evidenceDir, 'run_1')
            run1SessionHash = r1Ev?.session_id_sha256
          } else {
            const r1Ev = await readSessionEvidence(evidenceDir, 'run_1')
            run1SessionHash = r1Ev?.session_id_sha256 || (r1Ev?.session_id ? computeSha256(r1Ev.session_id) : null) || (r1Ev?.summary?.session_id ? computeSha256(r1Ev.summary.session_id) : null)
          }
        } catch {}

        if (!run1SessionHash || resumeReceipt.resumed_session_id_sha256 !== run1SessionHash || resumeReceipt.run_1_session_id_sha256 !== run1SessionHash) {
          canaryStatus = 'fail'
          reasonCode = 'dsh_compatibility_failed'
          break
        }

        const expectedResumeHash = manifest.runtime_module_files.find((f) => f.role === 'resume_driver')?.content_sha256
        if (resumeReceipt.module_sha256 !== expectedResumeHash) {
          canaryStatus = 'fail'
          reasonCode = 'dsh_compatibility_failed'
          break
        }
      }

      // Step 7.4: Evaluate Business Predicates if in business evaluation level
      if (evaluationLevel === 'business') {
        let runSessionEvidence = null
        try {
          runSessionEvidence = await readStrictSessionEvidence(evidenceDir, runCfg.id)
        } catch {
          canaryStatus = 'fail'
          reasonCode = 'product_invariant_failed'
          break
        }

        if (runCfg.id === 'run_1') {
          let snapA_Cur = null
          let predRes = null
          const pollDeadline = Date.now() + 5000
          while (Date.now() < pollDeadline) {
            snapA_Cur = await captureRunStateSnapshot({
              runId: 'run_1',
              projectRoot: projectRootA,
              sessionIdSha256: runSessionEvidence.session_id_sha256,
            })
            predRes = await predicateRun1_AutomaticCapture({
              snapshotAfter: snapA_Cur,
              sessionEvidence: runSessionEvidence,
            })
            if (predRes.pass) break
            await new Promise((r) => setTimeout(r, 200))
          }

          if (!predRes || !predRes.pass) {
            canaryStatus = 'fail'
            checks.automatic_capture = 'fail'
            reasonCode = mapReasonCode(predRes?.reason)
            break
          }
          checks.automatic_capture = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_1', {
            session_id_sha256: runSessionEvidence.session_id_sha256,
            short_term_ref: predRes.memory_ref,
          })
          snapA_Prior = snapA_Cur
        } else if (runCfg.id === 'run_2') {
          const snapA_Cur = await captureRunStateSnapshot({
            runId: 'run_2',
            projectRoot: projectRootA,
            sessionIdSha256: runSessionEvidence.session_id_sha256,
          })
          const resumeRec = await readResumeCompletedReceipt(evidenceDir, 'run_2')
          const predRes = await predicateRun2_RestartPersistence({
            snapshotBefore: snapA_Prior,
            snapshotAfter: snapA_Cur,
            sessionEvidence: runSessionEvidence,
            sourceShortMemoryId: canaryLedger.run_1_short_term_ref?.memory_id,
            resumeReceipt: resumeRec,
          })
          if (!predRes.pass) {
            canaryStatus = 'fail'
            checks.restart_persistence = 'fail'
            checks.progressive_disclosure = 'fail'
            reasonCode = mapReasonCode(predRes.reason)
            break
          }
          checks.restart_persistence = 'pass'
          checks.progressive_disclosure = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_2', {
            search_retrieval_id: predRes.open_grant?.retrieval_id,
            search_disclosure_sha256: predRes.open_grant?.search_disclosure_sha256 || predRes.open_grant?.disclosure_sha256,
            open_body_sha256: predRes.open_grant?.body_sha256,
          })
          snapA_Prior = snapA_Cur
        } else if (runCfg.id === 'run_3') {
          const snapA_Cur = await captureRunStateSnapshot({
            runId: 'run_3',
            projectRoot: projectRootA,
            sessionIdSha256: runSessionEvidence.session_id_sha256,
          })
          const resumeRec = await readResumeCompletedReceipt(evidenceDir, 'run_3')
          const predRes = await predicateRun3_Promotion({
            snapshotBefore: snapA_Prior,
            snapshotAfter: snapA_Cur,
            sessionEvidence: runSessionEvidence,
            sourceShortMemoryId: canaryLedger.run_1_short_term_ref?.memory_id,
            resumeReceipt: resumeRec,
          })
          if (!predRes.pass) {
            canaryStatus = 'fail'
            checks.promotion = 'fail'
            reasonCode = mapReasonCode(predRes.reason)
            break
          }
          checks.promotion = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_3', {
            promoted_long_term_ref: predRes.promoted_long_term_ref,
          })
          snapA_Prior = snapA_Cur
        } else if (runCfg.id === 'run_4') {
          if (runSessionEvidence.session_id_sha256 === canaryLedger.session_a1_sha256) {
            canaryStatus = 'fail'
            checks.promotion = 'fail'
            reasonCode = 'product_invariant_failed'
            break
          }
          const snapA_Cur = await captureRunStateSnapshot({
            runId: 'run_4',
            projectRoot: projectRootA,
            sessionIdSha256: runSessionEvidence.session_id_sha256,
          })
          const predRes = await predicateRun4_CrossSessionReading({
            snapshotBefore: snapA_Prior,
            snapshotAfter: snapA_Cur,
            sessionEvidence: runSessionEvidence,
            targetMemoryId: canaryLedger.run_3_promoted_long_term_ref?.memory_id,
            sessionA1Hash: canaryLedger.session_a1_sha256,
            oldRetrievalId: canaryLedger.run_2_retrieval_id,
          })
          if (!predRes.pass) {
            canaryStatus = 'fail'
            checks.promotion = 'fail'
            reasonCode = mapReasonCode(predRes.reason)
            break
          }
          checks.promotion = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_4', {
            session_a3_sha256: runSessionEvidence.session_id_sha256,
          })
          snapA_Prior = snapA_Cur
        } else if (runCfg.id === 'run_5') {
          const snapA_Cur = await captureRunStateSnapshot({
            runId: 'run_5',
            projectRoot: projectRootA,
            sessionIdSha256: runSessionEvidence.session_id_sha256,
          })
          const predRes = await predicateRun5_ForgetAndGrantInvalidation({
            snapshotAfter: snapA_Cur,
            sessionEvidence: runSessionEvidence,
            targetMemoryId: canaryLedger.run_3_promoted_long_term_ref?.memory_id,
          })
          if (!predRes.pass) {
            canaryStatus = 'fail'
            checks.forget_and_grant = 'fail'
            reasonCode = mapReasonCode(predRes.reason)
            break
          }
          checks.forget_and_grant = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_5', {
            forget_ref: predRes.forget_ref,
          })
          snapA_Prior = snapA_Cur
          snapA_BeforeRun6 = snapA_Cur
        } else if (runCfg.id === 'run_6') {
          const snapA_AfterRun6 = await captureRunStateSnapshot({
            runId: snapA_BeforeRun6?.run_id || 'run_5',
            projectRoot: projectRootA,
            sessionIdSha256: snapA_BeforeRun6?.session_id_sha256 || runSessionEvidence.session_id_sha256,
          })
          const snapB_Cur = await captureRunStateSnapshot({
            runId: 'run_6',
            projectRoot: projectRootB,
            sessionIdSha256: runSessionEvidence.session_id_sha256,
          })
          const predRes = await predicateRun6_ScopeIsolation({
            snapshotProjectA_Before: snapA_BeforeRun6 || snapA_Prior,
            snapshotProjectA_After: snapA_AfterRun6,
            snapshotProjectB: snapB_Cur,
            sessionEvidenceB: runSessionEvidence,
            projectScopeA: scopeA,
            projectScopeB: scopeB,
          })
          if (!predRes.pass) {
            canaryStatus = 'fail'
            checks.scope_isolation = 'fail'
            reasonCode = mapReasonCode(predRes.reason)
            break
          }
          checks.scope_isolation = 'pass'
          canaryLedger = advanceCanaryIdentityLedger(canaryLedger, 'run_6', {
            project_b_isolated: true,
          })
        }
      }

      executedRuns++
    }

    // Step 8: Read Budget & Summary BEFORE cleanup
    const budgetSummary = await summarizeLlmBudget(evidenceDir)
    totalClaimedBudget = budgetSummary.total_claimed

    // Step 9: Set execution wiring check status
    const isWiringPass = executedRuns === 6 && canaryStatus === 'pass' && totalClaimedBudget > 0 && totalClaimedBudget <= MAX_MODEL_REQUESTS
    checks.execution_wiring = isWiringPass ? 'pass' : 'fail'
    if (canaryStatus === 'pass' && !isWiringPass) {
      canaryStatus = 'fail'
      reasonCode = reasonCode || 'dsh_compatibility_failed'
    }

    // Step 10: Build in-memory report BEFORE cleanup
    memoryReport = buildReport(canaryStatus, false, reasonCode)
  } catch (err) {
    canaryStatus = 'fail'
    if (!reasonCode) {
      if (err && typeof err === 'object' && err.message && VALID_REASON_CODES.has(err.message)) {
        reasonCode = err.message
      } else {
        reasonCode = 'product_invariant_failed'
      }
    }
    checks.execution_wiring = 'fail'
    memoryReport = buildReport('fail', false, reasonCode)
  } finally {
    // Step 11: Guaranteed Cleanup on all paths after claim
    let cleanupClean = false
    try {
      const cleanupRes = await cleanupRunRoot(runRoot, plan.run_root_identity)
      if (cleanupRes && cleanupRes.success === true) {
        cleanupClean = true
      }
    } catch {
      cleanupClean = false
    }

    if (!cleanupClean) {
      checks.execution_wiring = 'fail'
      memoryReport = buildReport('fail', false, 'cleanup_failed')
    } else {
      memoryReport = buildReport(canaryStatus, true, reasonCode)
    }
  }

  // Step 12: Write report to external path if requested
  if (reportOutPath) {
    await writeRedactedCanaryReport(reportOutPath, memoryReport)
  }

  return memoryReport
}
