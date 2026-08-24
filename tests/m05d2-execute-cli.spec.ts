import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, mkdir, realpath, chmod, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import { canonicalHash, sha256, containsSensitiveText } from '../src/protocol/canonical.js'
import { runM05F1PlanningGate } from '../src/m05f/authorization.js'
import { createRealCanaryApprovalReceipt, validateRealCanaryApprovalReceipt } from '../src/m05d2/approval.js'
import { validateRealCanaryReceipt, validateRealCanarySummary } from '../src/m05d2/runner.js'
import { loadM05Dv2Fixtures } from '../src/m05d/index.js'
import { createCanaryPlan } from '../src/m05e/index.js'
import { executeRealCanaryCli, main as runExecuteMain } from '../scripts/m05d2-execute-real-canary.js'

const execFileAsync = promisify(execFile)
const defaultFixtures = await loadM05Dv2Fixtures()

function makeSseStream(text: string, usage = { prompt_tokens: 10, completion_tokens: 20 }): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`
}

function makeToolCallStream(toolName: string, args: Record<string, unknown>, callId = 'call_mock'): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 15 } })}\n\ndata: [DONE]\n\n`
}

function extractAllMessageText(body: any): string {
  if (!body || !Array.isArray(body.messages)) return ''
  return body.messages
    .flatMap((m: any) => {
      if (typeof m.content === 'string') return [m.content]
      if (Array.isArray(m.content)) {
        return m.content.map((c: any) => c.text ?? '')
      }
      return []
    })
    .join('\n')
}

