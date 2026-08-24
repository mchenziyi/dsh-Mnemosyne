import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises'
import { ProtocolValidationError, canonicalBytes, canonicalHash, sha256, withoutHash } from '../src/protocol/canonical.js'
import { runM05F1PlanningGate } from '../src/m05f/authorization.js'
import { createRealCanaryApprovalReceipt } from '../src/m05d2/approval.js'
import {
  runRealCanaryD2,
  validateRealCanaryReceipt,
  validateRealCanarySummary,
  type RealCanaryReceipt,
  type RealCanarySummary,
} from '../src/m05d2/runner.js'
import { createSanitizedFailureDiagnostic, type SanitizedFailureDiagnostic } from '../src/m05d2/diagnostics.js'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialSeamInstaller } from '../src/m05d2/provider-factory.js'
import { loadM05Dv2Fixtures } from '../src/m05d/index.js'
import { createCanaryPlan } from '../src/m05e/index.js'

const defaultFixtures = await loadM05Dv2Fixtures()

describe('M0.5D-D2-C: Runner Failure Diagnostics Integration & Summary Compatibility', () => {
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

  describe('1. Summary Schema Extension & Backward Compatibility', () => {
    const authSha = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
    const appSha = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
    const planHash = 'sha256_3333333333333333333333333333333333333333333333333333333333333333'
    const manifestHash = 'sha256_4444444444444444444444444444444444444444444444444444444444444444'

    it('accepts legacy Summary lacking failure_diagnostics and normalizes to [] without altering legacy hash', () => {
      const legacyBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_fail' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: [],
        deterministic_prefix_bytes: '[]',
        ledger: {
          task_calls_claimed: 1,
          acquisition_calls_claimed: 0,
          total_calls_claimed: 1,
          completed_calls: 0,
          failed_calls: 1,
          consecutive_provider_or_protocol_errors: 1,
        },
        reason_code: 'protocol_error' as const,
        cleanup_clean: true,
      }
      const legacySummary = {
        ...legacyBody,
        summary_sha256: canonicalHash(legacyBody),
      }

      const validated = validateRealCanarySummary(legacySummary)
      expect(validated.failure_diagnostics).toBeUndefined()
      expect(validated.failure_diagnostics ?? []).toEqual([])
      expect('failure_diagnostics' in validated).toBe(false)
      expect(validated.summary_sha256).toBe(legacySummary.summary_sha256)
    })

    it('validates new Summary with failure_diagnostics participating in summary_sha256', () => {
      const diag = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'authentication_rejected',
        provider_code: 'AUTH',
      })
      const newBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_fail' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: [],
        deterministic_prefix_bytes: '[]',
        ledger: {
          task_calls_claimed: 1,
          acquisition_calls_claimed: 0,
          total_calls_claimed: 1,
          completed_calls: 0,
          failed_calls: 1,
          consecutive_provider_or_protocol_errors: 1,
        },
        reason_code: 'protocol_error' as const,
        cleanup_clean: true,
        failure_diagnostics: [diag],
      }
      const newSummary = {
        ...newBody,
        summary_sha256: canonicalHash(newBody),
      }

      const validated = validateRealCanarySummary(newSummary)
      expect(validated.failure_diagnostics).toBeDefined()
      expect(validated.failure_diagnostics).toHaveLength(1)
      expect(validated.failure_diagnostics![0].category).toBe('authentication_rejected')

      // Tamper with diagnostic category inside summary: must fail hash verification
      const tamperedDiag = { ...diag, category: 'rate_limited' as const }
      const tamperedSummary = {
        ...newSummary,
        failure_diagnostics: [tamperedDiag],
      }
      expect(() => validateRealCanarySummary(tamperedSummary)).toThrow(ProtocolValidationError)
    })

    it('rejects success summary if failure_diagnostics is non-empty', () => {
      const diag = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'authentication_rejected',
        provider_code: 'AUTH',
      })
      const invalidPassBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_pass' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: [],
        deterministic_prefix_bytes: '[]',
        ledger: {
          task_calls_claimed: 0,
          acquisition_calls_claimed: 0,
          total_calls_claimed: 0,
          completed_calls: 0,
          failed_calls: 0,
          consecutive_provider_or_protocol_errors: 0,
        },
        reason_code: null,
        cleanup_clean: true,
        failure_diagnostics: [diag],
      }
      const invalidPassSummary = {
        ...invalidPassBody,
        summary_sha256: canonicalHash(invalidPassBody),
      }
      expect(() => validateRealCanarySummary(invalidPassSummary)).toThrow(ProtocolValidationError)
    })

    it('rejects summary if failure_diagnostics count exceeds ledger failed_calls', () => {
      const diag1 = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'authentication_rejected',
        provider_code: 'AUTH',
      })
      const diag2 = createSanitizedFailureDiagnostic({
        sequence: 2,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'rate_limited',
        provider_code: 'RATE_LIMIT',
      })
      const excessBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_fail' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: [],
        deterministic_prefix_bytes: '[]',
        ledger: {
          task_calls_claimed: 1,
          acquisition_calls_claimed: 0,
          total_calls_claimed: 1,
          completed_calls: 0,
          failed_calls: 1, // Only 1 failed call, but 2 diagnostics
          consecutive_provider_or_protocol_errors: 1,
        },
        reason_code: 'protocol_error' as const,
        cleanup_clean: true,
        failure_diagnostics: [diag1, diag2],
      }
      const excessSummary = {
        ...excessBody,
        summary_sha256: canonicalHash(excessBody),
      }
      expect(() => validateRealCanarySummary(excessSummary)).toThrow(ProtocolValidationError)
    })

    it('rejects summary with duplicate or non-ascending sequence numbers in failure_diagnostics', () => {
      const diag1 = createSanitizedFailureDiagnostic({
        sequence: 2,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'authentication_rejected',
        provider_code: 'AUTH',
      })
      const diag2 = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: 'provider_stream',
        category: 'rate_limited',
        provider_code: 'RATE_LIMIT',
      })
      const nonAscendingBody = {
        schema_version: 1 as const,
        status: 'real_provider_plumbing_fail' as const,
        authorization_sha256: authSha,
        approval_sha256: appSha,
        plan_hash: planHash,
        fixture_manifest_sha256: manifestHash,
        receipts: [],
        deterministic_prefix_bytes: '[]',
        ledger: {
          task_calls_claimed: 2,
          acquisition_calls_claimed: 0,
          total_calls_claimed: 2,
          completed_calls: 0,
          failed_calls: 2,
          consecutive_provider_or_protocol_errors: 2,
        },
        reason_code: 'circuit_open' as const,
        cleanup_clean: true,
        failure_diagnostics: [diag1, diag2], // [seq 2, seq 1]
      }
      const nonAscendingSummary = {
        ...nonAscendingBody,
        summary_sha256: canonicalHash(nonAscendingBody),
      }
      expect(() => validateRealCanarySummary(nonAscendingSummary)).toThrow(ProtocolValidationError)
    })
  })

  describe('2. Runner End-to-End Diagnostics Recording with Fake Provider Failures', () => {
    it('records 1 diagnostic with category="authentication_rejected" and provider_code="AUTH" on 401 AUTH error', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-auth-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        transportCalls++
        return new Response(JSON.stringify({ error: { message: 'Invalid API key provided', code: 'invalid_api_key' } }), {
          status: 401,
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
        expect(summary.failure_diagnostics).toHaveLength(1)
        expect(summary.failure_diagnostics![0].sequence).toBe(1)
        expect(summary.failure_diagnostics![0].call_kind).toBe('task')
        expect(summary.failure_diagnostics![0].stage).toBe('provider_stream')
        expect(summary.failure_diagnostics![0].category).toBe('authentication_rejected')
        expect(summary.failure_diagnostics![0].provider_code).toBe('AUTH')
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records 1 diagnostic with category="network_failure" and provider_code="TRANSPORT" on network socket disconnect', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-transport-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('fetch failed: network socket reset')
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
        expect(summary.failure_diagnostics).toHaveLength(1)
        expect(summary.failure_diagnostics![0].stage).toBe('provider_stream')
        expect(summary.failure_diagnostics![0].category).toBe('network_failure')
        expect(summary.failure_diagnostics![0].provider_code).toBe('TRANSPORT')
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records 1 diagnostic with category="provider_protocol_error" and provider_code="MALFORMED_RESPONSE" on broken SSE', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-malformed-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        const encoder = new TextEncoder()
        const brokenSse = 'data: not valid json\n\n'
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(brokenSse))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
        expect(summary.failure_diagnostics).toHaveLength(1)
        expect(summary.failure_diagnostics![0].stage).toBe('provider_stream')
        expect(summary.failure_diagnostics![0].category).toBe('provider_protocol_error')
        expect(['MALFORMED_RESPONSE', 'STREAM_CLOSED']).toContain(summary.failure_diagnostics![0].provider_code)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records diagnostic with stage="task_output_validation" and category="model_output_schema_error" on invalid model output schema', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-model-schema-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        // Invalid model receipt JSON missing result field
        const invalidTaskResponse = JSON.stringify({
          schema_version: 1,
          task_id: 'task_build_recovery',
          exit_code: 0,
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
        expect(summary.failure_diagnostics).toHaveLength(1)
        expect(summary.failure_diagnostics![0].sequence).toBe(1)
        expect(summary.failure_diagnostics![0].stage).toBe('task_output_validation')
        expect(summary.failure_diagnostics![0].category).toBe('model_output_schema_error')
        expect(summary.failure_diagnostics![0].provider_code).toBeNull()
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records 2 diagnostics and trips breaker when acquisition candidate schema fails after task assertion failure', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-breaker-diags-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let transportCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        transportCalls++
        const body = JSON.parse(opts.body)
        const allText = extractAllMessageText(body)

        if (allText.includes('Acquisition Request:')) {
          // Bad candidate JSON
          const badCandidate = '```json\n{"schema_version":1,"title":"T","summary":"S","redaction_status":"passed"}\n```'
          return new Response(makeTextStream(badCandidate), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }

        // Task call assertion fails
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
        expect(summary.ledger.failed_calls).toBe(2)
        expect(summary.failure_diagnostics).toHaveLength(2)

        expect(summary.failure_diagnostics![0].sequence).toBe(1)
        expect(summary.failure_diagnostics![0].call_kind).toBe('task')

        expect(summary.failure_diagnostics![1].sequence).toBe(2)
        expect(summary.failure_diagnostics![1].call_kind).toBe('acquisition')
        expect(summary.failure_diagnostics![1].stage).toBe('acquisition_output_validation')
        expect(summary.failure_diagnostics![1].category).toBe('model_output_schema_error')
        expect(summary.failure_diagnostics![1].provider_code).toBeNull()
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('produces failure_diagnostics: [] on pre-provider blocked without network calls', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-runner-blocked-diags-'))
      const persistenceRoot = join(tempBase, 'evidence-root')
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
      const isolationRoot = join(tempBase, 'iso-root')

      let networkCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () => {
        networkCalls++
        return new Response('', { status: 500 })
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

        // Runner without credential provider is blocked
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

        expect(summary.status).toBe('real_provider_plumbing_fail')
        expect(summary.reason_code).toBe('credential_unavailable')
        expect(summary.failure_diagnostics).toEqual([])
        expect(summary.ledger.failed_calls).toBe(0)
        expect(networkCalls).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  describe('3. CTO Review Regression Suite: Immutability, Strict Invariants & Leak Proofs', () => {
    it('3.1 Legacy Summary: preserves original keys, does not mutate/inject failure_diagnostics, allows idempotent re-validation', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-d2-legacy-idempotent-'))
      try {
        const { audit, plan, authorization } = await createGateFixture(tempBase)
        const appSha = 'sha256_' + 'a'.repeat(64)
        const manifestSha = 'sha256_' + 'b'.repeat(64)

        const legacySummaryBody = {
          schema_version: 1 as const,
          status: 'real_provider_plumbing_fail' as const,
          authorization_sha256: authorization.authorization_sha256,
          approval_sha256: appSha,
          plan_hash: plan.plan_sha256,
          fixture_manifest_sha256: manifestSha,
          receipts: [],
          deterministic_prefix_bytes: '[]',
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
        }

        const legacySummary = {
          ...legacySummaryBody,
          summary_sha256: canonicalHash(legacySummaryBody),
        }

        // First validation
        const validated1 = validateRealCanarySummary(legacySummary)
        // Must NOT have injected failure_diagnostics as a physical key
        expect('failure_diagnostics' in validated1).toBe(false)
        expect((validated1 as any).failure_diagnostics).toBeUndefined()

        // Re-validation of returned object must pass idempotently
        const validated2 = validateRealCanarySummary(validated1)
        expect(validated2.summary_sha256).toBe(legacySummary.summary_sha256)
        expect('failure_diagnostics' in validated2).toBe(false)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    describe('3.2 Strict Invariants on New Summary Failure Diagnostics', () => {
      function createBaseFailSummary(overrides: Partial<RealCanarySummary> = {}): RealCanarySummary {
        const body: any = {
          schema_version: 1,
          status: 'real_provider_plumbing_fail',
          authorization_sha256: 'sha256_' + '1'.repeat(64),
          approval_sha256: 'sha256_' + '2'.repeat(64),
          plan_hash: 'sha256_' + '3'.repeat(64),
          fixture_manifest_sha256: 'sha256_' + '4'.repeat(64),
          receipts: [],
          deterministic_prefix_bytes: '[]',
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 1,
            completed_calls: 0,
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 1,
          },
          reason_code: 'protocol_error',
          cleanup_clean: true,
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({
              sequence: 1,
              call_kind: 'task',
              stage: 'provider_stream',
              category: 'authentication_rejected',
              provider_code: 'AUTH',
            }),
          ],
          ...overrides,
        }
        return {
          ...body,
          summary_sha256: canonicalHash(withoutHash(body, 'summary_sha256')),
        }
      }

      it('rejects summary when failure_diagnostics.length !== ledger.failed_calls', () => {
        const bad = createBaseFailSummary({
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 2,
          },
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({
              sequence: 1,
              call_kind: 'task',
              stage: 'provider_stream',
              category: 'authentication_rejected',
              provider_code: 'AUTH',
            }),
          ], // length 1 vs failed_calls 2
        })
        expect(() => validateRealCanarySummary(bad)).toThrow(ProtocolValidationError)
      })

      it('rejects summary with forged diagnostic covering a completed sequence', () => {
        const mockReceipt: any = {
          schema_version: 1,
          run_id: 'run_01',
          authorization_sha256: 'sha256_' + '1'.repeat(64),
          approval_sha256: 'sha256_' + '2'.repeat(64),
          plan_hash: 'sha256_' + '3'.repeat(64),
          provider: { provider: 'deepseek-official', model: 'deepseek-chat' },
          evidence_kind: 'm05d_eval_canary_evidence_v2',
          task_id: 'task_build_recovery',
          group: 'no_memory',
          requested_seed: 101,
          seed_honored: false,
          claim_sequence: [1],
          tool_calls: [],
          memory_events: [],
          recall_source: null,
          recall_context: null,
          recall_receipt: null,
          observed_memory_ids: [],
          retrieved_memory_ids: [],
          opened_memory_ids: [],
          task_calls: 1,
          model_call_count: 1,
          usage: { model: { inputTokens: 10, outputTokens: 10 }, retrieval_estimated_tokens: 0, acquisition_tokens: 0 },
          acquisition: { case_id: 'novel_candidate', provider_calls: 1, after_task_completed: true, decision: 'novel_candidate', reason_code: 'novel_candidate', candidate_schema_valid: true, candidate_content_sha256: 'sha256_' + 'a'.repeat(64) },
          duration_ms: 100,
          success: true,
        }
        const fullReceipt = { ...mockReceipt, canonical_hash: canonicalHash(mockReceipt) }

        const bad = createBaseFailSummary({
          receipts: [fullReceipt],
          deterministic_prefix_bytes: canonicalBytes([mockReceipt]),
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 1,
            total_calls_claimed: 2,
            completed_calls: 1,
            failed_calls: 1,
            consecutive_provider_or_protocol_errors: 1,
          },
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({
              sequence: 1, // Sequence 1 already in completed receipts! Must be 2.
              call_kind: 'acquisition',
              stage: 'provider_stream',
              category: 'rate_limited',
              provider_code: 'RATE_LIMIT',
            }),
          ],
        })
        expect(() => validateRealCanarySummary(bad)).toThrow(ProtocolValidationError)
      })

      it('rejects summary where diagnostic sequences do not strictly match completed_calls+1..total_calls suffix', () => {
        const bad = createBaseFailSummary({
          ledger: {
            task_calls_claimed: 2,
            acquisition_calls_claimed: 0,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 2,
          },
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({ sequence: 1, call_kind: 'task', stage: 'provider_stream', category: 'network_failure', provider_code: 'TRANSPORT' }),
            createSanitizedFailureDiagnostic({ sequence: 3, call_kind: 'task', stage: 'provider_stream', category: 'network_failure', provider_code: 'TRANSPORT' }), // 3 skipped sequence 2
          ],
        })
        expect(() => validateRealCanarySummary(bad)).toThrow(ProtocolValidationError)
      })

      it('rejects summary where diagnostic call_kind counts do not match expected failed task / acquisition counts', () => {
        // Claimed: 1 task, 1 acq. Completed: 0. Failed: 1 task, 1 acq.
        // If diagnostics have 2 'task' diagnostics instead of 1 task + 1 acq, reject.
        const bad = createBaseFailSummary({
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 1,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 2,
          },
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({ sequence: 1, call_kind: 'task', stage: 'provider_stream', category: 'network_failure', provider_code: 'TRANSPORT' }),
            createSanitizedFailureDiagnostic({ sequence: 2, call_kind: 'task', stage: 'provider_stream', category: 'network_failure', provider_code: 'TRANSPORT' }), // Should be acquisition
          ],
        })
        expect(() => validateRealCanarySummary(bad)).toThrow(ProtocolValidationError)
      })

      it('rejects summary if acquisition failure is not at the highest sequence', () => {
        // Claimed: 1 task, 1 acq. Total: 2. Failed: 1 task, 1 acq.
        // If seq 1 is acquisition and seq 2 is task, reject because acquisition happens only after task.
        const bad = createBaseFailSummary({
          ledger: {
            task_calls_claimed: 1,
            acquisition_calls_claimed: 1,
            total_calls_claimed: 2,
            completed_calls: 0,
            failed_calls: 2,
            consecutive_provider_or_protocol_errors: 2,
          },
          failure_diagnostics: [
            createSanitizedFailureDiagnostic({ sequence: 1, call_kind: 'acquisition', stage: 'provider_stream', category: 'rate_limited', provider_code: 'RATE_LIMIT' }),
            createSanitizedFailureDiagnostic({ sequence: 2, call_kind: 'task', stage: 'provider_stream', category: 'rate_limited', provider_code: 'RATE_LIMIT' }),
          ],
        })
        expect(() => validateRealCanarySummary(bad)).toThrow(ProtocolValidationError)
      })
    })

    describe('3.3 Usage Validation Stage Mapping', () => {
      it('maps task malformed usage tokens to task_output_validation and model_output_schema_error', async () => {
        const base = await realpath(tmpdir())
        const tempBase = await mkdtemp(join(base, 'dsh-d2-task-usage-err-'))
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const isolationRoot = join(tempBase, 'iso-root')

        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async () => {
          // Direct response with negative usage tokens
          const encoder = new TextEncoder()
          const validTaskJson = JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 0, result: { rebuild_mode: 'targeted' }, adopted_memory_ids: [], failure_code: null })
          const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: validTaskJson } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: -10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`
          return new Response(new ReadableStream({
            start(c) { c.enqueue(encoder.encode(sseText)); c.close() }
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
          expect(summary.failure_diagnostics).toHaveLength(1)
          expect(summary.failure_diagnostics![0].call_kind).toBe('task')
          expect(summary.failure_diagnostics![0].stage).toBe('task_output_validation')
          expect(summary.failure_diagnostics![0].category).toBe('model_output_schema_error')
          expect(summary.failure_diagnostics![0].provider_code).toBeNull()
        } finally {
          globalThis.fetch = originalFetch
          await rm(tempBase, { recursive: true, force: true }).catch(() => {})
        }
      })

      it('maps acquisition malformed usage to acquisition_output_validation and model_output_schema_error', async () => {
        const base = await realpath(tmpdir())
        const tempBase = await mkdtemp(join(base, 'dsh-d2-acq-usage-err-'))
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const isolationRoot = join(tempBase, 'iso-root')

        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
          const body = JSON.parse(opts.body)
          const allText = JSON.stringify(body)
          const encoder = new TextEncoder()
          if (allText.includes('Acquisition Request:')) {
            const validCandidate = JSON.stringify({ schema_version: 1, title: 'T', summary: 'S', redaction_status: 'passed' })
            // Malformed acquisition usage (missing prompt_tokens)
            const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: validCandidate } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { invalid_usage: true } })}\n\ndata: [DONE]\n\n`
            return new Response(new ReadableStream({
              start(c) { c.enqueue(encoder.encode(sseText)); c.close() }
            }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }

          // Single task call returns valid output
          const validTaskJson = JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 0, result: { rebuild_mode: 'targeted' }, adopted_memory_ids: [], failure_code: null })
          return new Response(makeTextStream(validTaskJson), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
          expect(summary.failure_diagnostics).toHaveLength(2)
          expect(summary.failure_diagnostics![0].call_kind).toBe('task')
          expect(summary.failure_diagnostics![1].call_kind).toBe('acquisition')
          expect(summary.failure_diagnostics![1].stage).toBe('acquisition_output_validation')
          expect(summary.failure_diagnostics![1].category).toBe('model_output_schema_error')
          expect(summary.failure_diagnostics![1].provider_code).toBeNull()
        } finally {
          globalThis.fetch = originalFetch
          await rm(tempBase, { recursive: true, force: true }).catch(() => {})
        }
      })
    })

    describe('3.4 Zero Access to failure.message & Streaming Finish Error Extraction', () => {
      it('3.4.1 handles HTTP 401 provider error end-to-end with AUTH diagnostic', async () => {
        const base = await realpath(tmpdir())
        const tempBase = await mkdtemp(join(base, 'dsh-d2-http401-auth-'))
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const isolationRoot = join(tempBase, 'iso-root')

        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async () => {
          return new Response(JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: 'Forbidden secret key sk-leak-test-1234567890123456',
            },
          }), {
            status: 401,
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
          expect(summary.failure_diagnostics).toHaveLength(1)
          expect(summary.failure_diagnostics![0].category).toBe('authentication_rejected')
          expect(summary.failure_diagnostics![0].provider_code).toBe('AUTH')

          const summaryJson = JSON.stringify(summary)
          expect(summaryJson).not.toContain('sk-leak-test')
          expect(summaryJson).not.toContain('Forbidden secret key')
        } finally {
          globalThis.fetch = originalFetch
          await rm(tempBase, { recursive: true, force: true }).catch(() => {})
        }
      })

      it('3.4.2 handles SSE finish error in task stream, traps raw message with zero property access, and converts to safe LlmError', async () => {
        const base = await realpath(tmpdir())
        const tempBase = await mkdtemp(join(base, 'dsh-d2-sse-task-finish-'))
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const isolationRoot = join(tempBase, 'iso-root')

        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async () => {
          const encoder = new TextEncoder()
          // Emit SSE stream with finish_reason rate_limit
          const sseText = `data: ${JSON.stringify({
            choices: [{ finish_reason: 'rate_limit' }],
          })}\n\ndata: [DONE]\n\n`
          return new Response(new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(sseText))
              c.close()
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
          expect(summary.failure_diagnostics).toHaveLength(1)
          expect(summary.failure_diagnostics![0].call_kind).toBe('task')
          expect(summary.failure_diagnostics![0].stage).toBe('provider_stream')
          expect(summary.failure_diagnostics![0].category).toBe('rate_limited')
          expect(summary.failure_diagnostics![0].provider_code).toBe('RATE_LIMIT')
        } finally {
          globalThis.fetch = originalFetch
          await rm(tempBase, { recursive: true, force: true }).catch(() => {})
        }
      })

      it('3.4.3 handles SSE finish error in acquisition stream, traps raw message with zero property access', async () => {
        const base = await realpath(tmpdir())
        const tempBase = await mkdtemp(join(base, 'dsh-d2-sse-acq-finish-'))
        const persistenceRoot = join(tempBase, 'evidence-root')
        await mkdir(persistenceRoot, { recursive: true, mode: 0o700 })
        const isolationRoot = join(tempBase, 'iso-root')

        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
          const body = JSON.parse(opts.body)
          const allText = JSON.stringify(body)
          const encoder = new TextEncoder()
          if (allText.includes('Acquisition Request:')) {
            const sseText = `data: ${JSON.stringify({
              choices: [{ finish_reason: 'server' }],
            })}\n\ndata: [DONE]\n\n`
            return new Response(new ReadableStream({
              start(c) {
                c.enqueue(encoder.encode(sseText))
                c.close()
              },
            }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }

          // Single task call returns valid output
          const validTaskJson = JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 0, result: { rebuild_mode: 'targeted' }, adopted_memory_ids: [], failure_code: null })
          return new Response(makeTextStream(validTaskJson), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
          expect(summary.failure_diagnostics).toHaveLength(2)
          expect(summary.failure_diagnostics![0].call_kind).toBe('task')
          expect(summary.failure_diagnostics![1].call_kind).toBe('acquisition')
          expect(summary.failure_diagnostics![1].stage).toBe('provider_stream')
          expect(summary.failure_diagnostics![1].category).toBe('provider_server_error')
          expect(summary.failure_diagnostics![1].provider_code).toBe('SERVER')

          const summaryJson = JSON.stringify(summary)
          expect(summaryJson).not.toContain('sensitive stacktrace')
        } finally {
          globalThis.fetch = originalFetch
          await rm(tempBase, { recursive: true, force: true }).catch(() => {})
        }
      })
    })
  })
})
