import { describe, expect, expectTypeOf, it } from 'vitest'
import { mkdtemp, rm, symlink, realpath, mkdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  BudgetLedger,
  createCanaryPlan,
  prepareIsolationRoot,
  runCanaryPreflight,
  validateCanarySummary,
  validateCanaryPlan,
  type AdapterFactory,
  type CanaryReceipt,
  type CanaryCallContext,
} from '../src/m05e/index.js'
import {
  FakeProvider,
  loadM05Dv2Fixtures,
  runAgentLoopEvidence,
  type M05DGroup,
} from '../src/m05d/index.js'
import { ProtocolValidationError, canonicalHash } from '../src/protocol/canonical.js'

class AdversarialAdapter extends LlmAdapter {
  constructor(private readonly response: string, private readonly delayMs = 0, private readonly observedAbort?: { value: boolean }) { super() }
  providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'adversarial' } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.delayMs) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.delayMs); options.signal?.addEventListener('abort', () => { clearTimeout(timer); if (this.observedAbort) this.observedAbort.value = true; resolve() }, { once: true }) })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.response } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class LoopingAdapter extends LlmAdapter {
  constructor(private readonly callNumber: number) { super() }
  providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'looping-test' } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const taskId = options.messages.flatMap((message) => message.content.flatMap((content) => content.type === 'text' ? [content.text] : [])).join('\n').match(/task_id:(task_[a-z0-9][a-z0-9._-]{0,63})/)?.[1] ?? 'task_build_recovery'
    const block = { type: 'tool-call' as const, id: CallId(`loop-task-fixture-${this.callNumber}`), name: 'm05d_task_fixture', arguments: JSON.stringify({ task_id: taskId }) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function factoryFor(response = JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: 'memory_unavailable' }), delayMs = 0, seen: CanaryCallContext[] = [], observedAbort?: { value: boolean }): AdapterFactory {
  const taskStates = new Map<string, { calls: number }>()
  return (context) => {
    seen.push(context)
    const taskResponse = response.includes('task_build_recovery') ? response.replaceAll('task_build_recovery', context.task_id) : response
    if (context.kind === 'task' && response.includes('memory_unavailable') && delayMs === 0) {
      const state = taskStates.get(context.run_id) ?? { calls: 0 }
      taskStates.set(context.run_id, state)
      return new FakeProvider(state)
    }
    return new AdversarialAdapter(context.kind === 'task' ? taskResponse : JSON.stringify({ title: 'Offline synthetic candidate', summary: 'A new deterministic build rule was verified.', redaction_status: 'passed' }), delayMs, observedAbort)
  }
}

