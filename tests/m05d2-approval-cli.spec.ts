import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, mkdir, realpath, chmod, writeFile, readdir, lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import { canonicalHash, sha256 } from '../src/protocol/canonical.js'
import { runM05F1PlanningGate } from '../src/m05f/authorization.js'
import { validateRealCanaryApprovalReceipt } from '../src/m05d2/approval.js'
import { loadM05Dv2Fixtures } from '../src/m05d/index.js'
import { createCanaryPlan } from '../src/m05e/index.js'

const execFileAsync = promisify(execFile)
const defaultFixtures = await loadM05Dv2Fixtures()

describe('M0.5D-D2-B1 Approval CLI: scripts/m05d2-create-approval.ts', () => {
  let cliTempDir: string
  let cliBundlePath: string

  beforeAll(async () => {
    const base = await realpath(tmpdir())
    cliTempDir = await mkdtemp(join(base, 'dsh-approval-cli-bundle-'))
    await writeFile(join(cliTempDir, 'package.json'), JSON.stringify({ name: 'test-approval-cli-bundle', version: '0.0.0' }))
    await symlink(resolve(process.cwd(), 'node_modules'), join(cliTempDir, 'node_modules'))
    const outDir = join(cliTempDir, 'bin')
    await mkdir(outDir)
    await build({
      entry: [resolve(process.cwd(), 'scripts/m05d2-create-approval.ts')],
      outDir,
      format: 'esm',
      dts: false,
    })
    cliBundlePath = join(outDir, 'm05d2-create-approval.mjs')
  }, 30000)

  afterAll(async () => {
    if (cliTempDir) {
      await rm(cliTempDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  interface CliRunResult {
    exitCode: number
    stdout: string
    stderr: string
  }

  async function runCliProcess(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRunResult> {
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: 'sk-secret-sentinel',
      HTTP_PROXY: 'http://127.0.0.1:0',
      HTTPS_PROXY: 'http://127.0.0.1:0',
      http_proxy: 'http://127.0.0.1:0',
      https_proxy: 'http://127.0.0.1:0',
      ALL_PROXY: 'http://127.0.0.1:0',
      all_proxy: 'http://127.0.0.1:0',
      ...extraEnv,
    }

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliBundlePath, ...args], {
        env,
        timeout: 15000,
      })
      return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) }
    } catch (err: any) {
      const exitCode = typeof err.code === 'number' ? err.code : (typeof err.status === 'number' ? err.status : 1)
      return {
        exitCode,
        stdout: String(err.stdout ?? ''),
        stderr: String(err.stderr ?? ''),
      }
    }
  }

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

  describe('1. Argument Parsing and Validation', () => {
    it('rejects missing required arguments with missing_required_argument', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-args-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const validArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        // Test dropping each argument pair
        for (let i = 0; i < validArgs.length; i += 2) {
          const droppedFlag = validArgs[i]
          const incompleteArgs = validArgs.filter((_, idx) => idx !== i && idx !== i + 1)
          const res = await runCliProcess(incompleteArgs)
          expect(res.exitCode).toBe(1)
          expect(res.stderr).toContain('Reason: missing_required_argument')

          const jsonRes = await runCliProcess([...incompleteArgs, '--json'])
          expect(jsonRes.exitCode).toBe(1)
          expect(jsonRes.stderr).toContain('"reason_code":"missing_required_argument"')
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects invalid decision values with invalid_decision', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-dec-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const args = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'maybe',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        const res = await runCliProcess(args)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: invalid_decision')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects relative paths and traversal with relative_path_rejected', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-rel-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const relCases = [
          ['--authorization', './auth.json'],
          ['--persistence-root', './evidence-root'],
          ['--output', './approval.json'],
          ['--output', tempBase + '/sub/../approval.json'],
        ]

        for (const [flag, relVal] of relCases) {
          const args = [
            '--authorization', flag === '--authorization' ? relVal : authPath,
            '--persistence-root', flag === '--persistence-root' ? relVal : persistenceRoot,
            '--decision', 'approved',
            '--subject-id', 'operator_01',
            '--now', '2026-08-21T00:15:00Z',
            '--output', flag === '--output' ? relVal : outputPath,
          ]
          const res = await runCliProcess(args)
          expect(res.exitCode).toBe(1)
          expect(res.stderr).toContain('Reason: relative_path_rejected')
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects invalid now timestamp with invalid_now_timestamp', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-now-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const args = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-02-31T00:00:00Z',
          '--output', outputPath,
        ]

        const res = await runCliProcess(args)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: invalid_now_timestamp')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects duplicate or unknown arguments', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-unk-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        // Duplicate argument
        const dupRes = await runCliProcess([...baseArgs, '--decision', 'rejected'])
        expect(dupRes.exitCode).toBe(1)
        expect(dupRes.stderr).toContain('Reason: duplicate_argument')

        // Unknown argument
        const unkRes = await runCliProcess([...baseArgs, '--unknown-flag', 'value'])
        expect(unkRes.exitCode).toBe(1)
        expect(unkRes.stderr).toContain('Reason: unknown_argument')
        expect(unkRes.stderr).not.toContain('unknown-flag') // Sanitized: do not leak unknown flag
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('2. File Safety, Persistence Root & No-Overwrite Constraints', () => {
    it('rejects non-existent, symlink, or oversized authorization files', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-auth-safe-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        // 1. Non-existent file
        const res1 = await runCliProcess([
          '--authorization', join(tempBase, 'non-existent.json'),
          ...baseArgs.slice(2),
        ])
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: file_read_error')

        // 2. Symlink authorization file
        const realAuth = join(tempBase, 'real-auth.json')
        writeFileSync(realAuth, JSON.stringify(authorization))
        await rm(authPath, { force: true })
        await symlink(realAuth, authPath)
        const res2 = await runCliProcess(baseArgs)
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: invalid_file_type')

        // 3. Oversized authorization file
        await rm(authPath, { force: true })
        const oversized = { ...authorization, padding: 'X'.repeat(1024 * 1024 + 10) }
        writeFileSync(authPath, JSON.stringify(oversized))
        const res3 = await runCliProcess(baseArgs)
        expect(res3.exitCode).toBe(1)
        expect(res3.stderr).toContain('Reason: oversized_file')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects invalid or insecure persistence root (non-0700, symlink)', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-root-safe-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        // 1. Persistence root is 0755
        await chmod(persistenceRoot, 0o755)
        const res1 = await runCliProcess(baseArgs)
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: persistence_root_invalid')
        await chmod(persistenceRoot, 0o700)

        // 2. Persistence root is symlink
        const symlinkRoot = join(tempBase, 'symlink-root')
        await symlink(persistenceRoot, symlinkRoot)
        const res2 = await runCliProcess([
          '--authorization', authPath,
          '--persistence-root', symlinkRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ])
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: persistence_root_invalid')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects overwriting existing output file (no-overwrite)', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-no-overwrite-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')
        writeFileSync(outputPath, 'existing content')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        const res = await runCliProcess(baseArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: output_file_exists')
        expect(readFileSync(outputPath, 'utf8')).toBe('existing content')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects output path when an ancestor directory is a symlink', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-anc-sym-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

        // Create ancestor-real directory and a sub directory inside it
        const ancestorReal = join(tempBase, 'ancestor-real')
        await mkdir(ancestorReal, { recursive: true, mode: 0o700 })
        const subDir = join(ancestorReal, 'sub-dir')
        await mkdir(subDir, { recursive: true, mode: 0o700 })

        // Create symlink ancestor-sym -> ancestor-real
        const ancestorSym = join(tempBase, 'ancestor-sym')
        await symlink(ancestorReal, ancestorSym)

        // Output path is inside ancestorSym/sub-dir/approval.json
        const symOutputPath = join(ancestorSym, 'sub-dir', 'approval.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', symOutputPath,
        ]

        const res = await runCliProcess(baseArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: output_path_invalid')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('detects pre-publish output directory inode replacement and fails loud with zero target written', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-devino-pre-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

        const outputDir = join(tempBase, 'out-dir')
        await mkdir(outputDir, { recursive: true, mode: 0o700 })
        const backupDir = join(tempBase, 'out-dir-backup')
        const outputPath = join(outputDir, 'approval.json')

        const { createRealCanaryApprovalCli, __setApprovalTestHooksForTest } = await import(
          '../scripts/m05d2-create-approval.js'
        )

        __setApprovalTestHooksForTest({
          beforePublishLink: async () => {
            const { rename } = await import('node:fs/promises')
            await rename(outputDir, backupDir)
            await mkdir(outputDir, { mode: 0o700 })
          },
        })

        await expect(
          createRealCanaryApprovalCli({
            authorization,
            persistence_root: persistenceRoot,
            decision: 'approved',
            subject_id: 'operator_01',
            now: '2026-08-21T00:15:00Z',
            output_path: outputPath,
          })
        ).rejects.toThrow()

        // Zero target in outputDir
        const entries = await readdir(outputDir)
        expect(entries).toHaveLength(0)
      } finally {
        const { __setApprovalTestHooksForTest } = await import('../scripts/m05d2-create-approval.js')
        __setApprovalTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('detects post-publish output directory inode replacement and fails loud while retaining published target in backup', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-devino-post-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

        const outputDir = join(tempBase, 'out-dir')
        await mkdir(outputDir, { recursive: true, mode: 0o700 })
        const backupDir = join(tempBase, 'out-dir-backup')
        const outputPath = join(outputDir, 'approval.json')

        const { createRealCanaryApprovalCli, __setApprovalTestHooksForTest } = await import(
          '../scripts/m05d2-create-approval.js'
        )

        __setApprovalTestHooksForTest({
          afterPublishLink: async () => {
            const { rename } = await import('node:fs/promises')
            await rename(outputDir, backupDir)
            await mkdir(outputDir, { mode: 0o700 })
          },
        })

        await expect(
          createRealCanaryApprovalCli({
            authorization,
            persistence_root: persistenceRoot,
            decision: 'approved',
            subject_id: 'operator_01',
            now: '2026-08-21T00:15:00Z',
            output_path: outputPath,
          })
        ).rejects.toThrow()

        // Target must be preserved in backupDir
        const backupTarget = join(backupDir, 'approval.json')
        const st = await lstat(backupTarget)
        expect(st.isFile()).toBe(true)
        expect(st.isSymbolicLink()).toBe(false)
        expect(st.mode & 0o777).toBe(0o600)

        // New outputDir has zero entries
        const entries = await readdir(outputDir)
        expect(entries).toHaveLength(0)
      } finally {
        const { __setApprovalTestHooksForTest } = await import('../scripts/m05d2-create-approval.js')
        __setApprovalTestHooksForTest(null)
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. Successful Approval Creation & Sanitized Output', () => {
    it('creates approved Approval Receipt with canonical formatting, 0600 mode, and zero secrets', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-success-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'approved',
          '--subject-id', 'operator_01',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
        ]

        const res = await runCliProcess(baseArgs)
        expect(res.exitCode).toBe(0)
        expect(res.stderr).toBe('')

        const expectedExecutionRootHash = sha256(resolve(persistenceRoot))
        expect(res.stdout).toContain('=== DSH Mnemosyne M0.5D-D2 Create Approval ===')
        expect(res.stdout).toContain('Status: created')
        expect(res.stdout).toContain(`Authorization SHA-256: ${authorization.authorization_sha256}`)
        expect(res.stdout).toContain('Decision: approved')
        expect(res.stdout).toContain('Subject ID: operator_01')
        expect(res.stdout).toContain(`Execution Root SHA-256: ${expectedExecutionRootHash}`)

        // Minimized output: no secrets, no absolute paths in stdout
        expect(res.stdout).not.toContain(tempBase)
        expect(res.stdout).not.toContain('sk-secret-sentinel')

        // Verify output file content
        const savedContent = readFileSync(outputPath, 'utf8')
        const parsed = JSON.parse(savedContent)
        const validated = validateRealCanaryApprovalReceipt(parsed)
        expect(validated.decision).toBe('approved')
        expect(validated.subject_id).toBe('operator_01')
        expect(validated.decided_at).toBe('2026-08-21T00:15:00Z')
        expect(validated.execution_root_sha256).toBe(expectedExecutionRootHash)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('creates rejected Approval Receipt with --json output', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-app-cli-rejected-json-'))
      try {
        const { authorization } = await createGateFixture(tempBase)
        const authPath = join(tempBase, 'auth.json')
        writeFileSync(authPath, JSON.stringify(authorization))

        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(tempBase, 'approval_rejected.json')

        const baseArgs = [
          '--authorization', authPath,
          '--persistence-root', persistenceRoot,
          '--decision', 'rejected',
          '--subject-id', 'operator_02',
          '--now', '2026-08-21T00:15:00Z',
          '--output', outputPath,
          '--json',
        ]

        const res = await runCliProcess(baseArgs)
        expect(res.exitCode).toBe(0)
        expect(res.stderr).toBe('')

        const parsedOutput = JSON.parse(res.stdout.trim())
        expect(parsedOutput.status).toBe('created')
        expect(parsedOutput.decision).toBe('rejected')
        expect(parsedOutput.subject_id).toBe('operator_02')
        expect(parsedOutput.authorization_sha256).toBe(authorization.authorization_sha256)
        expect(parsedOutput.execution_root_sha256).toBe(sha256(resolve(persistenceRoot)))
        expect(parsedOutput.approval_sha256).toMatch(/^sha256_[a-z0-9]{64}$/)

        const savedContent = readFileSync(outputPath, 'utf8')
        const parsed = JSON.parse(savedContent)
        const validated = validateRealCanaryApprovalReceipt(parsed)
        expect(validated.decision).toBe('rejected')
        expect(validated.subject_id).toBe('operator_02')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
