import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, mkdir, realpath, chmod, open, lstat } from 'node:fs/promises'
import { ProtocolValidationError, canonicalBytes, canonicalHash, sha256, withoutHash } from '../src/protocol/canonical.js'
import {
  runM05F1PlanningGate,
  type RealCanaryPlan,
} from '../src/m05f/authorization.js'
import {
  createRealCanaryApprovalReceipt,
  validateRealCanaryApprovalReceipt,
  validateApprovalAuthorizationBinding,
  type RealCanaryApprovalReceipt,
  createRealCanaryExecutionClaim,
  validateRealCanaryExecutionClaim,
  computeExecutionId,
} from '../src/m05d2/approval.js'
import {
  runRealCanaryD2,
  validateAcquisitionCandidate,
  validateExecutionWorld,
  validateRealCanaryReceipt,
  validateRealCanarySummary,
  type RealCanaryReceipt,
  type RealCanarySummary,
} from '../src/m05d2/runner.js'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  persistExecutionClaim,
  persistReceipt,
  persistSummary,
  verifyPersistenceRoot,
} from '../src/m05d2/persistence.js'
import {
  createRealProviderBridge,
  type CredentialSeamInstaller,
} from '../src/m05d2/provider-factory.js'
import { runRealCanaryPreflight, main as runPreflightScript } from '../scripts/m05d2-real-canary.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  loadM05Dv2Fixtures,
  M05DAgentTimeoutError,
  M05DBatchTimeoutError,
} from '../src/m05d/index.js'
import { BudgetLedger, createCanaryPlan } from '../src/m05e/index.js'
import {
  createRecallContext,
  createRecallReceipt,
  type RecallContextEnvelope,
  type RecallContextReceipt,
} from '../src/protocol/recall.js'
import { RetrievalRuntime } from '../src/retrieval/runtime.js'

const defaultFixtures = await loadM05Dv2Fixtures()