describe('M0.5E D2 canary preflight failure matrix', () => {
  it('rejects plan run drift, manifest drift, and duplicate identities', async () => {
    const plan = await createCanaryPlan()
    for (const mutate of [
      (value: typeof plan) => (value.runs = value.runs.slice(1)),
      (value: typeof plan) => (value.runs[0].group = 'tool_only'),
      (value: typeof plan) => (value.fixture_manifest_sha256 = 'sha256_' + '0'.repeat(64)),
      (value: typeof plan) => (value.runs[1].run_id = value.runs[0].run_id),
    ]) {
      const invalid = structuredClone(plan); mutate(invalid); expect(() => validateCanaryPlan(invalid)).toThrow()
    }
  })

  it('freezes exactly one memory/control pair per group at seed 101 and novel acquisition', async () => {
    const plan = await createCanaryPlan()
    expect(plan.runs.map((run) => [run.group, run.task_kind, run.requested_seed, run.acquisition_case_id])).toEqual([
      ['no_memory', 'memory_dependent', 101, 'novel_candidate'], ['no_memory', 'non_memory_control', 101, 'novel_candidate'],
      ['tool_only', 'memory_dependent', 101, 'novel_candidate'], ['tool_only', 'non_memory_control', 101, 'novel_candidate'],
      ['auto_inject', 'memory_dependent', 101, 'novel_candidate'], ['auto_inject', 'non_memory_control', 101, 'novel_candidate'],
    ])
    expect(plan.budget).toEqual({ max_task_calls: 24, max_acquisition_calls: 6, max_total_calls: 30 })
    expect(plan.timeouts).toEqual({ call_timeout_ms: 30000, batch_timeout_ms: 600000 })
  })

  it('claims task/acquisition/total limits before invocation', () => {
    const ledger = new BudgetLedger(); const calls = [] as string[]
    for (let index = 0; index < 24; index++) { ledger.claim('task'); calls.push('task') }
    expect(() => ledger.claim('task')).toThrow()
    for (let index = 0; index < 6; index++) { ledger.claim('acquisition'); calls.push('acquisition') }
    expect(calls).toHaveLength(30)
    expect(() => ledger.claim('acquisition')).toThrow()
    expect(ledger.snapshot().total_calls_claimed).toBe(30)
  })

  it('does not invoke an adapter when a claim is rejected', () => {
    const ledger = new BudgetLedger(); for (let index = 0; index < 30; index++) ledger.claim(index < 24 ? 'task' : 'acquisition')
    let invoked = 0; expect(() => { ledger.claim('task'); invoked++ }).toThrow(); expect(invoked).toBe(0)
  })

  it('rejects the fifth task stream before delegating the adapter', async () => {
    let delegated = 0
    const result = await runCanaryPreflight((context) => { if (context.kind === 'task') { delegated++; return new LoopingAdapter(delegated) }; return new AdversarialAdapter(JSON.stringify({ title: 'Offline synthetic candidate', summary: 'A new deterministic build rule was verified.', redaction_status: 'passed' })) })
    expect(result.status).toBe('canary_aborted'); expect(result.reason_code).toBe('budget_exhausted'); expect(delegated).toBe(4); expect(result.ledger.task_calls_claimed).toBe(4); expect(result.receipts).toHaveLength(0)
  })

  it('keeps assertion failures out of the provider error streak', () => {
    const ledger = new BudgetLedger(); const seq = ledger.claim('task'); ledger.failedCall(seq); expect(ledger.snapshot().consecutive_provider_or_protocol_errors).toBe(1); ledger.assertionFailure(); expect(ledger.snapshot().consecutive_provider_or_protocol_errors).toBe(0); expect(ledger.isCircuitOpen()).toBe(false)
  })

  it('stops call and batch timeouts without retrying', async () => {
    const seen: CanaryCallContext[] = []; const aborted = { value: false }; const result = await runCanaryPreflight(factoryFor(undefined, 20, seen, aborted), { timeouts: { call_timeout_ms: 1, batch_timeout_ms: 2000 } })
    expect(result.status).toBe('canary_aborted'); expect(result.reason_code).toBe('call_timeout'); expect(seen).toHaveLength(1); expect(aborted.value).toBe(true)
    const batch = await runCanaryPreflight(factoryFor(undefined, 0), { timeouts: { call_timeout_ms: 100, batch_timeout_ms: 0 } })
    expect(batch.status).toBe('canary_aborted'); expect(batch.reason_code).toBe('batch_timeout'); expect(batch.receipts).toHaveLength(0)
  })

  it('passes frozen provider/model to delegate stream and fails closed on providerInfo mismatch', async () => {
    const recordedOptions: GenerateOptions[] = []
    class RecordingAdapter extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'recording' } }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        recordedOptions.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: 'memory_unavailable' }) }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    await runCanaryPreflight((context) => {
      if (context.kind === 'task') return new RecordingAdapter()
      return new AdversarialAdapter(JSON.stringify({ title: 'Offline synthetic candidate', summary: 'A new deterministic build rule was verified.', redaction_status: 'passed' }))
    })
    expect(recordedOptions.length).toBeGreaterThan(0)
    expect(recordedOptions[0].provider).toBe('deepseek-official')
    expect(recordedOptions[0].model).toBe('deepseek-v4-flash')

    // Mismatched providerInfo.id must fail closed
    class BadProviderAdapter extends LlmAdapter {
      providerInfo(_provider: string) { return { id: 'mismatched-provider-id', name: 'secret-credential-name' } }
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'unused' }
      }
    }
    const badResult = await runCanaryPreflight(() => new BadProviderAdapter())
    expect(badResult.status).toBe('canary_aborted')
    expect(badResult.reason_code).toBe('protocol_error')
    expect(JSON.stringify(badResult)).not.toContain('secret-credential-name')
  })

  it('opens circuit breaker after exactly two consecutive provider call failures and settles ledger', () => {
    const ledger = new BudgetLedger()
    const s1 = ledger.claim('task')
    ledger.failedCall(s1)
    expect(ledger.snapshot().consecutive_provider_or_protocol_errors).toBe(1)
    expect(ledger.isCircuitOpen()).toBe(false)
    const s2 = ledger.claim('task')
    ledger.failedCall(s2)
    expect(ledger.snapshot().consecutive_provider_or_protocol_errors).toBe(2)
    expect(ledger.isCircuitOpen()).toBe(true)
    expect(() => ledger.claim('task')).toThrow()
    const snapshot = ledger.snapshot()
    expect(snapshot.task_calls_claimed).toBe(2)
    expect(snapshot.failed_calls).toBe(2)
    expect(snapshot.completed_calls).toBe(0)
    expect(snapshot.total_calls_claimed).toBe(2)
  })

  it('settles completed=1 and failed=1 when first call succeeds and second call fails', async () => {
    let callIndex = 0
    const result = await runCanaryPreflight((context) => {
      callIndex++
      if (callIndex === 1) {
        return new LoopingAdapter(1)
      }
      throw new Error('second call failure')
    })
    expect(result.status).toBe('canary_aborted')
    expect(result.ledger.task_calls_claimed).toBe(2)
    expect(result.ledger.completed_calls).toBe(1)
    expect(result.ledger.failed_calls).toBe(1)
    expect(result.ledger.total_calls_claimed).toBe(2)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
  })

  it('does not treat assertion failure as provider failure or trip the breaker', async () => {
    const result = await runCanaryPreflight(factoryFor())
    expect(result.status).toBe('canary_preflight_ready')
    expect(result.receipts).toHaveLength(6)
    expect(result.ledger.task_calls_claimed).toBe(result.receipts.reduce((total, receipt) => total + receipt.model_call_count, 0))
    expect(result.ledger.acquisition_calls_claimed).toBe(6)
    expect(result.ledger.completed_calls).toBe(result.ledger.total_calls_claimed)
    expect(result.ledger.failed_calls).toBe(0)
    expect(result.ledger.consecutive_provider_or_protocol_errors).toBe(0)
  })

  it('rejects missing/duplicate usage, unknown events, duplicate finish, and malformed receipts', async () => {
    const variants = [
      [{ type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'usage', usage: { inputTokens: -1, outputTokens: 0 } }],
      [{ type: 'unknown' }],
      [{ type: 'finish', reason: { kind: 'stop' } }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', text: 'not-json' }],
    ]
    for (const chunks of variants) {
      const result = await runCanaryPreflight(() => new (class extends LlmAdapter {
        providerInfo(provider: string) { return { id: provider, name: 'adversarial' } }
        async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
          for (const chunk of chunks) yield chunk as never
        }
      })())
      expect(result.status).toBe('canary_aborted')
      expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
    }
  })

  it('rejects credential/path leakage and does not expose fixture-private fields to the factory', async () => {
    const seen: CanaryCallContext[] = []
    const secret = JSON.stringify({ schema_version: 1, task_id: 'task_build_recovery', exit_code: 0, result: { rebuild_mode: 'api_key=SECRET' }, adopted_memory_ids: [], failure_code: null })
    const result = await runCanaryPreflight(factoryFor(secret, 0, seen))
    expect(result.status).toBe('canary_aborted')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(seen.every((context) => !('expected' in context) && !('required_memory_ids' in context) && !('forbidden_memory_ids' in context))).toBe(true)
  })

  it('rejects symlink, traversal, and non-empty isolation roots', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    expect(fixtures.protocol.evaluation_id).toBe('m05_v2')
    await expect(prepareIsolationRoot('/tmp/../unsafe')).rejects.toThrow()
    await expect(prepareIsolationRoot('/tmp')).rejects.toThrow()
    const root = await mkdtemp(join(tmpdir(), 'm05e-isolation-test-'))
    const link = `${root}-link`
    await symlink(root, link)
    await expect(prepareIsolationRoot(link)).rejects.toThrow()
    await rm(link)
    await rm(root, { recursive: true })
  })

  it('returns only controlled status/reason and cleans the temporary root on success', async () => {
    const result = await runCanaryPreflight(factoryFor())
    expect(result.status).toBe('canary_preflight_ready')
    expect(result.cleanup_clean).toBe(true)
    expect(result.reason_code).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)/)
  })

  it('keeps identical plan and deterministic prefix bytes stable while duration remains non-golden', async () => {
    const first = await runCanaryPreflight(factoryFor())
    const second = await runCanaryPreflight(factoryFor())
    expect(first.plan_hash).toBe(second.plan_hash)
    expect(first.deterministic_prefix_bytes).toBe(second.deterministic_prefix_bytes)
    expect(first.receipts.every((receipt) => Number.isSafeInteger(receipt.duration_ms))).toBe(true)
  })

  it('validates summary closure and rejects recomputed-hash model tampering or provider drift', async () => {
    const summary = await runCanaryPreflight(factoryFor())
    const fixtures = await loadM05Dv2Fixtures()
    expect(() => validateCanarySummary(summary, fixtures)).not.toThrow()
    const tampered = structuredClone(summary)
    tampered.receipts[0].model.result.unknown = true
    delete (tampered.receipts[0] as unknown as Record<string, unknown>).canonical_hash
    tampered.receipts[0].canonical_hash = canonicalHash(Object.fromEntries(Object.entries(tampered.receipts[0]).filter(([key]) => key !== 'canonical_hash')))
    expect(() => validateCanarySummary(tampered, fixtures)).toThrow()
    const plan = structuredClone(summary.plan)
    plan.provider.provider = 'unexpected'
    delete (plan as unknown as Record<string, unknown>).plan_hash
    plan.plan_hash = canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'plan_hash')))
    expect(() => validateCanaryPlan(plan)).toThrow()
  })

  // --- New Tests for Call 2-Phase Settlement, Hard Timeout, Strict Prefix, Task Completion ---

  it('settles failed=1 and completed=0 when stream finishes with usage but ModelReceipt is invalid JSON', async () => {
    const result = await runCanaryPreflight(() => new (class extends LlmAdapter {
      providerInfo(p: string) { return { id: p, name: 'invalid-json' } }
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '{ invalid json syntax' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{ invalid json syntax' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('protocol_error')
    expect(result.ledger.task_calls_claimed).toBe(1)
    expect(result.ledger.completed_calls).toBe(0)
    expect(result.ledger.failed_calls).toBe(1)
    expect(result.ledger.total_calls_claimed).toBe(1)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
  })

  it('settles acquisition as failed when acquisition candidate JSON or hash is invalid', async () => {
    const result = await runCanaryPreflight((context) => {
      if (context.kind === 'task') {
        return factoryFor()(context)
      }
      // Acquisition candidate has invalid title/hash
      return new (class extends LlmAdapter {
        providerInfo(p: string) { return { id: p, name: 'acq-bad' } }
        async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
          const bad = JSON.stringify({ title: 'Tampered Title', summary: 'Invalid', redaction_status: 'passed' })
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: bad }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: bad } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      })()
    })
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('protocol_error')
    expect(result.ledger.acquisition_calls_claimed).toBe(1)
    expect(result.ledger.failed_calls).toBe(1)
    expect(result.ledger.completed_calls).toBe(result.ledger.task_calls_claimed)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
  })

  it('rejects duplicate settlement of the same claim sequence', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    ledger.transportFinished(seq)
    ledger.completeCall(seq)
    expect(() => ledger.completeCall(seq)).toThrow()
    expect(() => ledger.failedCall(seq)).toThrow()
  })

  it('guarantees all error returns have no pending claims and satisfy ledger invariants', async () => {
    const ledger = new BudgetLedger()
    const seq1 = ledger.claim('task')
    const seq2 = ledger.claim('task')
    ledger.transportFinished(seq1)
    ledger.completeCall(seq1)
    ledger.failedCall(seq2)
    const snapshot = ledger.snapshot()
    expect(snapshot.completed_calls + snapshot.failed_calls).toBe(snapshot.total_calls_claimed)
  })

  it('enforces hard call-timeout terminating uncooperative hanging adapter near call_timeout_ms', async () => {
    let factoryCalls = 0
    class HangingAdapter extends LlmAdapter {
      providerInfo(p: string) { return { id: p, name: 'hanging' } }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        // Ignores options.signal and hangs forever
        await new Promise<never>(() => {})
        yield { type: 'text-delta', index: 0, text: 'never reached' }
      }
    }
    const started = performance.now()
    const result = await runCanaryPreflight(() => {
      factoryCalls++
      return new HangingAdapter()
    }, {
      timeouts: { call_timeout_ms: 20, batch_timeout_ms: 2000 },
    })
    const elapsed = performance.now() - started
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('call_timeout')
    expect(elapsed).toBeLessThan(1000) // Much less than batch_timeout_ms (2000ms)
    expect(factoryCalls).toBe(1)
    expect(result.ledger.task_calls_claimed).toBe(1)
    expect(result.ledger.failed_calls).toBe(1)
    expect(result.ledger.completed_calls).toBe(0)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
  })

  it('allows multi-call task whose cumulative duration exceeds call_timeout as long as each call is within call_timeout', async () => {
    let callNum = 0
    const factory: AdapterFactory = (context) => {
      if (context.kind === 'task') {
        callNum++
        if (callNum === 1) {
          return new (class extends LlmAdapter {
            providerInfo(provider: string) { return { id: provider, name: 'multi-call-1' } }
            async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
              await new Promise((r) => setTimeout(r, 15))
              const block = { type: 'tool-call' as const, id: CallId('loop-1'), name: 'm05d_task_fixture', arguments: JSON.stringify({ task_id: context.task_id }) }
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
              yield { type: 'block-end', index: 0, block }
              yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
            }
          })()
        }
        return new (class extends LlmAdapter {
          providerInfo(provider: string) { return { id: provider, name: 'multi-call-2' } }
          async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
            await new Promise((r) => setTimeout(r, 15))
            const text = JSON.stringify({ schema_version: 1, task_id: context.task_id, exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: 'memory_unavailable' })
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        })()
      }
      return new AdversarialAdapter(JSON.stringify({ title: 'Offline synthetic candidate', summary: 'A new deterministic build rule was verified.', redaction_status: 'passed' }), 0)
    }
    const result = await runCanaryPreflight(factory, { timeouts: { call_timeout_ms: 25, batch_timeout_ms: 500 } })
    expect(result.receipts.length).toBeGreaterThan(0)
  })

  it('strictly preserves plan continuous prefix when run 1 fails immediately on first call', async () => {
    let factoryCount = 0
    const result = await runCanaryPreflight(() => {
      factoryCount++
      throw new Error('immediate failure on run 1')
    })
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('protocol_error')
    expect(result.receipts).toHaveLength(0)
    expect(factoryCount).toBe(1)
    const fixtures = await loadM05Dv2Fixtures()
    expect(() => validateCanarySummary(result, fixtures)).not.toThrow()
  })

  it('strictly preserves plan continuous prefix of length 1 when run 2 fails', async () => {
    let runCount = 0
    const plan = await createCanaryPlan()
    const result = await runCanaryPreflight((context) => {
      if (context.run_id === plan.runs[1].run_id) {
        throw new Error('fail run 2')
      }
      runCount++
      return factoryFor()(context)
    })
    expect(result.status).toBe('canary_aborted')
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0].run_id).toBe(plan.runs[0].run_id)
    expect(result.receipts.map((r) => r.run_id)).toEqual(plan.runs.slice(0, result.receipts.length).map((r) => r.run_id))
    const fixtures = await loadM05Dv2Fixtures()
    expect(() => validateCanarySummary(result, fixtures)).not.toThrow()
  })

  it('rejects summary when success is tampered even if canonical_hash is recomputed', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    const summary = await runCanaryPreflight(factoryFor())
    expect(() => validateCanarySummary(summary, fixtures)).not.toThrow()

    // Tamper receipt.success
    const tampered = structuredClone(summary)
    tampered.receipts[0].success = !tampered.receipts[0].success
    const { canonical_hash: _, ...body } = tampered.receipts[0]
    tampered.receipts[0].canonical_hash = canonicalHash(body)
    expect(() => validateCanarySummary(tampered, fixtures)).toThrow()

    // Tamper claim sequence
    const tamperedSeq = structuredClone(summary)
    tamperedSeq.receipts[0].claim_sequence = [999, 1000]
    const { canonical_hash: _h2, ...body2 } = tamperedSeq.receipts[0]
    tamperedSeq.receipts[0].canonical_hash = canonicalHash(body2)
    expect(() => validateCanarySummary(tamperedSeq, fixtures)).toThrow()

    // Tamper ledger completed_calls
    const tamperedLedger = structuredClone(summary)
    tamperedLedger.ledger.completed_calls -= 1
    expect(() => validateCanarySummary(tamperedLedger, fixtures)).toThrow()
  })

  it('refuses acquisition and returns protocol_error when task lacks turn/end completion event', async () => {
    let acquisitionCalled = false
    const result = await runCanaryPreflight((context) => {
      if (context.kind === 'acquisition') {
        acquisitionCalled = true
      }
      return new (class extends LlmAdapter {
        providerInfo(p: string) { return { id: p, name: 'no-turn-end' } }
        async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
          // Yields without completing turn properly
          yield { type: 'text-delta', index: 0, text: 'incomplete' }
        }
      })()
    })
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('protocol_error')
    expect(acquisitionCalled).toBe(false)
  })

  it('requires the M0.5D AgentLoop evidence shape on every Canary Receipt', () => {
    expectTypeOf<CanaryReceipt>().toHaveProperty('tool_calls')
    const requireEvidence = (receipt: CanaryReceipt): Pick<CanaryReceipt, 'tool_calls' | 'memory_events' | 'recall_source' | 'recall_context' | 'recall_receipt' | 'observed_memory_ids' | 'retrieved_memory_ids' | 'opened_memory_ids' | 'adopted_memory_ids' | 'model_call_count'> => receipt
    expect(requireEvidence).toBeTypeOf('function')
  })

  it('rejects pending directly to completeCall without transportFinished', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    expect(() => ledger.completeCall(seq)).toThrow(ProtocolValidationError)
  })

  it('allows transportFinished then completeCall successfully', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    expect(() => ledger.transportFinished(seq)).not.toThrow()
    expect(() => ledger.completeCall(seq)).not.toThrow()
    const snap = ledger.snapshot()
    expect(snap.completed_calls).toBe(1)
    expect(snap.failed_calls).toBe(0)
  })

  it('rejects duplicate transportFinished on the same sequence', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    ledger.transportFinished(seq)
    expect(() => ledger.transportFinished(seq)).toThrow(ProtocolValidationError)
  })

  it('rejects failedCall after sequence has been completed', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    ledger.transportFinished(seq)
    ledger.completeCall(seq)
    expect(() => ledger.failedCall(seq)).toThrow(ProtocolValidationError)
  })

  it('rejects completeCall after sequence has failed', () => {
    const ledger = new BudgetLedger()
    const seq = ledger.claim('task')
    ledger.failedCall(seq)
    expect(() => ledger.completeCall(seq)).toThrow(ProtocolValidationError)
  })

  it('enforces strict batch deadline across multiple task calls and uncooperative acquisition', async () => {
    let taskCalls = 0
    let acqCalls = 0
    class HangingAcqAdapter extends LlmAdapter {
      providerInfo(p: string) { return { id: p, name: 'hanging-acq' } }
      async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
        await new Promise<never>(() => {})
        yield { type: 'text-delta', index: 0, text: 'never' }
      }
    }
    const started = performance.now()
    const result = await runCanaryPreflight((context) => {
      if (context.kind === 'task') {
        taskCalls++
        if (taskCalls === 1) {
          return new (class extends LlmAdapter {
            providerInfo(p: string) { return { id: p, name: 'task-1' } }
            async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
              await new Promise((r) => setTimeout(r, 40))
              const block = { type: 'tool-call' as const, id: CallId('t1'), name: 'm05d_task_fixture', arguments: JSON.stringify({ task_id: context.task_id }) }
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
              yield { type: 'block-end', index: 0, block }
              yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
            }
          })()
        }
        return new (class extends LlmAdapter {
          providerInfo(p: string) { return { id: p, name: 'task-2' } }
          async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
            await new Promise((r) => setTimeout(r, 40))
            const text = JSON.stringify({ schema_version: 1, task_id: context.task_id, exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: 'memory_unavailable' })
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        })()
      }
      acqCalls++
      return new HangingAcqAdapter()
    }, {
      timeouts: { call_timeout_ms: 200, batch_timeout_ms: 150 },
    })
    const elapsed = performance.now() - started
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('batch_timeout')
    // Must return near batch deadline (~150ms), far less than task (80ms) + full call_timeout (200ms) = 280ms
    expect(elapsed).toBeLessThan(230)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
    const fixtures = await loadM05Dv2Fixtures()
    expect(() => validateCanarySummary(result, fixtures)).not.toThrow()
  })

  it('aborts with batch_timeout before claiming acquisition if batch budget is already exhausted', async () => {
    let taskCalls = 0
    let acqCalled = false
    const started = performance.now()
    const result = await runCanaryPreflight((context) => {
      if (context.kind === 'task') {
        taskCalls++
        return new (class extends LlmAdapter {
          providerInfo(p: string) { return { id: p, name: 'slow-task' } }
          async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
            await new Promise((r) => setTimeout(r, 60))
            const text = JSON.stringify({ schema_version: 1, task_id: context.task_id, exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: 'memory_unavailable' })
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        })()
      }
      acqCalled = true
      return new (class extends LlmAdapter {
        providerInfo(p: string) { return { id: p, name: 'acq' } }
        async *stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
          yield { type: 'text-delta', index: 0, text: '{}' }
        }
      })()
    }, {
      timeouts: { call_timeout_ms: 100, batch_timeout_ms: 50 },
    })
    const _elapsed = performance.now() - started
    expect(result.status).toBe('canary_aborted')
    expect(result.reason_code).toBe('batch_timeout')
    expect(acqCalled).toBe(false)
    expect(result.ledger.acquisition_calls_claimed).toBe(0)
    expect(result.ledger.completed_calls + result.ledger.failed_calls).toBe(result.ledger.total_calls_claimed)
    const fixtures = await loadM05Dv2Fixtures()
    expect(() => validateCanarySummary(result, fixtures)).not.toThrow()
  })

  it('fails closed when settlement callback throws and does not swallow error in ModelReceipt completion', async () => {
    const plan = await createCanaryPlan()
    const fixtures = await loadM05Dv2Fixtures()
    const task = fixtures.tasks.find((t) => t.task_id === plan.runs[0].task_id)!
    const catalog = fixtures.catalog
    const novel = fixtures.acquisitionCases.find((c) => c.case_id === 'novel_candidate')!
    
    // Inject a faulty onComplete callback that throws on the final ModelReceipt sequence
    await expect(runAgentLoopEvidence(task, plan.runs[0].group as M05DGroup, catalog, novel, 100, {
      adapterFactory: factoryFor() as unknown as import('../src/m05d/index.js').M05DAgentAdapterFactory,
      claim: (_kind, _ctx) => 1,
      onTransportFinished: () => {},
      onComplete: () => {
        throw new ProtocolValidationError()
      },
      run_id: plan.runs[0].run_id,
      requested_seed: 101,
      provider: plan.provider.provider,
      model: plan.provider.model,
    })).rejects.toThrow(ProtocolValidationError)
  })

  it('rejects prepareIsolationRoot under ancestor symlink with zero external writes', async () => {
    const base = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'm05e-sec-')))
    try {
      const safeDir = join(base, 'safe')
      const externalDir = join(base, 'external')
      await mkdir(safeDir)
      await mkdir(externalDir)
      const link = join(safeDir, 'link')
      await symlink(externalDir, link)
      const target = join(link, 'new-root')

      await expect(prepareIsolationRoot(target)).rejects.toThrow(ProtocolValidationError)

      const pathExists = async (p: string) => {
        try {
          await lstat(p)
          return true
        } catch {
          return false
        }
      }

      // Zero-write assertion on external directory
      expect(await pathExists(join(externalDir, 'new-root'))).toBe(false)
      expect(await pathExists(join(externalDir, 'new-root', 'dsh-home'))).toBe(false)
      expect(await pathExists(join(externalDir, 'new-root', 'workspace'))).toBe(false)
      expect(await pathExists(join(externalDir, 'new-root', 'receipts'))).toBe(false)

      // Deeper ancestor symlink test
      const deepTarget = join(link, 'sub', 'deep-root')
      await expect(prepareIsolationRoot(deepTarget)).rejects.toThrow(ProtocolValidationError)
      expect(await pathExists(join(externalDir, 'sub'))).toBe(false)
      expect(await pathExists(join(externalDir, 'sub', 'deep-root'))).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