describe('M0.5D-D2-B1 Execution CLI: scripts/m05d2-execute-real-canary.ts', () => {
  let cliTempDir: string
  let cliBundlePath: string

  beforeAll(async () => {
    const base = await realpath(tmpdir())
    cliTempDir = await mkdtemp(join(base, 'dsh-execute-cli-bundle-'))
    await writeFile(join(cliTempDir, 'package.json'), JSON.stringify({ name: 'test-execute-cli-bundle', version: '0.0.0' }))
    await symlink(resolve(process.cwd(), 'node_modules'), join(cliTempDir, 'node_modules'))
    const outDir = join(cliTempDir, 'bin')
    await mkdir(outDir)
    await build({
      entry: [resolve(process.cwd(), 'scripts/m05d2-execute-real-canary.ts')],
      outDir,
      format: 'esm',
      dts: false,
    })
    cliBundlePath = join(outDir, 'm05d2-execute-real-canary.mjs')
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
    const env: Record<string, string | undefined> = {
      ...process.env,
      HTTP_PROXY: 'http://127.0.0.1:0',
      HTTPS_PROXY: 'http://127.0.0.1:0',
      http_proxy: 'http://127.0.0.1:0',
      https_proxy: 'http://127.0.0.1:0',
      ALL_PROXY: 'http://127.0.0.1:0',
      all_proxy: 'http://127.0.0.1:0',
      ...extraEnv,
    }
    if (!('DEEPSEEK_API_KEY' in extraEnv)) {
      delete env.DEEPSEEK_API_KEY
    }

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliBundlePath, ...args], {
        env,
        timeout: 25000,
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

  async function setupValidRunEnvironment(tempBase: string) {
    const { audit, plan, authorization } = await createGateFixture(tempBase)
    const persistenceRoot = join(tempBase, 'evidence-root')
    await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
    const persistenceRootHash = sha256(resolve(persistenceRoot))

    const approval = createRealCanaryApprovalReceipt({
      authorization,
      decision: 'approved',
      decided_at: '2026-08-21T00:15:00Z',
      subject_id: 'operator_01',
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

    // Create independent 0700 credential directory outside repo & workspace
    const credDir = join(tempBase, 'credentials-dir')
    await mkdir(credDir, { recursive: true, mode: 0o700 })
    const credStorePath = join(credDir, '.credentials.yaml')
    await writeFile(credStorePath, 'DEEPSEEK_API_KEY: sk-synthetic-key-for-test-only-12345678\n', { mode: 0o600 })

    const isolationRoot = join(tempBase, 'iso-root-for-exec')

    const baseArgs = [
      '--audit', auditPath,
      '--plan', planPath,
      '--authorization', authPath,
      '--approval', approvalPath,
      '--persistence-root', persistenceRoot,
      '--workspace-root', process.cwd(),
      '--isolation-root', isolationRoot,
      '--credential-store', credStorePath,
      '--now', '2026-08-21T00:20:00Z',
      '--confirm-approval-sha256', approval.approval_sha256,
      '--execute',
    ]

    return {
      audit,
      plan,
      authorization,
      approval,
      auditPath,
      planPath,
      authPath,
      approvalPath,
      persistenceRoot,
      persistenceRootHash,
      credDir,
      credStorePath,
      isolationRoot,
      baseArgs,
    }
  }

  describe('1. Confirmation Flags and Fail-Safe Rules', () => {
    it('without --execute fails with execution_not_confirmed and makes 0 claims', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-no-exec-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)
        const argsWithoutExecute = env.baseArgs.filter((a) => a !== '--execute')

        const res = await runCliProcess(argsWithoutExecute)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: execution_not_confirmed')

        const jsonRes = await runCliProcess([...argsWithoutExecute, '--json'])
        expect(jsonRes.exitCode).toBe(1)
        expect(jsonRes.stderr).toContain('"reason_code":"execution_not_confirmed"')

        // Assert 0 claims created in persistence root
        const claimsDir = join(env.persistenceRoot, 'claims')
        expect(existsSync(claimsDir)).toBe(false)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('with incorrect --confirm-approval-sha256 fails and makes 0 claims', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-bad-confirm-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)
        const wrongHash = 'sha256_0000000000000000000000000000000000000000000000000000000000000000'
        const badConfirmArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--confirm-approval-sha256' ? wrongHash : a))

        const res = await runCliProcess(badConfirmArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: confirm_approval_sha256_mismatch')

        const claimsDir = join(env.persistenceRoot, 'claims')
        expect(existsSync(claimsDir)).toBe(false)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('with missing required flags fails with missing_required_argument', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-missing-args-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)
        const requiredFlags = [
          '--audit',
          '--plan',
          '--authorization',
          '--approval',
          '--persistence-root',
          '--workspace-root',
          '--isolation-root',
          '--credential-store',
          '--now',
          '--confirm-approval-sha256',
        ]

        for (const flag of requiredFlags) {
          const idx = env.baseArgs.indexOf(flag)
          const dropped = env.baseArgs.filter((_, i) => i !== idx && i !== idx + 1)
          const res = await runCliProcess(dropped)
          expect(res.exitCode).toBe(1)
          expect(res.stderr).toContain('Reason: missing_required_argument')
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('2. Credential Store Isolation and Path Safety', () => {
    it('rejects credential store inside workspace or repository with credential_store_invalid', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-cred-ws-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        // Put credential store in workspace root
        const wsCredDir = join(process.cwd(), 'scratch-temp-cred')
        await mkdir(wsCredDir, { recursive: true, mode: 0o700 })
        const wsCredStore = join(wsCredDir, '.credentials.yaml')
        await writeFile(wsCredStore, 'DEEPSEEK_API_KEY: sk-test\n', { mode: 0o600 })

        try {
          const badArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--credential-store' ? wsCredStore : a))
          const res = await runCliProcess(badArgs)
          expect(res.exitCode).toBe(1)
          expect(res.stderr).toContain('Reason: credential_store_invalid')
        } finally {
          await rm(wsCredDir, { recursive: true, force: true }).catch(() => {})
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects credential store with non-0600 mode or parent non-0700 mode', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-cred-modes-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        // 1. File mode 0644
        await chmod(env.credStorePath, 0o644)
        const res1 = await runCliProcess(env.baseArgs)
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: credential_store_invalid')
        await chmod(env.credStorePath, 0o600)

        // 2. Parent directory mode 0755
        await chmod(env.credDir, 0o755)
        const res2 = await runCliProcess(env.baseArgs)
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: credential_store_invalid')
        await chmod(env.credDir, 0o700)

        // 3. Basename is not .credentials.yaml
        const wrongNameStore = join(env.credDir, 'my_keys.yaml')
        await writeFile(wrongNameStore, 'DEEPSEEK_API_KEY: sk-test\n', { mode: 0o600 })
        const badNameArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--credential-store' ? wrongNameStore : a))
        const res3 = await runCliProcess(badNameArgs)
        expect(res3.exitCode).toBe(1)
        expect(res3.stderr).toContain('Reason: credential_store_invalid')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects credential store if it is a symlink', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-cred-symlink-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        const realStore = join(env.credDir, 'real.yaml')
        await writeFile(realStore, 'DEEPSEEK_API_KEY: sk-test\n', { mode: 0o600 })
        await rm(env.credStorePath)
        await symlink(realStore, env.credStorePath)

        const res = await runCliProcess(env.baseArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: credential_store_invalid')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects isolation root if it already exists (must be non-existent)', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-iso-exists-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        // Pre-create isolation root
        await mkdir(env.isolationRoot, { recursive: true, mode: 0o700 })

        const res = await runCliProcess(env.baseArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: isolation_root_exists')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. Execution Fact Validation and Rejection Matrix', () => {
    it('rejects rejected or expired approval', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-rej-exp-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        // 1. Rejected approval
        const rejectedApproval = createRealCanaryApprovalReceipt({
          authorization: env.authorization,
          decision: 'rejected',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_01',
          execution_root_sha256: env.persistenceRootHash,
        })
        writeFileSync(env.approvalPath, JSON.stringify(rejectedApproval))

        const rejArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--confirm-approval-sha256' ? rejectedApproval.approval_sha256 : a))
        const res1 = await runCliProcess(rejArgs)
        expect(res1.exitCode).toBe(1)
        expect(res1.stderr).toContain('Reason: execution_world_mismatch')

        // 2. Expired authorization / execution time (now >= expires_at)
        writeFileSync(env.approvalPath, JSON.stringify(env.approval))
        const expiredArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--now' ? '2026-08-21T02:00:00Z' : a))
        const res2 = await runCliProcess(expiredArgs)
        expect(res2.exitCode).toBe(1)
        expect(res2.stderr).toContain('Reason: execution_world_mismatch')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects execution world mismatch on audit / plan / fixture drift', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-world-drift-'))
      try {
        const env = await setupValidRunEnvironment(tempBase)

        // Empty workspace directory causes world facts reconstruction to drift from audit
        const emptyWs = join(tempBase, 'empty-ws')
        await mkdir(emptyWs, { recursive: true, mode: 0o700 })

        const badWsArgs = env.baseArgs.map((a, i, arr) => (arr[i - 1] === '--workspace-root' ? emptyWs : a))
        const res = await runCliProcess(badWsArgs)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain('Reason: execution_world_mismatch')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('4. Official LocalCredentialProvider Integration and Fake Transport 6-Run Execution', () => {
    it('executes full 6-run fake canary with official LocalCredentialProvider and verifies Claim-before-resolve/network', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-full-e2e-'))
      const env = await setupValidRunEnvironment(tempBase)

      let transportCalls = 0
      let runIndex = 0
      let capturedAuthHeader: string | undefined
      let claimVerifiedBeforeTransport = false

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        transportCalls++

        const authHeader = opts.headers?.['authorization'] || opts.headers?.['Authorization'] || (opts.headers?.get ? opts.headers.get('authorization') : undefined)
        capturedAuthHeader = authHeader

        // Verify Claim was persisted on disk BEFORE the first transport call
        const claimsDir = join(env.persistenceRoot, 'claims')
        if (existsSync(claimsDir) && readdirSync(claimsDir).length === 1) {
          claimVerifiedBeforeTransport = true
        }

        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)
        const isAcq = allText.includes('Acquisition Request:')

        if (isAcq) {
          runIndex++
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'A deterministic candidate produced by fake transport during acquisition',
            redaction_status: 'passed',
          })
          return new Response(makeSseStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        if (runIndex === 2) {
          const hasFixture = allText.includes('fixture_task_build_recovery')
          const hasSearch = allText.includes('search_disclosure') || allText.includes('retrieval_ref') || allText.includes('memory_')
          const hasOpen = allText.includes('open_disclosure') || allText.includes('"body"')

          if (!hasFixture) {
            return new Response(makeToolCallStream('m05d_task_fixture', { task_id: 'task_build_recovery' }, 'call_fix'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }
          if (!hasSearch) {
            return new Response(makeToolCallStream('mnemosyne_search', { query: 'rebuild' }, 'call_search'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }
          if (!hasOpen) {
            const memoryId = defaultFixtures.catalog.memories[0].memory_id
            const retrievalMatch = allText.match(/"retrieval_ref":"([^"]+)"/)
            const shaMatch = allText.match(/"content_sha256":"([^"]+)"/)
            const retrievalId = retrievalMatch ? retrievalMatch[1] : 'retrieval_mock'
            const searchSha = shaMatch ? shaMatch[1] : 'sha256_mock'
            return new Response(makeToolCallStream('mnemosyne_open', { memory_id: memoryId, retrieval_id: retrievalId, search_disclosure_sha256: searchSha }, 'call_open'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }

          const memoryId = defaultFixtures.catalog.memories[0].memory_id
          const taskResponse = JSON.stringify({
            schema_version: 1,
            task_id: 'task_build_recovery',
            exit_code: 0,
            result: { rebuild_mode: 'targeted' },
            adopted_memory_ids: [memoryId],
            failure_code: null,
          })
          return new Response(makeSseStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const isControl = allText.includes('task_control_format')
        const hasFixture = allText.includes('fixture_')
        if (!hasFixture) {
          const taskId = isControl ? 'task_control_format' : 'task_build_recovery'
          return new Response(makeToolCallStream('m05d_task_fixture', { task_id: taskId }, 'call_fix_s9_other'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const memoryId = defaultFixtures.catalog.memories[0].memory_id
        const adoptedIds = runIndex === 4 ? [memoryId] : []
        const taskId = isControl ? 'task_control_format' : 'task_build_recovery'
        const result = isControl ? { controlled_field: 'alpha' } : { rebuild_mode: 'targeted' }
        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: taskId,
          exit_code: 0,
          result,
          adopted_memory_ids: adoptedIds,
          failure_code: null,
        })
        return new Response(makeSseStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

      try {
        const summary = await executeRealCanaryCli({
          audit: env.audit,
          plan: env.plan,
          authorization: env.authorization,
          approval: env.approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: env.persistenceRoot,
          workspace_root: process.cwd(),
          isolation_root: env.isolationRoot,
          credential_store: env.credStorePath,
          confirm_approval_sha256: env.approval.approval_sha256,
          is_execute: true,
        })

        expect(summary.status).toBe('real_provider_plumbing_pass')
        expect(summary.receipts).toHaveLength(6)
        expect(summary.reason_code).toBeNull()
        expect(summary.cleanup_clean).toBe(true)
        expect(summary.ledger.task_calls_claimed).toBe(14)
        expect(summary.ledger.acquisition_calls_claimed).toBe(6)
        expect(summary.ledger.total_calls_claimed).toBe(20)
        expect(summary.ledger.completed_calls).toBe(20)
        expect(summary.ledger.failed_calls).toBe(0)
        expect(transportCalls).toBe(20)

        // Verifications:
        // 1. Claim existed before any network request
        expect(claimVerifiedBeforeTransport).toBe(true)

        // 2. Key was parsed strictly by official LocalCredentialProvider and passed to transport
        expect(capturedAuthHeader).toBe('Bearer sk-synthetic-key-for-test-only-12345678')

        // 3. Isolation root directory was cleaned up
        expect(existsSync(env.isolationRoot)).toBe(false)

        // 4. Persistence root has 1 claim, 6 receipts, and summary.json
        const claims = readdirSync(join(env.persistenceRoot, 'claims'))
        expect(claims).toHaveLength(1)
        const receipts = readdirSync(join(env.persistenceRoot, 'receipts'))
        expect(receipts).toHaveLength(6)
        expect(existsSync(join(env.persistenceRoot, 'summary.json'))).toBe(true)

        // 5. Re-executing with the EXACT SAME Approval fails closed (Claim EEXIST)
        const isoRoot2 = join(tempBase, 'iso-root-2')
        await expect(
          executeRealCanaryCli({
            audit: env.audit,
            plan: env.plan,
            authorization: env.authorization,
            approval: env.approval,
            now: '2026-08-21T00:22:00Z',
            persistence_root: env.persistenceRoot,
            workspace_root: process.cwd(),
            isolation_root: isoRoot2,
            credential_store: env.credStorePath,
            confirm_approval_sha256: env.approval.approval_sha256,
            is_execute: true,
          })
        ).rejects.toThrow()

        // 6. Test main() function exit codes
        let errLogged = false
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
          errLogged = true
        })
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

        try {
          const codeFail = await runExecuteMain(env.baseArgs.filter((a) => a !== '--execute'))
          expect(codeFail).toBe(1)
          expect(errLogged).toBe(true)
        } finally {
          errSpy.mockRestore()
          logSpy.mockRestore()
        }
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    }, 20000)

    it('triggers circuit breaker and stops execution on 2 consecutive provider errors', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-breaker-'))
      const env = await setupValidRunEnvironment(tempBase)

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        transportCalls++
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          // Invalid candidate JSON (markdown wrapped) fails schema, causing 2nd consecutive error
          const badCandidate = '```json\n{"schema_version":1,"title":"T","summary":"S","redaction_status":"passed"}\n```'
          return new Response(makeSseStream(badCandidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        // Task call assertion fails (rebuild_mode mismatch), causing 1st consecutive error
        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
          result: { rebuild_mode: 'clean_rebuild' },
          adopted_memory_ids: [],
          failure_code: null,
        })
        return new Response(makeSseStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

      try {
        const summary = await executeRealCanaryCli({
          audit: env.audit,
          plan: env.plan,
          authorization: env.authorization,
          approval: env.approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: env.persistenceRoot,
          workspace_root: process.cwd(),
          isolation_root: env.isolationRoot,
          credential_store: env.credStorePath,
          confirm_approval_sha256: env.approval.approval_sha256,
          is_execute: true,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('circuit_open')
        expect(summary.receipts).toHaveLength(0) // 0 successful receipts
        expect(summary.ledger.failed_calls).toBe(2)
        expect(summary.ledger.consecutive_provider_or_protocol_errors).toBe(2)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('5. Sanitization and Secret Protection Invariants', () => {
    it('guarantees zero leakage of secrets, keys, prompts, models, or absolute paths in facts and outputs', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-sanitization-'))
      const env = await setupValidRunEnvironment(tempBase)

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)
        const isAcq = allText.includes('Acquisition Request:')

        if (isAcq) {
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'Deterministic clean candidate',
            redaction_status: 'passed',
          })
          return new Response(makeSseStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
          result: { rebuild_mode: 'targeted' },
          adopted_memory_ids: [],
          failure_code: null,
        })
        return new Response(makeSseStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

      try {
        const summary = await executeRealCanaryCli({
          audit: env.audit,
          plan: env.plan,
          authorization: env.authorization,
          approval: env.approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: env.persistenceRoot,
          workspace_root: process.cwd(),
          isolation_root: env.isolationRoot,
          credential_store: env.credStorePath,
          confirm_approval_sha256: env.approval.approval_sha256,
          is_execute: true,
        })

        const summaryJson = JSON.stringify(summary)
        expect(containsSensitiveText(summaryJson)).toBe(false)
        expect(summaryJson).not.toContain('sk-synthetic-key-for-test-only-12345678')
        expect(summaryJson).not.toContain(tempBase)
        expect(summaryJson).not.toContain(process.cwd())

        // Check receipts in persistence root
        const receiptsDir = join(env.persistenceRoot, 'receipts')
        if (existsSync(receiptsDir)) {
          for (const file of readdirSync(receiptsDir)) {
            const content = readFileSync(join(receiptsDir, file), 'utf8')
            expect(containsSensitiveText(content)).toBe(false)
            expect(content).not.toContain('sk-synthetic-key')
            expect(content).not.toContain(tempBase)
          }
        }
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('6. CTO Review 8.1: Credential Source Locking to Managed File (source=file)', () => {
    it('blocks execution when synthetic env shadows credential (source=env), verifies network=0 and no key leakage', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-exec-env-shadow-'))
      const env = await setupValidRunEnvironment(tempBase)

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        transportCalls++
        return new Response('', { status: 500 })
      })

      const originalEnv = process.env.DEEPSEEK_API_KEY
      try {
        // Set synthetic environment variable to shadow file
        process.env.DEEPSEEK_API_KEY = 'sk-shadow-env-key-should-be-blocked'

        const summary = await executeRealCanaryCli({
          audit: env.audit,
          plan: env.plan,
          authorization: env.authorization,
          approval: env.approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: env.persistenceRoot,
          workspace_root: process.cwd(),
          isolation_root: env.isolationRoot,
          credential_store: env.credStorePath,
          confirm_approval_sha256: env.approval.approval_sha256,
          is_execute: true,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('credential_unavailable')
        expect(summary.receipts).toHaveLength(0)
        expect(transportCalls).toBe(0)

        const summaryJson = JSON.stringify(summary)
        expect(summaryJson).not.toContain('sk-shadow-env-key')
        expect(summaryJson).not.toContain('sk-synthetic-key')
      } finally {
        if (originalEnv !== undefined) {
          process.env.DEEPSEEK_API_KEY = originalEnv
        } else {
          delete process.env.DEEPSEEK_API_KEY
        }
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('CLI process with synthetic env variable fails with exit code 1 and outputs credential_unavailable', async () => {
      const base = await realpath(tmpdir())
      const tempBase1 = await mkdtemp(join(base, 'dsh-exec-cli-env-text-'))
      const tempBase2 = await mkdtemp(join(base, 'dsh-exec-cli-env-json-'))
      try {
        const env1 = await setupValidRunEnvironment(tempBase1)
        const shadowKey = 'sk-shadow-cli-env-key-99999999'

        const res = await runCliProcess(env1.baseArgs, {
          DEEPSEEK_API_KEY: shadowKey,
        })

        expect(res.exitCode).toBe(1)
        expect(res.stdout).toContain('Reason Code: credential_unavailable')
        expect(res.stdout).not.toContain(shadowKey)
        expect(res.stderr).not.toContain(shadowKey)
        expect(res.stdout).not.toContain('sk-synthetic-key')

        const env2 = await setupValidRunEnvironment(tempBase2)
        const jsonRes = await runCliProcess([...env2.baseArgs, '--json'], {
          DEEPSEEK_API_KEY: shadowKey,
        })
        expect(jsonRes.exitCode).toBe(1)
        const parsed = JSON.parse(jsonRes.stdout.trim())
        expect(parsed.status).toBe('real_provider_plumbing_fail')
        expect(parsed.reason_code).toBe('credential_unavailable')
        expect(jsonRes.stdout).not.toContain(shadowKey)
        expect(jsonRes.stderr).not.toContain(shadowKey)
      } finally {
        await rm(tempBase1, { recursive: true, force: true }).catch(() => {})
        await rm(tempBase2, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