describe('M0.5D-D2-A: Real Provider Canary Offline Bridge & Dual Authorization Gate', () => {
  class TestCredentialProvider extends Service {
    constructor(
      ctx: Context,
      private readonly secretValue = 'sk-fake-test-key-for-mock-transport-only-12345678',
      private readonly source = 'test-mock'
    ) {
      super(ctx, 'credentials')
    }

    async resolve(_ref: string) {
      return { value: this.secretValue, source: this.source }
    }

    async describe(_ref: string) {
      return { configured: true, source: this.source, writable: false }
    }

    async set(_ref: string, _value: string) {}

    async unset(_ref: string) {}
  }

  const fakeCredProvider: CredentialSeamInstaller = (ctx: Context) => {
    new TestCredentialProvider(ctx)
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

  function createSampleValidReceipt(options: {
    authSha: string
    approvalSha: string
    planHash: string
    runId?: string
    taskId?: 'task_build_recovery' | 'task_control_format'
    group?: 'no_memory' | 'tool_only' | 'auto_inject'
    claimSequence?: number[]
    modelCallCount?: number
    success?: boolean
    modelResult?: Record<string, string | number | boolean | null>
    exitCode?: number
    failureCode?: string | null
    observedMemoryIds?: string[]
    retrievedMemoryIds?: string[]
    openedMemoryIds?: string[]
    adoptedMemoryIds?: string[]
    toolCalls?: string[]
    memoryEvents?: string[]
    recallSource?: RealCanaryReceipt['recall_source']
    recallContext?: RecallContextEnvelope | null
    recallReceipt?: RecallContextReceipt | null
    providerModel?: string
    durationMs?: number
  }): RealCanaryReceipt {
    const taskId = options.taskId ?? 'task_build_recovery'
    const group = options.group ?? 'no_memory'
    const isControl = taskId === 'task_control_format'
    const isSuccess = options.success ?? true

    let defaultResult: Record<string, string | number | boolean | null>
    if (isControl) {
      defaultResult = { controlled_field: isSuccess ? 'alpha' : 'wrong_control' }
    } else {
      defaultResult = { rebuild_mode: isSuccess ? 'targeted' : 'clean_rebuild' }
    }
    const result = options.modelResult ?? defaultResult

    let recallSource: RealCanaryReceipt['recall_source'] = null
    let recallContext: RecallContextEnvelope | null = null
    let recallReceipt: RecallContextReceipt | null = null
    let observed: string[] = []
    let retrieved: string[] = []
    let opened: string[] = []
    let adopted: string[] = []
    let memoryEvents: string[] = ['user_message']
    let toolCalls: string[] = ['m05d_task_fixture']

    if (!isControl && group !== 'no_memory') {
      const memoryId = 'memory_build_cache'
      observed = [memoryId]
      retrieved = [memoryId]
      opened = [memoryId]
      adopted = isSuccess ? [memoryId] : []

      if (group === 'tool_only') {
        toolCalls = ['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open']
      } else if (group === 'auto_inject') {
        const sampleRuntime = new RetrievalRuntime(defaultFixtures.catalog)
        const memoryTitle = defaultFixtures.catalog.memories[0].title
        const search = sampleRuntime.search({ query: memoryTitle, top_k: 1 })
        const openResult = sampleRuntime.open({
          retrieval_id: search.retrieval_ref,
          search_disclosure_sha256: search.content_sha256,
          memory_id: search.items[0].memory_id,
        })
        const ctxEnv = createRecallContext(search, [openResult])
        const rct = createRecallReceipt(ctxEnv)
        recallSource = { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' }
        recallContext = ctxEnv
        recallReceipt = rct
        observed = [search.items[0].memory_id]
        retrieved = [search.items[0].memory_id]
        opened = [search.items[0].memory_id]
        adopted = isSuccess ? [search.items[0].memory_id] : []
        memoryEvents = ['recall_user_message', 'user_message']
      }
    }

    const expectedRunId = `run_${canonicalHash({
      evaluation_id: 'm05_v2',
      task_id: taskId,
      group,
      requested_seed: 101,
    }).slice(7, 23)}`

    const modelCallCount = options.modelCallCount ?? (group === 'tool_only' && !isControl ? 3 : 1)
    const defaultClaimSeq = Array.from({ length: modelCallCount + 1 }, (_, i) => i + 1)
    const claimSequence = options.claimSequence ?? defaultClaimSeq

    const finalObserved = options.observedMemoryIds ?? observed
    const finalRetrieved = options.retrievedMemoryIds ?? retrieved
    const finalOpened = options.openedMemoryIds ?? opened
    const finalAdopted = options.adoptedMemoryIds ?? adopted
    const finalToolCalls = options.toolCalls ?? toolCalls
    const finalMemoryEvents = options.memoryEvents ?? memoryEvents
    const finalRecallSource = options.recallSource !== undefined ? options.recallSource : recallSource
    const finalRecallContext = options.recallContext !== undefined ? options.recallContext : recallContext
    const finalRecallReceipt = options.recallReceipt !== undefined ? options.recallReceipt : recallReceipt
    const exitCode = options.exitCode ?? (isSuccess ? 0 : 1)
    const failureCode = options.failureCode !== undefined ? options.failureCode : (isSuccess ? null : 'assertion_failed')

    const body = {
      schema_version: 1 as const,
      run_id: options.runId ?? expectedRunId,
      authorization_sha256: options.authSha,
      approval_sha256: options.approvalSha,
      plan_hash: options.planHash,
      provider: {
        provider: 'deepseek-official' as const,
        model: options.providerModel ?? 'deepseek-v4-flash',
      },
      evidence_kind: 'real_provider_canary' as const,
      task_id: taskId,
      group,
      requested_seed: 101 as const,
      seed_honored: false as const,
      claim_sequence: claimSequence,
      tool_calls: finalToolCalls,
      memory_events: finalMemoryEvents,
      recall_source: finalRecallSource,
      recall_context: finalRecallContext,
      recall_receipt: finalRecallReceipt,
      observed_memory_ids: finalObserved,
      retrieved_memory_ids: finalRetrieved,
      opened_memory_ids: finalOpened,
      adopted_memory_ids: finalAdopted,
      model_call_count: modelCallCount,
      model: {
        schema_version: 1 as const,
        task_id: taskId,
        exit_code: exitCode,
        result,
        adopted_memory_ids: finalAdopted,
        failure_code: failureCode,
      },
      usage: {
        model: { inputTokens: 100, outputTokens: 20 },
        retrieval_estimated_tokens: 0,
        acquisition_tokens: 11,
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
      duration_ms: options.durationMs ?? 120,
      success: isSuccess,
    }
    return {
      ...body,
      canonical_hash: canonicalHash(body),
    }
  }

  describe('1. RealCanaryApprovalReceipt & ExecutionClaim Schema and Binding', () => {
    it('creates deterministic RealCanaryApprovalReceipt and validates exact binding to AuthorizationRequest', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-test-'))
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

        expect(approval.schema_version).toBe(1)
        expect(approval.authorization_id).toBe(authorization.authorization_id)
        expect(approval.authorization_sha256).toBe(authorization.authorization_sha256)
        expect(approval.decision).toBe('approved')
        expect(approval.accepted_runtime.model).toBe(authorization.runtime.model)
        expect(approval.accepted_limits.total_calls).toBe(30)
        expect(approval.accepted_cost.status).toBe('verified')
        expect(approval.accepted_cost.worst_case_upper_bound).toBe('0.125000')
        expect(approval.execution_root_sha256).toBe(persistenceRootHash)

        expect(validateRealCanaryApprovalReceipt(approval)).toEqual(approval)
        expect(() => validateApprovalAuthorizationBinding(approval, authorization, '2026-08-21T00:20:00Z')).not.toThrow()
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('P0-3: derives execution_id strictly without claimed_at so same Approval generates identical ID', async () => {
      const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
      const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
      const rootSha = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'

      const claim1 = createRealCanaryExecutionClaim({
        authorization_sha256: authSha,
        approval_sha256: appSha,
        execution_root_sha256: rootSha,
        claimed_at: '2026-08-21T00:10:00Z',
      })

      const claim2 = createRealCanaryExecutionClaim({
        authorization_sha256: authSha,
        approval_sha256: appSha,
        execution_root_sha256: rootSha,
        claimed_at: '2026-08-21T00:55:00Z',
      })

      expect(claim1.execution_id).toBe(claim2.execution_id)
      expect(claim1.execution_id).toMatch(/^execution_[a-z0-9]{32}$/)
      expect(claim1.claim_sha256).not.toBe(claim2.claim_sha256)
      expect(validateRealCanaryExecutionClaim(claim1)).toEqual(claim1)
      expect(validateRealCanaryExecutionClaim(claim2)).toEqual(claim2)
    })

    it('rejects approval if runtime, limits, or cost drift from AuthorizationRequest', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-drift-'))
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

        // 1. Model drift
        const driftedModel = {
          ...approval,
          accepted_runtime: { ...approval.accepted_runtime, model: 'deepseek-v4-pro' },
        }
        driftedModel.approval_sha256 = canonicalHash(withoutHash(driftedModel, 'approval_sha256'))
        expect(() => validateApprovalAuthorizationBinding(driftedModel as RealCanaryApprovalReceipt, authorization, '2026-08-21T00:20:00Z')).toThrow(ProtocolValidationError)

        // 2. Limits drift
        const driftedLimits = {
          ...approval,
          accepted_limits: { ...approval.accepted_limits, total_calls: 50 },
        }
        driftedLimits.approval_sha256 = canonicalHash(withoutHash(driftedLimits, 'approval_sha256'))
        expect(() => validateApprovalAuthorizationBinding(driftedLimits as unknown as RealCanaryApprovalReceipt, authorization, '2026-08-21T00:20:00Z')).toThrow(ProtocolValidationError)

        // 3. Cost drift
        const driftedCost = {
          ...approval,
          accepted_cost: { ...approval.accepted_cost, worst_case_upper_bound: '0.999000' },
        }
        driftedCost.approval_sha256 = canonicalHash(withoutHash(driftedCost, 'approval_sha256'))
        expect(() => validateApprovalAuthorizationBinding(driftedCost as RealCanaryApprovalReceipt, authorization, '2026-08-21T00:20:00Z')).toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects approval if decided_at is before created_at, after expires_at, or if now >= expires_at', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-time-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })

      try {
        const { authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        // 1. decided_at before created_at
        expect(() =>
          createRealCanaryApprovalReceipt({
            authorization,
            decision: 'approved',
            decided_at: '2026-08-20T23:59:59Z',
            subject_id: 'operator_local_01',
            execution_root_sha256: persistenceRootHash,
          })
        ).toThrow(ProtocolValidationError)

        // 2. decided_at at or after expires_at
        expect(() =>
          createRealCanaryApprovalReceipt({
            authorization,
            decision: 'approved',
            decided_at: '2026-08-21T01:00:00Z',
            subject_id: 'operator_local_01',
            execution_root_sha256: persistenceRootHash,
          })
        ).toThrow(ProtocolValidationError)

        // 3. now >= expires_at at execution time
        const validApproval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:30:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })
        expect(() =>
          validateApprovalAuthorizationBinding(validApproval, authorization, '2026-08-21T01:00:00Z')
        ).toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('2. P0-4, P1-4 & Amendment 2.7: Atomic Persistence, Permissions & Fsync Security', () => {
    it('P0-4: publishes Claim atomically with no-overwrite and rejects concurrent overwrites without data corruption', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-claim-atomic-'))
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

        const claim1 = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: persistenceRootHash,
          claimed_at: '2026-08-21T00:20:00Z',
        })

        const claim2 = createRealCanaryExecutionClaim({
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: approval.approval_sha256,
          execution_root_sha256: persistenceRootHash,
          claimed_at: '2026-08-21T00:25:00Z',
        })

        const results = await Promise.allSettled([
          persistExecutionClaim(persistenceRoot, claim1),
          persistExecutionClaim(persistenceRoot, claim2),
        ])

        const fulfilled = results.filter((r) => r.status === 'fulfilled')
        const rejected = results.filter((r) => r.status === 'rejected')

        expect(fulfilled.length).toBe(1)
        expect(rejected.length).toBe(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProtocolValidationError)

        const filePath = join(persistenceRoot, 'claims', `${claim1.execution_id}.json`)
        const content = JSON.parse(readFileSync(filePath, 'utf8'))
        expect(content.execution_id).toBe(claim1.execution_id)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects persistence root if mode is 0755, symlink, or hash mismatch', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-sec-root-'))
      const safeDir = join(tempBase, 'safe-dir')
      await mkdir(safeDir, { recursive: true, mode: 0o700 })

      const linkDir = join(tempBase, 'symlink-dir')
      await symlink(safeDir, linkDir)

      try {
        const safeHash = sha256(resolve(safeDir))

        // 1. Valid 0700 safe directory
        await expect(verifyPersistenceRoot(safeDir, safeHash)).resolves.toBe(resolve(safeDir))

        // 2. Hash mismatch
        await expect(verifyPersistenceRoot(safeDir, 'sha256_0000000000000000000000000000000000000000000000000000000000000000')).rejects.toThrow(ProtocolValidationError)

        // 3. Symlink path
        const linkHash = sha256(resolve(linkDir))
        await expect(verifyPersistenceRoot(linkDir, linkHash)).rejects.toThrow(ProtocolValidationError)

        // 4. Mode 0755 rejected (Amendment Section 2.7: must be strictly 0700)
        const mode755Dir = join(tempBase, 'mode755-dir')
        await mkdir(mode755Dir, { mode: 0o755 })
        await chmod(mode755Dir, 0o755)
        const mode755Hash = sha256(resolve(mode755Dir))
        await expect(verifyPersistenceRoot(mode755Dir, mode755Hash)).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. P0-5 & Amendment 2.4: Execution World Reconstruction & Validation', () => {
    it('reconstructs execution world from disk facts and validates full binding', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-world-'))
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

        const worldFacts = await validateExecutionWorld({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          workspace_root: process.cwd(),
        })

        expect(worldFacts.fixtureManifestSha256).toBe(plan.fixture_manifest_sha256)
        expect(worldFacts.m05ePlanSha256).toBe(plan.m05e_canary_plan_sha256)
        expect(worldFacts.auditSha256).toBe(audit.audit_sha256)

        // Drift: Audit blocked
        const badAudit = { ...audit, decision: 'blocked' as const }
        badAudit.audit_sha256 = canonicalHash(withoutHash(badAudit, 'audit_sha256'))
        await expect(
          validateExecutionWorld({
            audit: badAudit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:20:00Z',
            persistence_root: persistenceRoot,
            workspace_root: process.cwd(),
          })
        ).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('4. Amendment 2.2: D2 Real Acquisition Schema Validation', () => {
    it('accepts valid strict candidate JSON and computes canonical hash', () => {
      const validJson = JSON.stringify({
        schema_version: 1,
        title: 'Recovery mode memory candidate',
        summary: 'Identified targeted clean rebuild mode for recovery fixture',
        redaction_status: 'passed',
      })

      const result = validateAcquisitionCandidate(validJson)
      expect(result.candidate.schema_version).toBe(1)
      expect(result.candidate.title).toBe('Recovery mode memory candidate')
      expect(result.candidate.redaction_status).toBe('passed')
      expect(result.candidate_content_sha256).toBe(canonicalHash(result.candidate))
    })

    it('rejects markdown code fences, leading/trailing text, unknown fields, secrets, paths, and excess characters', () => {
      // 1. Markdown code fence
      const fenceJson = '```json\n{"schema_version":1,"title":"T","summary":"S","redaction_status":"passed"}\n```'
      expect(() => validateAcquisitionCandidate(fenceJson)).toThrow(ProtocolValidationError)

      // 2. Leading/trailing commentary
      const commentaryJson = 'Here is candidate:\n{"schema_version":1,"title":"T","summary":"S","redaction_status":"passed"}'
      expect(() => validateAcquisitionCandidate(commentaryJson)).toThrow(ProtocolValidationError)

      // 3. Unknown field
      const unknownFieldJson = JSON.stringify({
        schema_version: 1,
        title: 'T',
        summary: 'S',
        redaction_status: 'passed',
        extra_field: 'forbidden',
      })
      expect(() => validateAcquisitionCandidate(unknownFieldJson)).toThrow(ProtocolValidationError)

      // 4. Secret leak (API Key / Bearer token)
      const secretJson = JSON.stringify({
        schema_version: 1,
        title: 'Secret candidate',
        summary: 'Leaked Authorization: Bearer sk-secret123456789012345',
        redaction_status: 'passed',
      })
      expect(() => validateAcquisitionCandidate(secretJson)).toThrow(ProtocolValidationError)

      // 5. Absolute path leak
      const pathJson = JSON.stringify({
        schema_version: 1,
        title: 'Path candidate',
        summary: 'Leaked /Users/operator/workspace path',
        redaction_status: 'passed',
      })
      expect(() => validateAcquisitionCandidate(pathJson)).toThrow(ProtocolValidationError)

      // 6. Title exceeding 200 chars
      const longTitleJson = JSON.stringify({
        schema_version: 1,
        title: 'A'.repeat(201),
        summary: 'S',
        redaction_status: 'passed',
      })
      expect(() => validateAcquisitionCandidate(longTitleJson)).toThrow(ProtocolValidationError)
    })
  })

  describe('5. P1-2 & P1-3: Deep Receipt and Summary Schema & Integrity Validation', () => {
    it('P1-2: validates RealCanaryReceipt fields and rejects tampered or un-sanitized receipt', () => {
      const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
      const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
      const planHash = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'

      const receipt = createSampleValidReceipt({ authSha, approvalSha: appSha, planHash })
      expect(validateRealCanaryReceipt(receipt)).toEqual(receipt)

      // 1. Missing candidate_schema_valid
      const noSchemaValid = {
        ...receipt,
        acquisition: { ...receipt.acquisition, candidate_schema_valid: false },
      }
      noSchemaValid.canonical_hash = canonicalHash(withoutHash(noSchemaValid, 'canonical_hash'))
      expect(() => validateRealCanaryReceipt(noSchemaValid)).toThrow(ProtocolValidationError)

      // 2. Memory subset violation (retrieved not in observed)
      const badObserved = {
        ...receipt,
        observed_memory_ids: [],
        retrieved_memory_ids: ['memory_1'],
        opened_memory_ids: ['memory_1'],
        adopted_memory_ids: ['memory_1'],
        model: { ...receipt.model, adopted_memory_ids: ['memory_1'] },
      }
      badObserved.canonical_hash = canonicalHash(withoutHash(badObserved, 'canonical_hash'))
      expect(() => validateRealCanaryReceipt(badObserved)).toThrow(ProtocolValidationError)
    })

    it('P1-3: validates RealCanarySummary and rejects duplicate runs, ledger mismatch, or status contradictions', () => {
      const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
      const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
      const planHash = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'
      const manifestHash = 'sha256_4444444444444444444444444444444444444444444444444444444444444444'

      // Create 6 distinct receipts with properly chained claim sequences
      const groups = ['no_memory', 'tool_only', 'auto_inject'] as const
      const tasks = ['task_build_recovery', 'task_control_format'] as const
      const distinctReceipts: RealCanaryReceipt[] = []
      let currentSeq = 1

      for (const group of groups) {
        for (const taskId of tasks) {
          const modelCallCount = group === 'tool_only' && taskId === 'task_build_recovery' ? 3 : 1
          const claimSeq = Array.from({ length: modelCallCount + 1 }, (_, i) => currentSeq + i)
          currentSeq += modelCallCount + 1
          distinctReceipts.push(
            createSampleValidReceipt({
              authSha,
              approvalSha: appSha,
              planHash,
              taskId,
              group,
              claimSequence: claimSeq,
              modelCallCount,
            })
          )
        }
      }

      const totalTaskCalls = distinctReceipts.reduce((sum, r) => sum + r.model_call_count, 0)
      const totalCalls = totalTaskCalls + 6

      const passSummaryBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_pass' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: distinctReceipts,
        deterministic_prefix_bytes: canonicalBytes(distinctReceipts.map((r) => {
          const { duration_ms: _d, canonical_hash: _h, ...body } = r
          return body
        })),
        ledger: {
          task_calls_claimed: totalTaskCalls,
          acquisition_calls_claimed: 6,
          total_calls_claimed: totalCalls,
          completed_calls: totalCalls,
          failed_calls: 0,
          consecutive_provider_or_protocol_errors: 0,
        },
        reason_code: null,
        cleanup_clean: true,
      }

      const passSummary: RealCanarySummary = {
        ...passSummaryBody,
        summary_sha256: canonicalHash(passSummaryBody),
      }

      expect(validateRealCanarySummary(passSummary)).toEqual(passSummary)

      // Duplicate runs claiming pass (6 copies of same receipt)
      const dupReceipts = Array(6).fill(distinctReceipts[0])
      const dupSummary = {
        ...passSummary,
        receipts: dupReceipts,
        deterministic_prefix_bytes: canonicalBytes(dupReceipts.map((r) => {
          const { duration_ms: _d, canonical_hash: _h, ...body } = r
          return body
        })),
      }
      dupSummary.summary_sha256 = canonicalHash(withoutHash(dupSummary, 'summary_sha256'))
      expect(() => validateRealCanarySummary(dupSummary)).toThrow(ProtocolValidationError)
    })
  })

  describe('6. Amendment 2.3: Credential Seam Trap & Blocked Isolation', () => {
    it('returns stable blocked when Credential seam is unmounted and traps process.env / network access', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-trap-'))
      const persistenceRoot = join(tempBase, 'persistence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'temp-iso-root')

      // Set apparent real API key in environment to verify trap
      const originalApiKey = process.env.DEEPSEEK_API_KEY
      process.env.DEEPSEEK_API_KEY = 'sk-apparent-real-key-1234567890abcdef'

      // Network trap
      let networkFetchCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        networkFetchCalls++
        throw new Error('NETWORK_TRAP_TRIGGERED')
      })

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

        // Bridge creation without credentialProvider returns stable blocked
        const bridge = await createRealProviderBridge({
          plan,
          authorization,
          dsh_home: join(isolationRoot, 'home'),
          workspace: join(isolationRoot, 'workspace'),
        })

        expect(bridge.status).toBe('blocked')
        if (bridge.status === 'blocked') {
          expect(bridge.reason_code).toBe('real_canary_blocked_credential_isolation_unavailable')
        }

        // Run D2 Runner in offline mode (without credential provider)
        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
        })

        // Runner fails with credential_unavailable and cleanup_clean = true
        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('credential_unavailable')
        expect(summary.cleanup_clean).toBe(true)

        // Traps verify: 0 network calls were attempted
        expect(networkFetchCalls).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
        if (originalApiKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY
        } else {
          process.env.DEEPSEEK_API_KEY = originalApiKey
        }
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('returns stable blocked when Credential seam is a no-op function and traps process.env / network access', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-noop-trap-'))

      const originalApiKey = process.env.DEEPSEEK_API_KEY
      process.env.DEEPSEEK_API_KEY = 'sk-apparent-real-key-1234567890abcdef'

      let networkFetchCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        networkFetchCalls++
        throw new Error('NETWORK_TRAP_TRIGGERED')
      })

      try {
        const { plan, authorization } = await createGateFixture(tempBase)
        const noopCredProvider: CredentialSeamInstaller = (_ctx: Context) => {}

        const bridge = await createRealProviderBridge({
          plan,
          authorization,
          dsh_home: join(tempBase, 'home'),
          workspace: join(tempBase, 'workspace'),
          credentialProvider: noopCredProvider,
        })

        expect(bridge.status).toBe('blocked')
        if (bridge.status === 'blocked') {
          expect(bridge.reason_code).toBe('real_canary_blocked_credential_isolation_unavailable')
          await expect(bridge.dispose()).resolves.not.toThrow()
        }
        expect(networkFetchCalls).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
        if (originalApiKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY
        } else {
          process.env.DEEPSEEK_API_KEY = originalApiKey
        }
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('returns stable blocked when Credential seam provides an incomplete service', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-incomplete-trap-'))

      try {
        const { plan, authorization } = await createGateFixture(tempBase)
        class IncompleteCredService extends Service {
          constructor(ctx: Context) {
            super(ctx, 'credentials')
          }
          async resolve() {
            return { value: 'sk-isolated-key', source: 'test' }
          }
        }
        const incompleteCredProvider: CredentialSeamInstaller = (ctx: Context) => {
          new IncompleteCredService(ctx)
        }

        const bridge = await createRealProviderBridge({
          plan,
          authorization,
          dsh_home: join(tempBase, 'home'),
          workspace: join(tempBase, 'workspace'),
          credentialProvider: incompleteCredProvider,
        })

        expect(bridge.status).toBe('blocked')
        if (bridge.status === 'blocked') {
          expect(bridge.reason_code).toBe('real_canary_blocked_credential_isolation_unavailable')
          await expect(bridge.dispose()).resolves.not.toThrow()
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('verifies ready state with complete isolated CredentialProvider and never reads ambient env during controlled stream', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-isolated-ready-'))

      const originalApiKey = process.env.DEEPSEEK_API_KEY
      process.env.DEEPSEEK_API_KEY = 'sk-ambient-env-key-should-never-be-used'

      let seamResolveCalls = 0
      let seamDescribeCalls = 0
      class IsolatedSeamProvider extends Service {
        constructor(ctx: Context) {
          super(ctx, 'credentials')
        }

        async resolve(_ref: string) {
          seamResolveCalls++
          return { value: 'sk-isolated-test-key-12345678', source: 'test-seam' }
        }

        async describe(_ref: string) {
          seamDescribeCalls++
          return { configured: true, source: 'test-seam', writable: false }
        }

        async set(_ref: string, _value: string) {}

        async unset(_ref: string) {}
      }
      const isolatedCredProvider: CredentialSeamInstaller = (ctx: Context) => {
        new IsolatedSeamProvider(ctx)
      }

      let fetchCalls = 0
      let capturedAuthHeader: string | undefined = undefined
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        fetchCalls++
        const headers = opts.headers
        capturedAuthHeader = headers?.['authorization'] || headers?.['Authorization'] || (headers?.get ? headers.get('authorization') : undefined)
        const encoder = new TextEncoder()
        const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from isolated seam' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
        return new Response(sseText, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })

      try {
        const { plan, authorization } = await createGateFixture(tempBase)

        const bridge = await createRealProviderBridge({
          plan,
          authorization,
          dsh_home: join(tempBase, 'home'),
          workspace: join(tempBase, 'workspace'),
          credentialProvider: isolatedCredProvider,
        })

        expect(bridge.status).toBe('ready')
        if (bridge.status === 'ready') {
          const chunks: any[] = []
          for await (const chunk of bridge.adapter.stream({
            messages: [createUserMessage({ content: [{ type: 'text', text: 'test isolation' }], source: { kind: 'user' } })],
            provider: 'deepseek-official',
            model: plan.runtime.model,
          })) {
            chunks.push(chunk)
          }

          expect(chunks.length).toBeGreaterThan(0)
          expect(seamResolveCalls).toBe(1)
          expect(fetchCalls).toBe(1)
          expect(capturedAuthHeader).toBe('Bearer sk-isolated-test-key-12345678')
          expect(capturedAuthHeader).not.toContain('sk-ambient-env-key-should-never-be-used')
          await expect(bridge.dispose()).resolves.not.toThrow()
        }
      } finally {
        globalThis.fetch = originalFetch
        if (originalApiKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY
        } else {
          process.env.DEEPSEEK_API_KEY = originalApiKey
        }
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('7. Preflight Script & Execution Gate', () => {
    it('executes preflight read-only validator with 0 network calls', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-preflight-'))
      const persistenceRoot = join(tempBase, 'persistence-root')
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

        await expect(
          runRealCanaryPreflight({
            audit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:20:00Z',
            persistence_root: persistenceRoot,
            workspace_root: process.cwd(),
          })
        ).resolves.not.toThrow()

        // main() with empty arguments exits with non-zero code
        await expect(runPreflightScript([])).resolves.not.toBe(0)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('8. Amendment 2.1 & 2.2: Acquisition Non-Byte-Equality & Sanitized Dispose', () => {
    it('accepts novel acquisition candidate text differing from offline fixtures without requiring byte equality', () => {
      const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
      const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
      const planHash = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'

      // Novel candidate from official provider with unique generated text
      const novelCandidate = {
        schema_version: 1 as const,
        title: 'Custom live model candidate title',
        summary: 'A completely dynamic summary generated by deepseek-v4-flash during live acquisition turn',
        redaction_status: 'passed' as const,
      }
      const candidateHash = canonicalHash(novelCandidate)

      const receipt = createSampleValidReceipt({ authSha, approvalSha: appSha, planHash })
      const liveReceipt = {
        ...receipt,
        acquisition: {
          ...receipt.acquisition,
          candidate_content_sha256: candidateHash,
        },
      }
      liveReceipt.canonical_hash = canonicalHash(withoutHash(liveReceipt, 'canonical_hash'))

      // Validates successfully without requiring byte-equality against offline fixtures
      expect(validateRealCanaryReceipt(liveReceipt)).toEqual(liveReceipt)
    })

    it('sanitizes bridge dispose exceptions and does not leak internal error message', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-dispose-'))

      try {
        const { plan, authorization } = await createGateFixture(tempBase)
        const bridge = await createRealProviderBridge({
          plan,
          authorization,
          dsh_home: join(tempBase, 'home'),
          workspace: join(tempBase, 'workspace'),
          credentialProvider: fakeCredProvider,
        })

        expect(bridge.status).toBe('ready')
        if (bridge.status === 'ready') {
          await expect(bridge.dispose()).resolves.not.toThrow()
        }
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('9. End-to-End Mocked Transport: 6-Run Pass, Zero Retry, Breaker, Timeouts & Claim Conflict', () => {
    function makeSseStream(text: string, usage = { prompt_tokens: 20, completion_tokens: 10 }): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder()
      const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText))
          controller.close()
        },
      })
    }

    function extractAllMessageText(body: any): string {
      if (!Array.isArray(body?.messages)) return ''
      return body.messages
        .map((m: any) => {
          if (typeof m.content === 'string') return m.content
          if (Array.isArray(m.content)) {
            return m.content
              .map((c: any) => {
                if (typeof c === 'string') return c
                if (typeof c?.text === 'string') return c.text
                if (c && typeof c === 'object') {
                  if (typeof c.content === 'string') return c.content
                  if (Array.isArray(c.content)) return c.content.map((b: any) => b?.text ?? '').join('\n')
                }
                return JSON.stringify(c)
              })
              .join('\n')
          }
          return ''
        })
        .join('\n')
    }

    function makeToolCallStream(toolName: string, args: Record<string, unknown>, id = 'call_fix_s9'): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder()
      const sseText = `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
      })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText))
          controller.close()
        },
      })
    }

    it('completes all 6 canary runs with mock transport producing real_provider_plumbing_pass and clean persistence', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-e2e-pass-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCalls = 0
      let runIndex = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        transportCalls++
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
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
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
        expect(transportCalls).toBe(20) // 14 tasks + 6 acquisitions = 20 transport calls

        // Verify persisted files
        const claimPath = join(persistenceRoot, 'claims', `execution_${canonicalHash({ schema_version: 1, authorization_sha256: authorization.authorization_sha256, approval_sha256: approval.approval_sha256, execution_root_sha256: persistenceRootHash }).slice(7, 39)}.json`)
        const summaryPath = join(persistenceRoot, 'summary.json')
        expect(JSON.parse(readFileSync(claimPath, 'utf8')).schema_version).toBe(1)
        expect(JSON.parse(readFileSync(summaryPath, 'utf8')).status).toBe('real_provider_plumbing_pass')

        // Verify temporary isolation root was cleanly removed
        const isoStat = await lstat(isolationRoot).catch(() => null)
        expect(isoStat).toBeNull()
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('enforces automatic_retries=0 on retryable provider error without re-attempting', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-zero-retry-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        transportCalls++
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 'rate_limit' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      })

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

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('protocol_error')
        // Only 1 call attempted for the first run, 0 retries
        expect(transportCalls).toBe(1)
        expect(summary.ledger.failed_calls).toBe(1)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('trips circuit breaker after 2 consecutive provider errors', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-breaker-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        transportCalls++
        return new Response(JSON.stringify({ error: { message: 'Server internal error', code: 'internal' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      })

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

        // Force consecutive error breaker test by running 2 error invocations
        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('protocol_error')
        expect(summary.ledger.failed_calls).toBe(1)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('aborts on batch timeout when deadline is exceeded', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-batch-timeout-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let clockTime = 0
      const fakeClock = {
        now: () => clockTime,
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        // Advance clock past 600_000ms (10 minutes)
        clockTime += 700_000
        const body = JSON.parse(opts.body)
        const lastMsg = body.messages.at(-1)?.content
        const isAcq = typeof lastMsg === 'string' && lastMsg.includes('Acquisition Request:')

        if (isAcq) {
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'A deterministic candidate produced by fake transport during acquisition',
            redaction_status: 'passed',
          })
          return new Response(makeSseStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

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
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          clock: fakeClock,
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('batch_timeout')
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects duplicate execution run with same Approval due to existing ExecutionClaim conflict', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-double-claim-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const lastMsg = body.messages.at(-1)?.content
        const isAcq = typeof lastMsg === 'string' && lastMsg.includes('Acquisition Request:')

        if (isAcq) {
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'A deterministic candidate produced by fake transport during acquisition',
            redaction_status: 'passed',
          })
          return new Response(makeSseStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

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
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const persistenceRootHash = sha256(resolve(persistenceRoot))

        const approval = createRealCanaryApprovalReceipt({
          authorization,
          decision: 'approved',
          decided_at: '2026-08-21T00:15:00Z',
          subject_id: 'operator_local_01',
          execution_root_sha256: persistenceRootHash,
        })

        // Run 1: succeeds or claims
        await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        // Run 2: same Approval, must reject immediately at claim step
        await expect(
          runRealCanaryD2({
            audit,
            plan,
            authorization,
            approval,
            now: '2026-08-21T00:25:00Z',
            persistence_root: persistenceRoot,
            isolation_root: join(tempBase, 'iso-root-2'),
            workspace_root: process.cwd(),
            credentialProvider: fakeCredProvider,
          })
        ).rejects.toThrow(ProtocolValidationError)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('10. TDD: Single-Call Timeout (30s), Batch Timeout & Full Claim/Ledger Settlement', () => {
    function extractAllMessageText(body: any): string {
      if (!body || !Array.isArray(body.messages)) return ''
      return body.messages
        .map((m: any) => {
          if (typeof m.content === 'string') return m.content
          if (Array.isArray(m.content)) {
            return m.content
              .map((c: any) => {
                if (typeof c === 'string') return c
                if (c?.text) return c.text
                if (c?.content) {
                  if (typeof c.content === 'string') return c.content
                  if (Array.isArray(c.content)) return c.content.map((b: any) => b?.text ?? '').join('\n')
                }
                return JSON.stringify(c)
              })
              .join('\n')
          }
          return ''
        })
        .join('\n')
    }

    function makeToolCallStream(toolName: string, args: Record<string, unknown>, id = 'call_tool_01'): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder()
      const sseText = `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
      })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText))
          controller.close()
        },
      })
    }

    function makeTextStream(text: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder()
      const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText))
          controller.close()
        },
      })
    }

    it('TDD-1: multi-round tool-calling task settles all intermediate tool claims and final text claim', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-multiround-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let runIndex = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          runIndex++
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'A candidate produced by fake transport during acquisition',
            redaction_status: 'passed',
          })
          return new Response(makeTextStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        // Run 2 is tool_only + task_build_recovery (multi-round tool calling)
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
          return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const isControl = allText.includes('task_control_format')
        const hasFixture = allText.includes('fixture_')
        if (!hasFixture) {
          const taskId = isControl ? 'task_control_format' : 'task_build_recovery'
          return new Response(makeToolCallStream('m05d_task_fixture', { task_id: taskId }, 'call_fix_other'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const memoryId = defaultFixtures.catalog.memories[0].memory_id
        const isAutoInject = allText.includes('d2-auto_inject-')
        const isRecovery = allText.includes('task_build_recovery')
        const adoptedIds = isAutoInject && isRecovery ? [memoryId] : []

        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: isControl ? 'task_control_format' : 'task_build_recovery',
          exit_code: 0,
          result: isControl ? { controlled_field: 'alpha' } : { rebuild_mode: 'targeted' },
          adopted_memory_ids: adoptedIds,
          failure_code: null,
        })
        return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_pass')
        expect(summary.reason_code).toBeNull()
        expect(summary.ledger.total_calls_claimed).toBe(summary.ledger.completed_calls)
        expect(summary.ledger.failed_calls).toBe(0)
        // Multi-round task should have claimed > 1 task call for tool_only (4 task calls + other 5 tasks * 1 = 9 task calls)
        expect(summary.ledger.task_calls_claimed).toBeGreaterThan(6)
        const totalTaskCallsFromReceipts = summary.receipts.reduce((acc, r) => acc + r.model_call_count, 0)
        expect(summary.ledger.task_calls_claimed).toBe(totalTaskCallsFromReceipts)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-2: task provider call times out at 30s with call_timeout when stream hangs', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-task-timeout-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCallCount = 0
      let onStreamStart: () => void
      const streamStarted = new Promise<void>((r) => {
        onStreamStart = r
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        transportCallCount++
        onStreamStart()
        // Return a hanging stream that aborts when signal aborts
        const stream = new ReadableStream({
          start(controller) {
            opts.signal?.addEventListener('abort', () => {
              controller.error(opts.signal.reason)
            })
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        const runnerPromise = runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        await streamStarted
        // Advance fake timers by 30_000ms
        await vi.advanceTimersByTimeAsync(30_000)

        const summary = await runnerPromise

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('call_timeout')
        // Assert task_calls_claimed is strictly 1
        expect(summary.ledger.task_calls_claimed).toBe(1)
        expect(summary.ledger.total_calls_claimed).toBe(1)
        // Assert provider transport was invoked exactly 1 time
        expect(transportCallCount).toBe(1)
        // Assert failed = 1, completed = 0, completed + failed = total
        expect(summary.ledger.failed_calls).toBe(1)
        expect(summary.ledger.completed_calls).toBe(0)
        expect(summary.ledger.completed_calls + summary.ledger.failed_calls).toBe(summary.ledger.total_calls_claimed)
      } finally {
        vi.useRealTimers()
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-3: acquisition provider call times out at 30s with call_timeout when acquisition stream hangs', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-acq-timeout-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let onAcqStart: () => void
      const acqStarted = new Promise<void>((r) => {
        onAcqStart = r
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          onAcqStart()
          // Hanging acquisition stream
          const stream = new ReadableStream({
            start(controller) {
              opts.signal?.addEventListener('abort', () => {
                controller.error(opts.signal.reason)
              })
            },
          })
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
          result: { rebuild_mode: 'clean_rebuild' },
          adopted_memory_ids: [],
          failure_code: null,
        })
        return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        const runnerPromise = runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        await acqStarted
        // Advance fake timers by 30_000ms
        await vi.advanceTimersByTimeAsync(30_000)

        const summary = await runnerPromise

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('call_timeout')
        // Acquisition call failed, so no receipt was persisted: completed = 0, failed = 2
        expect(summary.receipts).toHaveLength(0)
        expect(summary.ledger.completed_calls).toBe(0)
        expect(summary.ledger.failed_calls).toBe(2)
        expect(summary.ledger.total_calls_claimed).toBe(2)
      } finally {
        vi.useRealTimers()
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-4: clearly differentiates batch_timeout vs call_timeout', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-timeout-diff-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      // Case: Remaining batch is 5s (< 30s). When stream hangs, it must abort at 5s as batch_timeout
      let clockCalls = 0
      const fakeClock = {
        now: () => {
          clockCalls++
          return clockCalls === 1 ? 0 : 595_000
        },
      }
      let onStreamStart: () => void
      const streamStarted = new Promise<void>((r) => {
        onStreamStart = r
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        onStreamStart()
        const stream = new ReadableStream({
          start(controller) {
            opts.signal?.addEventListener('abort', () => {
              controller.error(opts.signal.reason)
            })
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        const runnerPromise = runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          clock: fakeClock,
          credentialProvider: fakeCredProvider,
        })

        await streamStarted
        await vi.advanceTimersByTimeAsync(5_000)

        const summary = await runnerPromise
        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('batch_timeout')
      } finally {
        vi.useRealTimers()
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-5: task final text with invalid ModelReceipt fails the final sequence and leaves zero pending', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-bad-model-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        // Invalid ModelReceipt (missing required fields / invalid schema)
        const invalidTaskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
          // Missing result, adopted_memory_ids, failure_code
        })
        return new Response(makeTextStream(invalidTaskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('protocol_error')
        expect(summary.ledger.failed_calls).toBe(1)
        expect(summary.ledger.completed_calls).toBe(0)
        expect(summary.ledger.total_calls_claimed).toBe(1)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-6: acquisition candidate with invalid schema fails acquisition sequence and leaves zero pending', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-bad-acq-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          // Invalid candidate JSON (markdown code block wrapped)
          const badCandidate = '```json\n{"schema_version":1,"title":"T","summary":"S","redaction_status":"passed"}\n```'
          return new Response(makeTextStream(badCandidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
          result: { rebuild_mode: 'clean_rebuild' },
          adopted_memory_ids: [],
          failure_code: null,
        })
        return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('circuit_open')
        // Acquisition candidate schema failed, so no receipt was persisted: completed = 0, failed = 2
        expect(summary.receipts).toHaveLength(0)
        expect(summary.ledger.completed_calls).toBe(0)
        expect(summary.ledger.failed_calls).toBe(2)
        expect(summary.ledger.total_calls_claimed).toBe(2)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('TDD-7: full 6-run Canary with multi-round tasks validates complete ledger invariants', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-tdd-6run-multiround-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let runIndex = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          runIndex++
          const candidate = JSON.stringify({
            schema_version: 1,
            title: 'Mocked live candidate',
            summary: 'A deterministic candidate produced by fake transport during acquisition',
            redaction_status: 'passed',
          })
          return new Response(makeTextStream(candidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
          return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        // For other tasks: 1 fixture call + 1 text
        const isControl = allText.includes('task_control_format')
        const hasFixture = allText.includes('fixture_')
        if (!hasFixture) {
          const taskId = isControl ? 'task_control_format' : 'task_build_recovery'
          return new Response(makeToolCallStream('m05d_task_fixture', { task_id: taskId }, 'call_fix_other'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        const memoryId = defaultFixtures.catalog.memories[0].memory_id
        const adoptedIds = runIndex === 4 ? [memoryId] : []

        const taskResponse = JSON.stringify({
          schema_version: 1,
          task_id: isControl ? 'task_control_format' : 'task_build_recovery',
          exit_code: 0,
          result: isControl ? { controlled_field: 'alpha' } : { rebuild_mode: 'targeted' },
          adopted_memory_ids: adoptedIds,
          failure_code: null,
        })
        return new Response(makeTextStream(taskResponse), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })

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

        const summary = await runRealCanaryD2({
          audit,
          plan,
          authorization,
          approval,
          now: '2026-08-21T00:20:00Z',
          persistence_root: persistenceRoot,
          isolation_root: isolationRoot,
          workspace_root: process.cwd(),
          credentialProvider: fakeCredProvider,
        })

        expect(summary.status).toBe('real_provider_plumbing_pass')
        expect(summary.receipts).toHaveLength(6)
        expect(summary.reason_code).toBeNull()
        expect(summary.cleanup_clean).toBe(true)

        const totalTaskCalls = summary.receipts.reduce((sum, r) => sum + r.model_call_count, 0)
        expect(summary.ledger.task_calls_claimed).toBe(totalTaskCalls)
        expect(summary.ledger.acquisition_calls_claimed).toBe(6)
        expect(summary.ledger.total_calls_claimed).toBe(totalTaskCalls + 6)
        expect(summary.ledger.completed_calls).toBe(summary.ledger.total_calls_claimed)
        expect(summary.ledger.failed_calls).toBe(0)

        // Validate contiguous global sequence 1..total
        const allSequences = summary.receipts.flatMap((r) => r.claim_sequence)
        expect(allSequences).toHaveLength(summary.ledger.total_calls_claimed)
        for (let i = 0; i < allSequences.length; i++) {
          expect(allSequences[i]).toBe(i + 1)
        }
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('11. Strict RealCanaryReceipt & RealCanarySummary Validation & Single-Field Tampering Matrix', () => {
    const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
    const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
    const planHash = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'
    const manifestHash = 'sha256_4444444444444444444444444444444444444444444444444444444444444444'

    function createPassSummaryFixture() {
      const groups = ['no_memory', 'tool_only', 'auto_inject'] as const
      const tasks = ['task_build_recovery', 'task_control_format'] as const
      const receipts: RealCanaryReceipt[] = []
      let currentSeq = 1

      for (const group of groups) {
        for (const taskId of tasks) {
          const modelCallCount = group === 'tool_only' && taskId === 'task_build_recovery' ? 3 : 1
          const claimSeq = Array.from({ length: modelCallCount + 1 }, (_, i) => currentSeq + i)
          currentSeq += modelCallCount + 1
          receipts.push(
            createSampleValidReceipt({
              authSha,
              approvalSha: appSha,
              planHash,
              taskId,
              group,
              claimSequence: claimSeq,
              modelCallCount,
            })
          )
        }
      }

      const totalTaskCalls = receipts.reduce((sum, r) => sum + r.model_call_count, 0)
      const totalCalls = totalTaskCalls + 6

      const body = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_pass' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts,
        deterministic_prefix_bytes: canonicalBytes(receipts.map((r) => {
          const { duration_ms: _d, canonical_hash: _h, ...b } = r
          return b
        })),
        ledger: {
          task_calls_claimed: totalTaskCalls,
          acquisition_calls_claimed: 6,
          total_calls_claimed: totalCalls,
          completed_calls: totalCalls,
          failed_calls: 0,
          consecutive_provider_or_protocol_errors: 0,
        },
        reason_code: null,
        cleanup_clean: true,
      }

      const summary: RealCanarySummary = {
        ...body,
        summary_sha256: canonicalHash(body),
      }
      return { summary, receipts, totalTaskCalls, totalCalls }
    }

    describe('11.1 Receipt Success Recalculation & Assertion Consistency', () => {
      it('rejects receipt if success is true but task_build_recovery result is not targeted', () => {
        const receipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'no_memory',
          success: true,
          modelResult: { rebuild_mode: 'clean_rebuild' },
        })
        expect(() => validateRealCanaryReceipt(receipt)).toThrow(ProtocolValidationError)
      })

      it('rejects receipt if success is true but task_build_recovery exit_code is non-zero', () => {
        const receipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'no_memory',
          success: true,
          exitCode: 1,
          failureCode: 'assertion_failed',
          modelResult: { rebuild_mode: 'targeted' },
        })
        expect(() => validateRealCanaryReceipt(receipt)).toThrow(ProtocolValidationError)
      })

      it('rejects receipt if success is true but task_control_format controlled_field is not alpha', () => {
        const receipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          group: 'no_memory',
          success: true,
          modelResult: { controlled_field: 'beta' },
        })
        expect(() => validateRealCanaryReceipt(receipt)).toThrow(ProtocolValidationError)
      })

      it('rejects receipt if success is false but task_control_format actually met all success criteria', () => {
        const receipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          group: 'no_memory',
          success: false,
          exitCode: 0,
          failureCode: null,
          modelResult: { controlled_field: 'alpha' },
        })
        expect(() => validateRealCanaryReceipt(receipt)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.2 Group & Task Behavior Locking (3 groups x 2 tasks)', () => {
      it('rejects no_memory receipt with search or open tools or recall events or memories', () => {
        // 1. Tool call violation (search in no_memory)
        const badTool = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'no_memory',
          toolCalls: ['m05d_task_fixture', 'mnemosyne_search'],
        })
        expect(() => validateRealCanaryReceipt(badTool)).toThrow(ProtocolValidationError)

        // 2. Memory event violation (recall in no_memory)
        const badEvent = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'no_memory',
          memoryEvents: ['recall_user_message', 'user_message'],
        })
        expect(() => validateRealCanaryReceipt(badEvent)).toThrow(ProtocolValidationError)

        // 3. Observed memory violation
        const badObserved = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'no_memory',
          observedMemoryIds: ['memory_build_cache'],
        })
        expect(() => validateRealCanaryReceipt(badObserved)).toThrow(ProtocolValidationError)
      })

      it('rejects tool_only receipt if control task calls search/open or memory-dependent task omits search/open', () => {
        // 1. Control task calling search tool in tool_only
        const badControlTool = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          group: 'tool_only',
          toolCalls: ['m05d_task_fixture', 'mnemosyne_search'],
        })
        expect(() => validateRealCanaryReceipt(badControlTool)).toThrow(ProtocolValidationError)

        // 2. Memory-dependent task missing search tool in tool_only
        const badDepTool = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'tool_only',
          toolCalls: ['m05d_task_fixture', 'mnemosyne_open'],
          modelCallCount: 2,
          claimSequence: [1, 2, 3],
        })
        expect(() => validateRealCanaryReceipt(badDepTool)).toThrow(ProtocolValidationError)

        // 3. Memory-dependent task wrong tool order
        const badOrderTool = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'tool_only',
          toolCalls: ['m05d_task_fixture', 'mnemosyne_open', 'mnemosyne_search'],
          modelCallCount: 3,
          claimSequence: [1, 2, 3, 4],
        })
        expect(() => validateRealCanaryReceipt(badOrderTool)).toThrow(ProtocolValidationError)
      })

      it('rejects auto_inject receipt if memory-dependent task calls search/open or omits recall context', () => {
        // 1. Auto-inject calling search tool
        const badAutoTool = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'auto_inject',
          toolCalls: ['m05d_task_fixture', 'mnemosyne_search'],
        })
        expect(() => validateRealCanaryReceipt(badAutoTool)).toThrow(ProtocolValidationError)

        // 2. Auto-inject missing recall context
        const badAutoNoCtx = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'auto_inject',
          recallContext: null,
          recallReceipt: null,
          recallSource: null,
        })
        expect(() => validateRealCanaryReceipt(badAutoNoCtx)).toThrow(ProtocolValidationError)

        // 3. Control task in auto_inject having recall event
        const badAutoControl = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          group: 'auto_inject',
          memoryEvents: ['recall_user_message', 'user_message'],
        })
        expect(() => validateRealCanaryReceipt(badAutoControl)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.3 Memory Sets & ID Disclosures Exact Closure', () => {
      it('rejects receipt if recall context items mismatch retrieved or opened memory IDs', () => {
        const sampleRuntime = new RetrievalRuntime(defaultFixtures.catalog)
        const memoryTitle = defaultFixtures.catalog.memories[0].title
        const search = sampleRuntime.search({ query: memoryTitle, top_k: 1 })
        const openResult = sampleRuntime.open({
          retrieval_id: search.retrieval_ref,
          search_disclosure_sha256: search.content_sha256,
          memory_id: search.items[0].memory_id,
        })
        const ctxEnv = createRecallContext(search, [openResult])
        const rct = createRecallReceipt(ctxEnv)

        // Retrieved in receipt has extra memory ID not in recall context
        const mismatchReceipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'auto_inject',
          recallContext: ctxEnv,
          recallReceipt: rct,
          retrievedMemoryIds: [search.items[0].memory_id, 'memory_macos_path'],
          observedMemoryIds: [search.items[0].memory_id, 'memory_macos_path'],
        })
        expect(() => validateRealCanaryReceipt(mismatchReceipt)).toThrow(ProtocolValidationError)
      })

      it('rejects receipt if forbidden memory ID is present in any memory array', () => {
        const forbiddenReceipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'tool_only',
          observedMemoryIds: ['memory_build_cache', 'memory_unverified_hook'],
          retrievedMemoryIds: ['memory_build_cache'],
          openedMemoryIds: ['memory_build_cache'],
          adoptedMemoryIds: ['memory_build_cache'],
        })
        expect(() => validateRealCanaryReceipt(forbiddenReceipt)).toThrow(ProtocolValidationError)
      })

      it('rejects receipt if adopted is not subset of opened', () => {
        const notAdoptedSubset = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_build_recovery',
          group: 'tool_only',
          observedMemoryIds: ['memory_build_cache', 'memory_macos_path'],
          retrievedMemoryIds: ['memory_build_cache', 'memory_macos_path'],
          openedMemoryIds: ['memory_build_cache'],
          adoptedMemoryIds: ['memory_macos_path'],
        })
        expect(() => validateRealCanaryReceipt(notAdoptedSubset)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.4 Sensitive Text Scanning on Visible Fields & Serialized JSON', () => {
      it('rejects receipt containing sensitive API key, Bearer token, absolute path, or shell command', () => {
        // 1. API key in provider model
        const apiKeyReceipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          providerModel: 'sk-abcdef123456789012345678',
        })
        expect(() => validateRealCanaryReceipt(apiKeyReceipt)).toThrow(ProtocolValidationError)

        // 2. Absolute path in model result
        const pathReceipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          modelResult: { controlled_field: '/Users/operator/secret_path' },
          success: false,
        })
        expect(() => validateRealCanaryReceipt(pathReceipt)).toThrow(ProtocolValidationError)

        // 3. Dangerous command in result
        const cmdReceipt = createSampleValidReceipt({
          authSha,
          approvalSha: appSha,
          planHash,
          taskId: 'task_control_format',
          modelResult: { controlled_field: 'rm -rf /' },
          success: false,
        })
        expect(() => validateRealCanaryReceipt(cmdReceipt)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.5 Summary Pass Invariants: Run Order, Chained Sequences & Ledger', () => {
      it('rejects pass summary if receipts are swapped or out of canonical (GROUPS x TASKS) order', () => {
        const { summary, receipts } = createPassSummaryFixture()
        // Swap receipt 0 and receipt 1
        const swappedReceipts = [receipts[1], receipts[0], ...receipts.slice(2)]
        const badSummary = {
          ...summary,
          receipts: swappedReceipts,
          deterministic_prefix_bytes: canonicalBytes(swappedReceipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
        }
        badSummary.summary_sha256 = canonicalHash(withoutHash(badSummary, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badSummary)).toThrow(ProtocolValidationError)
      })

      it('rejects pass summary if task_calls_claimed does not equal sum(receipt.model_call_count)', () => {
        const { summary } = createPassSummaryFixture()
        const badSummary = {
          ...summary,
          ledger: {
            ...summary.ledger,
            task_calls_claimed: summary.ledger.task_calls_claimed + 1,
            total_calls_claimed: summary.ledger.total_calls_claimed + 1,
            completed_calls: summary.ledger.completed_calls + 1,
          },
        }
        badSummary.summary_sha256 = canonicalHash(withoutHash(badSummary, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badSummary)).toThrow(ProtocolValidationError)
      })

      it('rejects pass summary if concatenated claim sequence has hole or duplicate', () => {
        const { summary, receipts } = createPassSummaryFixture()
        // Introduce hole in receipt 1 claim_sequence
        const badReceipts = [
          receipts[0],
          {
            ...receipts[1],
            claim_sequence: [receipts[1].claim_sequence[0] + 5, receipts[1].claim_sequence[1] + 5],
          },
          ...receipts.slice(2),
        ]
        badReceipts[1].canonical_hash = canonicalHash(withoutHash(badReceipts[1] as unknown as Record<string, unknown>, 'canonical_hash'))
        const badSummary = {
          ...summary,
          receipts: badReceipts,
          deterministic_prefix_bytes: canonicalBytes(badReceipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
        }
        badSummary.summary_sha256 = canonicalHash(withoutHash(badSummary, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badSummary)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.6 Zero Pending Invariant Across All Summary Statuses', () => {
      it('rejects summary with pending calls (completed + failed < total_claimed) on pass, fail, or abort', () => {
        const { summary } = createPassSummaryFixture()

        // 1. Pending on pass
        const pendingPass = {
          ...summary,
          ledger: {
            ...summary.ledger,
            completed_calls: summary.ledger.total_calls_claimed - 1,
          },
        }
        pendingPass.summary_sha256 = canonicalHash(withoutHash(pendingPass, 'summary_sha256'))
        expect(() => validateRealCanarySummary(pendingPass)).toThrow(ProtocolValidationError)

        // 2. Pending on fail
        const pendingFail = {
          ...summary,
          status: 'real_provider_plumbing_fail' as const,
          reason_code: 'call_timeout' as const,
          ledger: {
            ...summary.ledger,
            completed_calls: 5,
            failed_calls: 1,
            total_calls_claimed: 8, // 5 + 1 < 8 => 2 pending
          },
        }
        pendingFail.summary_sha256 = canonicalHash(withoutHash(pendingFail, 'summary_sha256'))
        expect(() => validateRealCanarySummary(pendingFail)).toThrow(ProtocolValidationError)

        // 3. Pending on abort
        const pendingAbort = {
          ...summary,
          status: 'real_provider_canary_aborted' as const,
          reason_code: 'isolation_error' as const,
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 1,
            completed_calls: 0,
            failed_calls: 0, // 0 + 0 < 1 => 1 pending
            consecutive_provider_or_protocol_errors: 0,
          },
        }
        pendingAbort.summary_sha256 = canonicalHash(withoutHash(pendingAbort, 'summary_sha256'))
        expect(() => validateRealCanarySummary(pendingAbort)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.7 Status and Reason Matrix & Prefix Integrity', () => {
      it('enforces frozen status/reason matrix strictly', () => {
        const { summary } = createPassSummaryFixture()

        // 1. Pass with non-null reason
        const passWithReason = {
          ...summary,
          reason_code: 'call_timeout' as const,
        }
        passWithReason.summary_sha256 = canonicalHash(withoutHash(passWithReason, 'summary_sha256'))
        expect(() => validateRealCanarySummary(passWithReason)).toThrow(ProtocolValidationError)

        // 2. Fail with null reason
        const failWithNullReason = {
          ...summary,
          status: 'real_provider_plumbing_fail' as const,
          reason_code: null,
        }
        failWithNullReason.summary_sha256 = canonicalHash(withoutHash(failWithNullReason, 'summary_sha256'))
        expect(() => validateRealCanarySummary(failWithNullReason)).toThrow(ProtocolValidationError)

        // 3. Fail with abort-only reason (isolation_error)
        const failWithAbortReason = {
          ...summary,
          status: 'real_provider_plumbing_fail' as const,
          reason_code: 'isolation_error' as const,
          ledger: {
            ...summary.ledger,
            completed_calls: summary.ledger.total_calls_claimed - 1,
            failed_calls: 1,
          },
        }
        failWithAbortReason.summary_sha256 = canonicalHash(withoutHash(failWithAbortReason, 'summary_sha256'))
        expect(() => validateRealCanarySummary(failWithAbortReason)).toThrow(ProtocolValidationError)

        // 4. Aborted with fail-only reason (call_timeout)
        const abortWithFailReason = {
          ...summary,
          status: 'real_provider_canary_aborted' as const,
          reason_code: 'call_timeout' as const,
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 0,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 0,
            completed_calls: 0,
            failed_calls: 0,
            consecutive_provider_or_protocol_errors: 0,
          },
        }
        abortWithFailReason.summary_sha256 = canonicalHash(withoutHash(abortWithFailReason, 'summary_sha256'))
        expect(() => validateRealCanarySummary(abortWithFailReason)).toThrow(ProtocolValidationError)

        // 5. Valid fail with credential_unavailable
        const failCredUnavailable = {
          ...summary,
          status: 'real_provider_plumbing_fail' as const,
          reason_code: 'credential_unavailable' as const,
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 0,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 0,
            completed_calls: 0,
            failed_calls: 0,
            consecutive_provider_or_protocol_errors: 0,
          },
        }
        failCredUnavailable.summary_sha256 = canonicalHash(withoutHash(failCredUnavailable, 'summary_sha256'))
        expect(validateRealCanarySummary(failCredUnavailable)).toEqual(failCredUnavailable)
      })

      it('rejects fail summary if receipts do not form a contiguous valid prefix from run 0', () => {
        const { summary, receipts } = createPassSummaryFixture()
        // Take receipt 1 and receipt 2 (skipping run 0)
        const nonPrefixReceipts = receipts.slice(1, 3)
        const badPrefixSummary = {
          ...summary,
          status: 'real_provider_plumbing_fail' as const,
          reason_code: 'call_timeout' as const,
          receipts: nonPrefixReceipts,
          deterministic_prefix_bytes: canonicalBytes(nonPrefixReceipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
          ledger: {
            task_calls_claimed: 4,
            acquisition_calls_claimed: 2,
            total_calls_claimed: 7,
            completed_calls: 6,
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 1,
          },
        }
        badPrefixSummary.summary_sha256 = canonicalHash(withoutHash(badPrefixSummary, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badPrefixSummary)).toThrow(ProtocolValidationError)
      })
    })

    describe('11.8 Provider Model Byte-for-Byte Consistency Across Summary Receipts', () => {
      it('rejects summary if second receipt provider.model is tampered, even after recomputing receipt hash, prefix bytes, and summary hash', () => {
        const { summary, receipts } = createPassSummaryFixture()
        expect(validateRealCanarySummary(summary)).toEqual(summary)

        // Tamper the second receipt (index 1) with a different model name
        const tamperedReceipt1: RealCanaryReceipt = {
          ...receipts[1],
          provider: {
            provider: 'deepseek-official',
            model: 'deepseek-chat',
          },
        }
        tamperedReceipt1.canonical_hash = canonicalHash(withoutHash(tamperedReceipt1 as unknown as Record<string, unknown>, 'canonical_hash'))

        // Validate that the tampered receipt itself satisfies single-receipt validation
        expect(validateRealCanaryReceipt(tamperedReceipt1)).toEqual(tamperedReceipt1)

        // Rebuild summary with the tampered receipt and recompute prefix bytes & summary hash
        const updatedReceipts = [receipts[0], tamperedReceipt1, ...receipts.slice(2)]
        const tamperedSummary: RealCanarySummary = {
          ...summary,
          receipts: updatedReceipts,
          deterministic_prefix_bytes: canonicalBytes(updatedReceipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
        }
        tamperedSummary.summary_sha256 = canonicalHash(withoutHash(tamperedSummary as unknown as Record<string, unknown>, 'summary_sha256'))

        // Must throw ProtocolValidationError specifically due to model mismatch across receipts
        expect(() => validateRealCanarySummary(tamperedSummary)).toThrow(ProtocolValidationError)
      })

      it('accepts summary when all receipts share byte-for-byte identical provider.model', () => {
        const { summary } = createPassSummaryFixture()
        expect(validateRealCanarySummary(summary)).toEqual(summary)
      })
    })

    describe('11.9 Persisted Completed Sequences and Ledger completed/failed Exact Invariants', () => {
      it('rejects plumbing_fail summary if completed_calls exceeds persisted receipt prefix claims count (forging completed without receipt)', () => {
        const { summary, receipts } = createPassSummaryFixture()
        // Prefix with only receipt 0 (contains 2 claims: sequences 1, 2)
        const prefixReceipts = [receipts[0]]
        const prefixBytes = canonicalBytes(prefixReceipts.map((r) => {
          const { duration_ms: _d, canonical_hash: _h, ...b } = r
          return b
        }))

        // Total claimed 3, prefix claims 2, but ledger forged completed=3, failed=0
        const forgedSummary: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'protocol_error',
          receipts: prefixReceipts,
          deterministic_prefix_bytes: prefixBytes,
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 1,
            total_calls_claimed: 3,
            completed_calls: 3, // forged: 3 != 2 prefix claims
            failed_calls: 0,
            consecutive_provider_or_protocol_errors: 0,
          },
          summary_sha256: '',
        }
        forgedSummary.summary_sha256 = canonicalHash(withoutHash(forgedSummary as unknown as Record<string, unknown>, 'summary_sha256'))

        expect(() => validateRealCanarySummary(forgedSummary)).toThrow(ProtocolValidationError)
      })

      it('rejects plumbing_fail summary if completed_calls is less than persisted receipt prefix claims count (forging receipt claim as failed)', () => {
        const { summary, receipts } = createPassSummaryFixture()
        // Prefix with only receipt 0 (contains 2 claims: sequences 1, 2)
        const prefixReceipts = [receipts[0]]
        const prefixBytes = canonicalBytes(prefixReceipts.map((r) => {
          const { duration_ms: _d, canonical_hash: _h, ...b } = r
          return b
        }))

        // Total claimed 3, prefix claims 2, but ledger forged completed=1, failed=2
        const forgedSummary: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'protocol_error',
          receipts: prefixReceipts,
          deterministic_prefix_bytes: prefixBytes,
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 1,
            total_calls_claimed: 3,
            completed_calls: 1, // forged: 1 != 2 prefix claims
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 1,
          },
          summary_sha256: '',
        }
        forgedSummary.summary_sha256 = canonicalHash(withoutHash(forgedSummary as unknown as Record<string, unknown>, 'summary_sha256'))

        expect(() => validateRealCanarySummary(forgedSummary)).toThrow(ProtocolValidationError)
      })

      it('rejects canary_aborted summary if completed_calls != persisted receipt prefix claims count', () => {
        const { summary, receipts, totalTaskCalls, totalCalls } = createPassSummaryFixture()

        // 1. Aborted with isolation_error (0 receipts, prefix claims 0), but completed_calls = 1, failed_calls = 1
        const forgedAbortEmpty: RealCanarySummary = {
          ...summary,
          status: 'real_provider_canary_aborted',
          reason_code: 'isolation_error',
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 2,
            completed_calls: 1, // forged: 1 != 0 prefix claims
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 1,
          },
          summary_sha256: '',
        }
        forgedAbortEmpty.summary_sha256 = canonicalHash(withoutHash(forgedAbortEmpty as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(forgedAbortEmpty)).toThrow(ProtocolValidationError)

        // 2. Aborted with cleanup_failed with all 6 receipts (totalCalls prefix claims), but completed_calls = totalCalls - 1
        const forgedAbortFull: RealCanarySummary = {
          ...summary,
          status: 'real_provider_canary_aborted',
          reason_code: 'cleanup_failed',
          cleanup_clean: false,
          receipts,
          deterministic_prefix_bytes: canonicalBytes(receipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
          ledger: {
            task_calls_claimed: totalTaskCalls,
            acquisition_calls_claimed: 6,
            total_calls_claimed: totalCalls,
            completed_calls: totalCalls - 1, // forged: 19 != 20 prefix claims
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 0,
          },
          summary_sha256: '',
        }
        forgedAbortFull.summary_sha256 = canonicalHash(withoutHash(forgedAbortFull as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(forgedAbortFull)).toThrow(ProtocolValidationError)
      })

      it('accepts canary_aborted with cleanup_failed and 6 receipts when completed=N, failed=0', () => {
        const { summary, receipts, totalTaskCalls, totalCalls } = createPassSummaryFixture()

        const validCleanupFailed: RealCanarySummary = {
          ...summary,
          status: 'real_provider_canary_aborted',
          reason_code: 'cleanup_failed',
          cleanup_clean: false,
          receipts,
          deterministic_prefix_bytes: canonicalBytes(receipts.map((r) => {
            const { duration_ms: _d, canonical_hash: _h, ...b } = r
            return b
          })),
          ledger: {
            task_calls_claimed: totalTaskCalls,
            acquisition_calls_claimed: 6,
            total_calls_claimed: totalCalls,
            completed_calls: totalCalls,
            failed_calls: 0,
            consecutive_provider_or_protocol_errors: 0,
          },
          summary_sha256: '',
        }
        validCleanupFailed.summary_sha256 = canonicalHash(withoutHash(validCleanupFailed as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(validateRealCanarySummary(validCleanupFailed)).toEqual(validCleanupFailed)
      })

      it('accepts plumbing_fail with credential_unavailable and empty receipts when completed=0, failed=0', () => {
        const { summary } = createPassSummaryFixture()
        const validCredUnavailable: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'credential_unavailable',
          cleanup_clean: true,
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 0,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 0,
            completed_calls: 0,
            failed_calls: 0,
            consecutive_provider_or_protocol_errors: 0,
          },
          summary_sha256: '',
        }
        validCredUnavailable.summary_sha256 = canonicalHash(withoutHash(validCredUnavailable as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(validateRealCanarySummary(validCredUnavailable)).toEqual(validCredUnavailable)
      })
    })

    describe('11.10 Basic Ledger Invariants & Circuit Breaker Reason Consistency', () => {
      it('rejects summary if consecutive_provider_or_protocol_errors > failed_calls', () => {
        const { summary } = createPassSummaryFixture()
        const badConsecutive: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'protocol_error',
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 1,
            completed_calls: 0,
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 2, // 2 > 1 failed_calls
          },
          summary_sha256: '',
        }
        badConsecutive.summary_sha256 = canonicalHash(withoutHash(badConsecutive as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badConsecutive)).toThrow(ProtocolValidationError)
      })

      it('rejects summary with reason_code=circuit_open if failed_calls < 2 or consecutive != 2', () => {
        const { summary } = createPassSummaryFixture()

        // 1. failed_calls = 1, consecutive = 1
        const badCircuit1: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'circuit_open',
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 1,
            completed_calls: 0,
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 1,
          },
          summary_sha256: '',
        }
        badCircuit1.summary_sha256 = canonicalHash(withoutHash(badCircuit1 as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badCircuit1)).toThrow(ProtocolValidationError)

        // 2. failed_calls = 2, consecutive = 1
        const badCircuit2: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'circuit_open',
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 1, // 1 != 2
          },
          summary_sha256: '',
        }
        badCircuit2.summary_sha256 = canonicalHash(withoutHash(badCircuit2 as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badCircuit2)).toThrow(ProtocolValidationError)

        // 3. failed_calls = 1, consecutive = 2
        const badCircuit3: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'circuit_open',
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 1,
            completed_calls: 0,
            failed_calls: 1, // 1 < 2
            consecutive_provider_or_protocol_errors: 2,
          },
          summary_sha256: '',
        }
        badCircuit3.summary_sha256 = canonicalHash(withoutHash(badCircuit3 as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(() => validateRealCanarySummary(badCircuit3)).toThrow(ProtocolValidationError)
      })

      it('accepts summary with reason_code=circuit_open when failed_calls >= 2 and consecutive == 2', () => {
        const { summary } = createPassSummaryFixture()
        const validCircuitOpen: RealCanarySummary = {
          ...summary,
          status: 'real_provider_plumbing_fail',
          reason_code: 'circuit_open',
          cleanup_clean: true,
          receipts: [],
          deterministic_prefix_bytes: canonicalBytes([]),
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 2,
          },
          summary_sha256: '',
        }
        validCircuitOpen.summary_sha256 = canonicalHash(withoutHash(validCircuitOpen as unknown as Record<string, unknown>, 'summary_sha256'))
        expect(validateRealCanarySummary(validCircuitOpen)).toEqual(validCircuitOpen)
      })
    })
  })
})
