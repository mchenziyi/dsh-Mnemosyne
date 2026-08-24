import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, mkdir, realpath, chmod, open, lstat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ProtocolValidationError,
  canonicalBytes,
  canonicalHash,
  sha256,
  withoutHash,
} from '../src/protocol/canonical.js'
import {
  createRealCanaryExecutionClaim,
  createRealCanaryApprovalReceipt,
  type RealCanaryApprovalReceipt,
  type RealCanaryExecutionClaim,
} from '../src/m05d2/approval.js'
import {
  persistExecutionClaim,
  persistReceipt,
  persistSummary,
  verifyPersistenceRoot,
  __setPersistenceTestHooksForTest,
} from '../src/m05d2/persistence.js'
import {
  type RealCanaryReceipt,
  type RealCanarySummary,
} from '../src/m05d2/runner.js'
import { runM05F1PlanningGate } from '../src/m05f/authorization.js'
import { createCanaryPlan } from '../src/m05e/index.js'
import { loadM05Dv2Fixtures } from '../src/m05d/index.js'

const execFileAsync = promisify(execFile)
const defaultFixtures = await loadM05Dv2Fixtures()

describe('M0.5D-D2: Persistence / Execution Claim Security & Cross-Process Transactions', () => {
  async function createGateFixture(tempBase: string) {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')
    const isoPath = join(tempBase, 'gate-iso-root')

    const fixtures = defaultFixtures
    const manifestHash = canonicalHash(fixtures.manifest)
    const m05ePlan = await createCanaryPlan()
    const m05ePlanHash = m05ePlan.plan_hash

    const gate = await runM05F1PlanningGate({
      audited_at: '2026-08-21T00:00:00Z',
      created_at: '2026-08-21T00:00:00Z',
      expires_at: '2026-08-21T01:00:00Z',
      now: '2026-08-21T00:00:00Z',
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      fixture_manifest_sha256: manifestHash,
      m05e_canary_plan_sha256: m05ePlanHash,
      isolation_root: isoPath,
      cost: {
        status: 'verified',
        currency: 'USD',
        source_ref: 'pricing-table-v1',
        source_checked_at: '2026-08-21T00:00:00Z',
        worst_case_upper_bound: '0.125000',
      },
    })
    return { ...gate, package_json_content: pkgContent, lockfile_content: lockContent }
  }

  function createSampleReceipt(options: {
    authSha: string
    approvalSha: string
    planHash: string
    runId?: string
    taskId?: string
  }): RealCanaryReceipt {
    const taskId = options.taskId ?? 'task_build_recovery'
    const group = 'no_memory' as const
    const runId = options.runId ?? `run_${canonicalHash({
      evaluation_id: 'm05_v2',
      task_id: taskId,
      group,
      requested_seed: 101,
    }).slice(7, 23)}`
    const body = {
      schema_version: 1 as const,
      run_id: runId,
      authorization_sha256: options.authSha,
      approval_sha256: options.approvalSha,
      plan_hash: options.planHash,
      provider: { provider: 'deepseek-official' as const, model: 'deepseek-v4-flash' },
      evidence_kind: 'real_provider_canary' as const,
      task_id: taskId,
      group,
      requested_seed: 101 as const,
      seed_honored: false as const,
      claim_sequence: [1, 2],
      tool_calls: ['m05d_task_fixture'],
      memory_events: ['user_message'],
      recall_source: null,
      recall_context: null,
      recall_receipt: null,
      observed_memory_ids: [],
      retrieved_memory_ids: [],
      opened_memory_ids: [],
      adopted_memory_ids: [],
      model_call_count: 1,
      model: {
        schema_version: 1 as const,
        task_id: options.taskId ?? 'task_build_recovery',
        exit_code: 0,
        result: { rebuild_mode: 'targeted' },
        adopted_memory_ids: [],
        failure_code: null,
      },
      usage: {
        model: { inputTokens: 10, outputTokens: 5 },
        retrieval_estimated_tokens: 0,
        acquisition_tokens: 5,
      },
      acquisition: {
        case_id: 'novel_candidate' as const,
        provider_calls: 1 as const,
        after_task_completed: true as const,
        decision: 'novel_candidate' as const,
        reason_code: 'novel_candidate' as const,
        candidate_schema_valid: true as const,
        candidate_content_sha256: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      duration_ms: 100,
      success: true,
    }
    return {
      ...body,
      canonical_hash: canonicalHash(body),
    }
  }

  function createSampleSummary(options: {
    authSha: string
    approvalSha: string
    planHash: string
    manifestHash: string
    receipts?: RealCanaryReceipt[]
  }): RealCanarySummary {
    const receipts = options.receipts ?? []
    const body = {
      schema_version: 1 as const,
      status: 'real_provider_plumbing_fail' as const,
      authorization_sha256: options.authSha,
      approval_sha256: options.approvalSha,
      plan_hash: options.planHash,
      fixture_manifest_sha256: options.manifestHash,
      receipts,
      deterministic_prefix_bytes: canonicalBytes(receipts.map((r) => {
        const { duration_ms: _d, canonical_hash: _h, ...b } = r
        return b
      })),
      ledger: {
        task_calls_claimed: 0,
        acquisition_calls_claimed: 0,
        total_calls_claimed: 0,
        completed_calls: 0,
        failed_calls: 0,
        consecutive_provider_or_protocol_errors: 0,
      },
      reason_code: 'credential_unavailable' as const,
      cleanup_clean: true,
      failure_diagnostics: [],
    }
    return {
      ...body,
      summary_sha256: canonicalHash(body),
    }
  }

  describe('1. Cross-Process and In-Process Claim Concurrency & Single Winner Transaction', () => {
    it('Requirement 1: Multiple independent Node child processes racing for same Claim produces exactly 1 winner, N-1 conflicts, zero byte corruption, zero temp residue', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-proc-race-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const workerScript = resolve(process.cwd(), 'tests/fixtures/claim-worker.mjs')
        const concurrency = 6
        const claimedAt = '2026-08-21T00:20:00Z'

        const childPromises = Array.from({ length: concurrency }, () =>
          execFileAsync(process.execPath, [
            workerScript,
            '--persistence-root',
            persistenceRoot,
            '--auth-sha',
            authorization.authorization_sha256,
            '--approval-sha',
            approval.approval_sha256,
            '--root-sha',
            persistenceRootHash,
            '--claimed-at',
            claimedAt,
          ]).then(
            (res) => ({ status: 'fulfilled' as const, stdout: res.stdout, stderr: res.stderr, code: 0 }),
            (err) => ({ status: 'rejected' as const, stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 })
          )
        )

        const results = await Promise.all(childPromises)

        const winners = results.filter((r) => r.code === 0 && r.stdout.includes('CLAIM_CREATED'))
        const losers = results.filter((r) => r.code !== 0 && (r.stderr.includes('CLAIM_CONFLICT') || r.stdout.includes('CLAIM_CONFLICT')))

        expect(winners.length).toBe(1)
        expect(losers.length).toBe(concurrency - 1)

        // Verify target file integrity (byte-for-byte exact match to canonicalBytes)
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: persistenceRootHash,
          claimed_at: claimedAt,
        })

        const targetFile = join(persistenceRoot, 'claims', `${claim.execution_id}.json`)
        const rawContent = readFileSync(targetFile, 'utf8')
        expect(rawContent).toBe(canonicalBytes(claim))

        const content = JSON.parse(rawContent)
        expect(content.execution_id).toBe(claim.execution_id)
        expect(content.claim_sha256).toBe(claim.claim_sha256)

        // Verify file mode strictly 0600
        const fileStat = await lstat(targetFile)
        expect(fileStat.isFile()).toBe(true)
        expect(fileStat.isSymbolicLink()).toBe(false)
        expect(fileStat.mode & 0o777).toBe(0o600)

        // Verify no leftover .tmp files
        const claimsDir = join(persistenceRoot, 'claims')
        const entries = await readdir(claimsDir)
        const tmpFiles = entries.filter((e) => e.startsWith('.tmp_'))
        expect(tmpFiles).toHaveLength(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 1 & 8: In-process Promise.allSettled concurrency on persistExecutionClaim with identical execution_id produces exactly 1 winner, rest rejected with ProtocolValidationError', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-prom-race-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        // All 8 promises race for the exact same execution claim (same execution_id)
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: persistenceRootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => persistExecutionClaim(persistenceRoot, claim))
        )

        const fulfilled = results.filter((r) => r.status === 'fulfilled')
        const rejected = results.filter((r) => r.status === 'rejected')

        expect(fulfilled.length).toBe(1)
        expect(rejected.length).toBe(7)
        for (const rej of rejected) {
          expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(ProtocolValidationError)
        }

        // Verify target file byte-for-byte exact match and 0600 mode
        const targetPath = join(persistenceRoot, 'claims', `${claim.execution_id}.json`)
        expect(readFileSync(targetPath, 'utf8')).toBe(canonicalBytes(claim))

        const targetStat = await lstat(targetPath)
        expect(targetStat.isFile()).toBe(true)
        expect(targetStat.isSymbolicLink()).toBe(false)
        expect(targetStat.mode & 0o777).toBe(0o600)

        // Verify no leftover .tmp files
        const claimsDir = join(persistenceRoot, 'claims')
        const entries = await readdir(claimsDir)
        expect(entries.filter((e) => e.startsWith('.tmp_'))).toHaveLength(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('2. Symlink and Permissions Rejection at All Hierarchy Levels', () => {
    it('Requirement 2 & 8: Rejects root path when root itself or any ancestor is a symlink', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-sym-root-'))
      const realRoot = join(tempBase, 'real-root')
      await mkdir(realRoot, { recursive: true, mode: 0o700 })
      const symRoot = join(tempBase, 'sym-root')
      await symlink(realRoot, symRoot)

      try {
        const realHash = sha256(resolve(realRoot))
        const symHash = sha256(resolve(symRoot))

        await expect(verifyPersistenceRoot(realRoot, realHash)).resolves.toBe(resolve(realRoot))
        await expect(verifyPersistenceRoot(symRoot, symHash)).rejects.toThrow(ProtocolValidationError)

        // Ancestor is a symlink
        const ancestorDir = join(tempBase, 'ancestor-real')
        await mkdir(ancestorDir, { recursive: true, mode: 0o700 })
        const ancestorSym = join(tempBase, 'ancestor-sym')
        await symlink(ancestorDir, ancestorSym)
        const subRoot = join(ancestorSym, 'sub-evidence')
        await mkdir(join(ancestorDir, 'sub-evidence'), { recursive: true, mode: 0o700 })
        const subHash = sha256(resolve(subRoot))

        await expect(verifyPersistenceRoot(subRoot, subHash)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 2 & 8: Rejects 0755 mode on root, ancestors with group/other write, and 0755 subdirectories', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-perm-'))
      const mode755Root = join(tempBase, 'mode755-root')
      await mkdir(mode755Root, { recursive: true, mode: 0o755 })
      await chmod(mode755Root, 0o755)

      try {
        const hash755 = sha256(resolve(mode755Root))
        await expect(verifyPersistenceRoot(mode755Root, hash755)).rejects.toThrow(ProtocolValidationError)

        // 0700 root with 0755 claims subdirectory
        const validRoot = join(tempBase, 'valid-root')
        await mkdir(validRoot, { recursive: true, mode: 0o700 })
        const badClaimsDir = join(validRoot, 'claims')
        await mkdir(badClaimsDir, { mode: 0o755 })
        await chmod(badClaimsDir, 0o755)

        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(validRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        await expect(persistExecutionClaim(validRoot, claim)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 8: Rejects symlinked claims or receipts subdirectories', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-sub-sym-'))
      const validRoot = join(tempBase, 'valid-root')
      await mkdir(validRoot, { recursive: true, mode: 0o700 })

      const externalDir = join(tempBase, 'external-claims')
      await mkdir(externalDir, { recursive: true, mode: 0o700 })
      await symlink(externalDir, join(validRoot, 'claims'))

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(validRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        await expect(persistExecutionClaim(validRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Zero-write assertion on external directory
        const externalEntries = await readdir(externalDir)
        expect(externalEntries).toHaveLength(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. Directory Identity Swapping & dev/ino Comparison (TOCTOU Defense)', () => {
    it('Requirement 4 & 6: Pre-publish directory dev/ino swap is detected, fail loud before publish, clean temp, zero target written', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-devino-pre-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const externalDir = join(tempBase, 'external-dir')
      await mkdir(externalDir, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        const claimsDir = join(persistenceRoot, 'claims')
        const backupDir = join(persistenceRoot, 'claims_old')

        // Inject hook before publish to perform real directory inode replacement
        __setPersistenceTestHooksForTest({
          beforePublishLink: async () => {
            // Replace claims directory with a newly created directory (different inode)
            const { rename } = await import('node:fs/promises')
            await rename(claimsDir, backupDir)
            await mkdir(claimsDir, { mode: 0o700 })
          },
        })

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Ensure target was not written in the replaced directory
        const entries = await readdir(claimsDir)
        expect(entries).toHaveLength(0)

        // In backup directory, target file must NOT exist (only diagnostic temp file)
        const oldEntries = await readdir(backupDir)
        expect(oldEntries.includes(`${claim.execution_id}.json`)).toBe(false)
        for (const entry of oldEntries) {
          expect(entry.startsWith('.tmp_')).toBe(true)
        }

        // External directory has zero writes
        const externalEntries = await readdir(externalDir)
        expect(externalEntries).toHaveLength(0)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 4 & 6: Post-publish directory dev/ino swap is detected, fails loud, and retains published target in backup', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-devino-post-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const externalDir = join(tempBase, 'external-dir')
      await mkdir(externalDir, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        const claimsDir = join(persistenceRoot, 'claims')
        const backupDir = join(persistenceRoot, 'claims_backup')

        __setPersistenceTestHooksForTest({
          afterPublishLink: async () => {
            // Real post-publish swap: rename published parent dir to backup and recreate dir with new inode
            // NOTE: We do NOT throw here; the post-publish dev+ino check must detect the mismatch and throw!
            const { rename } = await import('node:fs/promises')
            await rename(claimsDir, backupDir)
            await mkdir(claimsDir, { mode: 0o700 })
          },
        })

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Published target must be preserved in backup directory with exact canonical bytes and 0600 mode
        const backupTarget = join(backupDir, `${claim.execution_id}.json`)
        const st = await lstat(backupTarget)
        expect(st.isFile()).toBe(true)
        expect(st.isSymbolicLink()).toBe(false)
        expect(st.mode & 0o777).toBe(0o600)
        expect(readFileSync(backupTarget, 'utf8')).toBe(canonicalBytes(claim))

        // New claims directory must have zero entries (zero write)
        const newEntries = await readdir(claimsDir)
        expect(newEntries).toHaveLength(0)

        // External directory must have zero entries
        const externalEntries = await readdir(externalDir)
        expect(externalEntries).toHaveLength(0)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 4 & 6: Post-publish root directory dev/ino swap is detected, fails loud, and retains published target in backup root', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-rootino-post-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const backupRoot = join(tempBase, 'evidence-root-backup')
      const externalDir = join(tempBase, 'external-dir')
      await mkdir(externalDir, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        __setPersistenceTestHooksForTest({
          afterPublishLink: async () => {
            // Real post-publish root swap: rename published root dir to backup and recreate root with new inode
            const { rename } = await import('node:fs/promises')
            await rename(persistenceRoot, backupRoot)
            await mkdir(persistenceRoot, { mode: 0o700 })
          },
        })

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Published target must be preserved in backup root claims dir
        const backupTarget = join(backupRoot, 'claims', `${claim.execution_id}.json`)
        const st = await lstat(backupTarget)
        expect(st.isFile()).toBe(true)
        expect(st.isSymbolicLink()).toBe(false)
        expect(st.mode & 0o777).toBe(0o600)
        expect(readFileSync(backupTarget, 'utf8')).toBe(canonicalBytes(claim))

        // New persistenceRoot has zero writes
        const newEntries = await readdir(persistenceRoot)
        expect(newEntries).toHaveLength(0)

        // External directory has zero writes
        const externalEntries = await readdir(externalDir)
        expect(externalEntries).toHaveLength(0)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('4. Failure Injections: File Fsync, Directory Fsync, Readback Mismatch, Link EEXIST', () => {
    it('Requirement 3 & 8: File fsync failure aborts publish, unlinks temp file, zero target published', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-file-fsync-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        __setPersistenceTestHooksForTest({
          simulateFileFsyncFailure: true,
        })

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        const claimsDir = join(persistenceRoot, 'claims')
        const entries = await readdir(claimsDir)
        expect(entries).toHaveLength(0)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 3 & 8: Directory fsync failure fails loud (does NOT silently succeed) and retains published target', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-dir-fsync-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        __setPersistenceTestHooksForTest({
          simulateDirFsyncFailure: true,
        })

        // Directory fsync failure MUST throw and not silently succeed
        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Published target must remain on disk
        const targetPath = join(persistenceRoot, 'claims', `${claim.execution_id}.json`)
        const st = await lstat(targetPath)
        expect(st.isFile()).toBe(true)

        // Temp file must be unlinked
        const entries = await readdir(join(persistenceRoot, 'claims'))
        expect(entries.filter((e) => e.startsWith('.tmp_'))).toHaveLength(0)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 5 & 8: Post-publish readback byte mismatch or mode error throws ProtocolValidationError and retains published target', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-readback-fail-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        __setPersistenceTestHooksForTest({
          simulateReadbackMismatch: true,
        })

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Target remains on disk
        const targetPath = join(persistenceRoot, 'claims', `${claim.execution_id}.json`)
        const st = await lstat(targetPath)
        expect(st.isFile()).toBe(true)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 3 & 8: Target link EEXIST fails closed with zero byte overwrite of existing target and zero temp residue', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-eexist-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        // Pre-create target file with distinct content
        const claimsDir = join(persistenceRoot, 'claims')
        await mkdir(claimsDir, { mode: 0o700 })
        const targetPath = join(claimsDir, `${claim.execution_id}.json`)
        const initialContent = '{"original":"untouched_pre_existing_data"}'
        const handle = await open(targetPath, 'wx', 0o600)
        await handle.writeFile(initialContent, 'utf8')
        await handle.sync()
        await handle.close()

        // Attempting persistExecutionClaim on existing target must throw
        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // Content must be 100% untouched
        const currentContent = readFileSync(targetPath, 'utf8')
        expect(currentContent).toBe(initialContent)

        // Zero temp file residue
        const entries = await readdir(claimsDir)
        expect(entries.filter((e) => e.startsWith('.tmp_'))).toHaveLength(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('5. Independent Security Verification on All Three Public Entry Points', () => {
    it('Requirement 2 & 8: persistReceipt independently verifies root hash, root/ancestor security, filename regex, and 0600 mode', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-receipt-sec-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization, plan } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })

        const receipt = createSampleReceipt({
          authSha: authorization.authorization_sha256,
          approvalSha: approval.approval_sha256,
          planHash: plan.plan_sha256,
        })

        // 1. Valid persistReceipt
        await expect(persistReceipt(persistenceRoot, rootHash, receipt)).resolves.not.toThrow()
        const targetPath = join(persistenceRoot, 'receipts', `${receipt.run_id}.json`)
        const st = await lstat(targetPath)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o777).toBe(0o600)

        // 2. Hash mismatch rejection
        await expect(
          persistReceipt(persistenceRoot, 'sha256_0000000000000000000000000000000000000000000000000000000000000000', receipt)
        ).rejects.toThrow(ProtocolValidationError)

        // 3. Duplicate write rejection (no overwrite)
        await expect(persistReceipt(persistenceRoot, rootHash, receipt)).rejects.toThrow(ProtocolValidationError)

        // 4. Invalid run_id / traversal rejection
        const badReceipt = { ...receipt, run_id: '../escaped_run' }
        await expect(persistReceipt(persistenceRoot, rootHash, badReceipt as unknown as RealCanaryReceipt)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 2 & 8: persistSummary independently verifies root hash, root/ancestor security, and publishes summary.json with 0600 mode', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-summary-sec-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization, plan } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })

        const summary = createSampleSummary({
          authSha: authorization.authorization_sha256,
          approvalSha: approval.approval_sha256,
          planHash: plan.plan_sha256,
          manifestHash: plan.fixture_manifest_sha256,
        })

        // 1. Valid persistSummary
        await expect(persistSummary(persistenceRoot, rootHash, summary)).resolves.not.toThrow()
        const targetPath = join(persistenceRoot, 'summary.json')
        const st = await lstat(targetPath)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o777).toBe(0o600)

        // 2. Duplicate write rejection (no overwrite)
        await expect(persistSummary(persistenceRoot, rootHash, summary)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 8: Rejects writing over pre-existing symlinked target with zero external write', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-target-sym-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      const externalFile = join(tempBase, 'external-secret.json')
      const externalInitialContent = '{"secret":"do_not_overwrite"}'
      const h = await open(externalFile, 'wx', 0o600)
      await h.writeFile(externalInitialContent, 'utf8')
      await h.sync()
      await h.close()

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        const claimsDir = join(persistenceRoot, 'claims')
        await mkdir(claimsDir, { mode: 0o700 })
        const targetPath = join(claimsDir, `${claim.execution_id}.json`)
        await symlink(externalFile, targetPath)

        await expect(persistExecutionClaim(persistenceRoot, claim)).rejects.toThrow(ProtocolValidationError)

        // External file was not modified
        expect(readFileSync(externalFile, 'utf8')).toBe(externalInitialContent)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('Requirement 2 & 8: Rejects ancestor directory with group/other write permission (mode & 0o022 !== 0)', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-anc-write-'))
      const parentDir = join(tempBase, 'parent')
      await mkdir(parentDir, { mode: 0o777 })
      await chmod(parentDir, 0o777)
      const evidenceRoot = join(parentDir, 'evidence-root')
      await mkdir(evidenceRoot, { mode: 0o700 })

      try {
        const rootHash = sha256(resolve(evidenceRoot))
        await expect(verifyPersistenceRoot(evidenceRoot, rootHash)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('6. Error Sanitization & Zero External Writes', () => {
    it('Requirement 7 & 8: All thrown errors are desensitized ProtocolValidationError with no path or secret leaks', async () => {
      const invalidPath = '/non/existent/path/with/potential/leak'
      await expect(
        verifyPersistenceRoot(invalidPath, 'sha256_0000000000000000000000000000000000000000000000000000000000000000')
      ).rejects.toThrow(ProtocolValidationError)

      try {
        await verifyPersistenceRoot(invalidPath, 'sha256_0000000000000000000000000000000000000000000000000000000000000000')
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProtocolValidationError)
        expect(err.message).toBe('protocol validation failed')
        expect(err.message).not.toContain(invalidPath)
        expect(err.stack).toBeDefined()
      }
    })
  })

  describe('7. Temporary File Nonce & Non-Fact Guarantees', () => {
    it('Requirement 7: Temporary file nonce strictly uses crypto.randomUUID() format and never leaks into Fact', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-uuid-nonce-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      let capturedTempFile: string | null = null

      try {
        const { authorization } = await createGateFixture(tempBase)
        const rootHash = sha256(resolve(persistenceRoot))
        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: rootHash,
        })
        const claim = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: rootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        __setPersistenceTestHooksForTest({
          beforePublishLink: async () => {
            const claimsDir = join(persistenceRoot, 'claims')
            const entries = await readdir(claimsDir)
            const tmp = entries.find((e) => e.startsWith('.tmp_'))
            if (tmp) {
              capturedTempFile = tmp
            }
          },
        })

        await persistExecutionClaim(persistenceRoot, claim)

        expect(capturedTempFile).not.toBeNull()
        // Must match strictly UUID v4 format: .tmp_<8>-<4>-<4>-<4>-<12>
        const uuidRegex = /^\.tmp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        expect(capturedTempFile).toMatch(uuidRegex)

        // Read published file, confirm no nonce in canonical bytes
        const targetPath = join(persistenceRoot, 'claims', `${claim.execution_id}.json`)
        const content = readFileSync(targetPath, 'utf8')
        expect(content).toBe(canonicalBytes(claim))
        expect(content).not.toContain(capturedTempFile!)
      } finally {
        __setPersistenceTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('8. Test Seam Export Isolation & Zero Package Leaks', () => {
    it('Requirement 1 & 5: Persistence test seam is not exported from root plugin or src/m05d2/index.ts', async () => {
      const rootExports = await import('../src/index.js')
      expect('__setPersistenceTestHooksForTest' in rootExports).toBe(false)
      expect('PersistenceInternalTestHooks' in rootExports).toBe(false)

      const m05d2Exports = await import('../src/m05d2/index.js')
      expect('__setPersistenceTestHooksForTest' in m05d2Exports).toBe(false)
      expect('PersistenceInternalTestHooks' in m05d2Exports).toBe(false)
      expect('simulateFileFsyncFailure' in m05d2Exports).toBe(false)
      expect('simulateDirFsyncFailure' in m05d2Exports).toBe(false)
      expect('simulateReadbackMismatch' in m05d2Exports).toBe(false)
    })
  })
})
