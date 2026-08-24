import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, mkdir, realpath, chmod, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import { canonicalHash, sha256 } from '../src/protocol/canonical.js'
import { runM05F1PlanningGate } from '../src/m05f/authorization.js'
import { createRealCanaryApprovalReceipt } from '../src/m05d2/approval.js'
import { validateExecutionWorld } from '../src/m05d2/runner.js'
import { loadM05Dv2Fixtures } from '../src/m05d/index.js'
import { createCanaryPlan } from '../src/m05e/index.js'
import { main, runRealCanaryPreflight } from '../scripts/m05d2-real-canary.js'

const execFileAsync = promisify(execFile)
const defaultFixtures = await loadM05Dv2Fixtures()

describe('M0.5D-D2 Preflight CLI Process-level & Argument Parsing', () => {
  let cliTempDir: string
  let cliBundlePath: string

  beforeAll(async () => {
    const base = await realpath(tmpdir())
    cliTempDir = await mkdtemp(join(base, 'dsh-preflight-cli-bundle-'))
    await writeFile(join(cliTempDir, 'package.json'), JSON.stringify({ name: 'test-cli-bundle', version: '0.0.0' }))
    await symlink(resolve(process.cwd(), 'node_modules'), join(cliTempDir, 'node_modules'))
    const outDir = join(cliTempDir, 'bin')
    await mkdir(outDir)
    await build({
      entry: [resolve(process.cwd(), 'scripts/m05d2-real-canary.ts')],
      outDir,
      format: 'esm',
      dts: false,
    })
    cliBundlePath = join(outDir, 'm05d2-real-canary.mjs')
  })

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

  function getDirectoryFingerprint(dirPath: string): Map<string, { size: number; contentHash: string }> {
    const map = new Map<string, { size: number; contentHash: string }>()
    function traverse(current: string, relative: string) {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(current, entry.name)
        const rel = join(relative, entry.name)
        if (entry.isDirectory()) {
          traverse(full, rel)
        } else if (entry.isFile()) {
          const content = readFileSync(full)
          map.set(rel, { size: content.length, contentHash: sha256(content.toString('utf8')) })
        }
      }
    }
    traverse(dirPath, '')
    return map
  }

  describe('1. Pure Functions and Host Process Invariants', () => {
    it('validates execution world inputs tightening (workspace_root required, no process.cwd fallback)', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-world-ws-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        // Missing workspace_root
        await expect(
          validateExecutionWorld({
            audit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:20:00Z',
            persistence_root: persistenceRoot,
          } as any)
        ).rejects.toThrow()

        // Relative workspace_root
        await expect(
          validateExecutionWorld({
            audit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:20:00Z',
            persistence_root: persistenceRoot,
            workspace_root: './relative-workspace',
          })
        ).rejects.toThrow()
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('runRealCanaryPreflight is a pure function that does not call console.log and returns status ready', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-pure-preflight-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        let logCalls = 0
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
          logCalls++
        })

        try {
          const result = await runRealCanaryPreflight({
            audit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:20:00Z',
            persistence_root: persistenceRoot,
            workspace_root: process.cwd(),
          })

          expect(result.status).toBe('ready')
          expect(result.auditSha256).toBe(audit.audit_sha256)
          expect(result.fixtureManifestSha256).toBe(plan.fixture_manifest_sha256)
          expect(result.m05ePlanSha256).toBe(plan.m05e_canary_plan_sha256)
          expect(logCalls).toBe(0) // MUST be a pure function without console.log
        } finally {
          logSpy.mockRestore()
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('main(argv) as a callable function returns 0/1 without setting process.exitCode or calling process.exit', async () => {
      const originalExitCode = process.exitCode
      try {
        process.exitCode = undefined

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const code = await main([])
        expect(code).toBe(1)
        expect(process.exitCode).toBeUndefined() // MUST NOT set process.exitCode
        errSpy.mockRestore()
      } finally {
        process.exitCode = originalExitCode
      }
    })
  })

  describe('2. Process-Level CLI Execution & Minimized Output Invariants', () => {
    it('executes preflight CLI successfully in human-readable and --json modes via real child process with zero leakage', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-cli-proc-success-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const auditPath = join(tempBase, 'audit.json')
        const planPath = join(tempBase, 'plan.json')
        const authPath = join(tempBase, 'auth.json')
        const approvalPath = join(tempBase, 'approval.json')

        writeFileSync(auditPath, JSON.stringify(audit, null, 2))
        writeFileSync(planPath, JSON.stringify(plan, null, 2))
        writeFileSync(authPath, JSON.stringify(authorization, null, 2))
        writeFileSync(approvalPath, JSON.stringify(approval, null, 2))

        const baseArgv = [
          '--audit', auditPath,
          '--plan', planPath,
          '--authorization', authPath,
          '--approval', approvalPath,
          '--persistence-root', persistenceRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]

        // Human-readable mode
        const humanRes = await runCliProcess(baseArgv)
        expect(humanRes.exitCode).toBe(0)
        expect(humanRes.stderr).toBe('')

        const humanOut = humanRes.stdout
        expect(humanOut).toContain('=== DSH Mnemosyne M0.5D-D2 Real Canary Preflight ===')
        expect(humanOut).toContain('Status: ready')
        expect(humanOut).toContain(`Audit SHA-256: ${audit.audit_sha256}`)
        expect(humanOut).toContain(`Plan SHA-256: ${plan.plan_sha256}`)
        expect(humanOut).toContain(`Authorization SHA-256: ${authorization.authorization_sha256}`)
        expect(humanOut).toContain(`Approval SHA-256: ${approval.approval_sha256}`)
        expect(humanOut).toContain(`Fixture Manifest SHA-256: ${plan.fixture_manifest_sha256}`)
        expect(humanOut).toContain(`M0.5E Plan SHA-256: ${plan.m05e_canary_plan_sha256}`)
        expect(humanOut).toContain(`Execution Root SHA-256: ${persistenceRootHash}`)

        // Minimized output: NO Authorization ID, Approval ID, Mode explanation string, paths, or secrets
        expect(humanOut).not.toContain('Authorization ID:')
        expect(humanOut).not.toContain('Approval ID:')
        expect(humanOut).not.toContain('Mode:')
        expect(humanOut).not.toContain(tempBase)
        expect(humanOut).not.toContain(process.cwd())
        expect(humanOut).not.toContain('/Users/')
        expect(humanOut).not.toContain('/home/')
        expect(humanOut).not.toContain('sk-secret-sentinel')
        expect(humanRes.stderr).not.toContain('sk-secret-sentinel')

        // JSON mode
        const jsonRes = await runCliProcess([...baseArgv, '--json'])
        expect(jsonRes.exitCode).toBe(0)
        expect(jsonRes.stderr).toBe('')

        const parsedJson = JSON.parse(jsonRes.stdout.trim())
        expect(parsedJson).toEqual({
          status: 'ready',
          audit_sha256: audit.audit_sha256,
          plan_sha256: plan.plan_sha256,
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          fixture_manifest_sha256: plan.fixture_manifest_sha256,
          m05e_plan_sha256: plan.m05e_canary_plan_sha256,
          execution_root_sha256: persistenceRootHash,
        })
        expect(jsonRes.stdout).not.toContain('authorization_id')
        expect(jsonRes.stdout).not.toContain('approval_id')
        expect(jsonRes.stdout).not.toContain('sk-secret-sentinel')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. Table-Driven CLI Child Process Argument Validation', () => {
    it('rejects malformed arguments, duplicate arguments, unknown arguments, and relative paths via child processes', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-cli-args-tbl-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const auditPath = join(tempBase, 'audit.json')
        const planPath = join(tempBase, 'plan.json')
        const authPath = join(tempBase, 'auth.json')
        const approvalPath = join(tempBase, 'approval.json')

        writeFileSync(auditPath, JSON.stringify(audit))
        writeFileSync(planPath, JSON.stringify(plan))
        writeFileSync(authPath, JSON.stringify(authorization))
        writeFileSync(approvalPath, JSON.stringify(approval))

        const validArgs = [
          '--audit', auditPath,
          '--plan', planPath,
          '--authorization', authPath,
          '--approval', approvalPath,
          '--persistence-root', persistenceRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]

        const testCases = [
          {
            name: 'missing --now argument',
            args: validArgs.slice(0, -2),
            expectedReason: 'missing_required_argument',
          },
          {
            name: 'missing --audit argument',
            args: validArgs.slice(2),
            expectedReason: 'missing_required_argument',
          },
          {
            name: 'missing --workspace-root argument',
            args: validArgs.filter((_, i) => i !== 10 && i !== 11),
            expectedReason: 'missing_required_argument',
          },
          {
            name: 'missing value for flag',
            args: [...validArgs.slice(0, -1)],
            expectedReason: 'missing_argument_value',
          },
          {
            name: 'flag value is another flag',
            args: ['--audit', '--plan', ...validArgs.slice(2)],
            expectedReason: 'missing_argument_value',
          },
          {
            name: 'duplicate --audit flag',
            args: [...validArgs, '--audit', auditPath],
            expectedReason: 'duplicate_argument',
          },
          {
            name: 'duplicate --json flag',
            args: [...validArgs, '--json', '--json'],
            expectedReason: 'duplicate_argument',
          },
          {
            name: 'unknown flag --evil-flag',
            args: [...validArgs, '--evil-flag', 'value'],
            expectedReason: 'unknown_argument',
            forbiddenInStderr: 'evil-flag',
          },
          {
            name: 'relative path in --audit',
            args: ['--audit', './audit.json', ...validArgs.slice(2)],
            expectedReason: 'relative_path_rejected',
            forbiddenInStderr: './audit.json',
          },
          {
            name: 'relative path traversal in --workspace-root',
            args: [
              ...validArgs.slice(0, 10),
              '--workspace-root', process.cwd() + '/src/../..',
              '--now', '2026-08-21T00:20:00Z',
            ],
            expectedReason: 'relative_path_rejected',
          },
          {
            name: 'invalid now timestamp (malformed string)',
            args: [...validArgs.slice(0, -1), 'not-a-timestamp'],
            expectedReason: 'invalid_now_timestamp',
          },
          {
            name: 'invalid now timestamp (invalid day in month)',
            args: [...validArgs.slice(0, -1), '2026-02-31T00:00:00Z'],
            expectedReason: 'invalid_now_timestamp',
          },
        ]

        for (const tc of testCases) {
          // Human mode
          const res = await runCliProcess(tc.args)
          expect(res.exitCode, `Human mode failure for ${tc.name}`).toBe(1)
          expect(res.stderr).toContain(tc.expectedReason)
          if (tc.forbiddenInStderr) {
            expect(res.stderr).not.toContain(tc.forbiddenInStderr)
          }

          // JSON mode
          const jsonRes = await runCliProcess([...tc.args, '--json'])
          expect(jsonRes.exitCode, `JSON mode failure for ${tc.name}`).toBe(1)
          expect(jsonRes.stderr).toContain(`"reason_code":"${tc.expectedReason}"`)
          expect(jsonRes.stderr).toContain('"status":"error"')
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('4. Table-Driven File Safety & Protocol Integrity via Child Processes', () => {
    it('rejects malformed, oversized (>1MB), symlink, non-object JSON, and protocol drift via child processes', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-cli-files-tbl-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const auditPath = join(tempBase, 'audit.json')
        const planPath = join(tempBase, 'plan.json')
        const authPath = join(tempBase, 'auth.json')
        const approvalPath = join(tempBase, 'approval.json')

        writeFileSync(auditPath, JSON.stringify(audit))
        writeFileSync(planPath, JSON.stringify(plan))
        writeFileSync(authPath, JSON.stringify(authorization))
        writeFileSync(approvalPath, JSON.stringify(approval))

        const baseArgs = [
          '--audit', auditPath,
          '--plan', planPath,
          '--authorization', authPath,
          '--approval', approvalPath,
          '--persistence-root', persistenceRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]

        // 1. Malformed JSON
        writeFileSync(planPath, '{"invalid_json": [missing bracket')
        const res1 = await runCliProcess(baseArgs)
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: malformed_json')
        expect(res1.stderr).not.toContain('invalid_json')

        // 2. Oversized file (>1MB)
        const oversized = { ...plan, padding: 'A'.repeat(1024 * 1024 + 10) }
        writeFileSync(planPath, JSON.stringify(oversized))
        const res2 = await runCliProcess(baseArgs)
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: oversized_file')

        // 3. Non-object JSON (array)
        writeFileSync(planPath, JSON.stringify([1, 2, 3]))
        const res3 = await runCliProcess(baseArgs)
        expect(res3.exitCode).toBe(1)
        expect(res3.stderr).toContain('Reason: invalid_json_object')

        // 4. Non-object JSON (primitive string)
        writeFileSync(planPath, JSON.stringify('just a string'))
        const res4 = await runCliProcess(baseArgs)
        expect(res4.exitCode).toBe(1)
        expect(res4.stderr).toContain('Reason: invalid_json_object')

        // 5. Input file is a symlink (rejected by O_NOFOLLOW)
        writeFileSync(planPath, JSON.stringify(plan))
        const realTargetAuth = join(tempBase, 'real-auth.json')
        writeFileSync(realTargetAuth, JSON.stringify(authorization))
        await rm(authPath, { force: true })
        await symlink(realTargetAuth, authPath)
        const res5 = await runCliProcess(baseArgs)
        expect(res5.exitCode).toBe(1)
        expect(res5.stderr).toContain('Reason: invalid_file_type')

        // 6. Input file is a directory
        await rm(authPath, { force: true })
        await mkdir(authPath, { recursive: true })
        const res6 = await runCliProcess(baseArgs)
        expect(res6.exitCode).toBe(1)
        expect(res6.stderr).toContain('Reason: invalid_file_type')

        // Restore auth file
        await rm(authPath, { recursive: true, force: true })
        writeFileSync(authPath, JSON.stringify(authorization))

        // 7. Non-existent file
        const nonExistentArgs = [
          '--audit', join(tempBase, 'does-not-exist.json'),
          ...baseArgs.slice(2),
        ]
        const res7 = await runCliProcess(nonExistentArgs)
        expect(res7.exitCode).toBe(1)
        expect(res7.stderr).toContain('Reason: file_read_error')

        // 8. Protocol mismatch: invalid audit object
        const badAudit = { ...audit, extra_evil_field: true }
        writeFileSync(auditPath, JSON.stringify(badAudit))
        const res8 = await runCliProcess(baseArgs)
        expect(res8.exitCode).toBe(1)
        expect(res8.stderr).toContain('Reason: invalid_audit_object')
        writeFileSync(auditPath, JSON.stringify(audit))

        // 9. Protocol mismatch: invalid plan object
        const badPlan = { ...plan, schema_version: 999 }
        writeFileSync(planPath, JSON.stringify(badPlan))
        const res9 = await runCliProcess(baseArgs)
        expect(res9.exitCode).toBe(1)
        expect(res9.stderr).toContain('Reason: invalid_plan_object')
        writeFileSync(planPath, JSON.stringify(plan))

        // 10. Protocol mismatch: invalid authorization object
        const badAuth = { ...authorization, created_at: 'not-valid' }
        writeFileSync(authPath, JSON.stringify(badAuth))
        const res10 = await runCliProcess(baseArgs)
        expect(res10.exitCode).toBe(1)
        expect(res10.stderr).toContain('Reason: invalid_authorization_object')
        writeFileSync(authPath, JSON.stringify(authorization))

        // 11. Protocol mismatch: invalid approval object
        const badApproval = { ...approval, decision: 'rejected' }
        writeFileSync(approvalPath, JSON.stringify(badApproval))
        const res11 = await runCliProcess(baseArgs)
        expect(res11.exitCode).toBe(1)
        expect(res11.stderr).toContain('Reason: invalid_approval_object')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('5. Table-Driven World Mismatch & Persistence Rejection via Child Processes', () => {
    it('rejects workspace facts mismatch and persistence root permissions/symlink/hash drift', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-cli-world-tbl-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      const emptyWorkspace = join(tempBase, 'empty-workspace')
      await mkdir(emptyWorkspace, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const auditPath = join(tempBase, 'audit.json')
        const planPath = join(tempBase, 'plan.json')
        const authPath = join(tempBase, 'auth.json')
        const approvalPath = join(tempBase, 'approval.json')

        writeFileSync(auditPath, JSON.stringify(audit))
        writeFileSync(planPath, JSON.stringify(plan))
        writeFileSync(authPath, JSON.stringify(authorization))
        writeFileSync(approvalPath, JSON.stringify(approval))

        const baseArgs = [
          '--audit', auditPath,
          '--plan', planPath,
          '--authorization', authPath,
          '--approval', approvalPath,
          '--persistence-root', persistenceRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]

        // 1. Empty workspace (workspace facts mismatch)
        const emptyWsArgs = [
          ...baseArgs.slice(0, 10),
          '--workspace-root', emptyWorkspace,
          '--now', '2026-08-21T00:20:00Z',
        ]
        const res1 = await runCliProcess(emptyWsArgs)
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: execution_world_mismatch')

        // 2. Approval execution_root_sha256 mismatch
        const wrongApproval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        })
        writeFileSync(approvalPath, JSON.stringify(wrongApproval))
        const res2 = await runCliProcess(baseArgs)
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: execution_world_mismatch')
        writeFileSync(approvalPath, JSON.stringify(approval))

        // 3. Persistence root mode 0755 rejected
        await chmod(persistenceRoot, 0o755)
        const res3 = await runCliProcess(baseArgs)
        expect(res3.exitCode).toBe(1)
        expect(res3.stderr).toContain('Reason: persistence_root_invalid')
        await chmod(persistenceRoot, 0o700)

        // 4. Persistence root is a symlink
        const symlinkRoot = join(tempBase, 'symlink-persistence')
        await symlink(persistenceRoot, symlinkRoot)
        const symlinkHash = sha256(resolve(symlinkRoot))
        const symlinkApproval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: symlinkHash,
        })
        writeFileSync(approvalPath, JSON.stringify(symlinkApproval))
        const symlinkArgs = [
          ...baseArgs.slice(0, 8),
          '--persistence-root', symlinkRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]
        const res4 = await runCliProcess(symlinkArgs)
        expect(res4.exitCode).toBe(1)
        expect(res4.stderr).toContain('Reason: persistence_root_invalid')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('6. Zero-Write and Zero-Network Invariants via Child Process', () => {
    it('guarantees zero writes and zero ambient network/secret access during real child process preflight', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-cli-zero-inv-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const auditPath = join(tempBase, 'audit.json')
        const planPath = join(tempBase, 'plan.json')
        const authPath = join(tempBase, 'auth.json')
        const approvalPath = join(tempBase, 'approval.json')

        writeFileSync(auditPath, JSON.stringify(audit, null, 2))
        writeFileSync(planPath, JSON.stringify(plan, null, 2))
        writeFileSync(authPath, JSON.stringify(authorization, null, 2))
        writeFileSync(approvalPath, JSON.stringify(approval, null, 2))

        const fingerprintBefore = getDirectoryFingerprint(tempBase)

        const argv = [
          '--audit', auditPath,
          '--plan', planPath,
          '--authorization', authPath,
          '--approval', approvalPath,
          '--persistence-root', persistenceRoot,
          '--workspace-root', process.cwd(),
          '--now', '2026-08-21T00:20:00Z',
        ]

        // Spawn child process with secret sentinel and invalid proxies
        const res = await runCliProcess(argv, {
          DEEPSEEK_API_KEY: 'sk-secret-sentinel',
          HTTP_PROXY: 'http://127.0.0.1:0',
          HTTPS_PROXY: 'http://127.0.0.1:0',
        })

        expect(res.exitCode).toBe(0)
        expect(res.stdout).not.toContain('sk-secret-sentinel')
        expect(res.stderr).not.toContain('sk-secret-sentinel')

        const fingerprintAfter = getDirectoryFingerprint(tempBase)

        // Exact match of every file and byte size
        expect(fingerprintAfter.size).toBe(fingerprintBefore.size)
        for (const [filePath, beforeInfo] of fingerprintBefore.entries()) {
          const afterInfo = fingerprintAfter.get(filePath)
          expect(afterInfo).toBeDefined()
          expect(afterInfo?.size).toBe(beforeInfo.size)
          expect(afterInfo?.contentHash).toBe(beforeInfo.contentHash)
        }

        // Persistence root contains zero written files
        expect(readdirSync(persistenceRoot)).toHaveLength(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
