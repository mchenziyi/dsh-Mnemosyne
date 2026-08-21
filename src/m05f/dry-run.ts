import { rm, lstat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  LlmAdapter,
  LlmError,
  LlmRuntime,
  type GenerateOptions,
  type LlmProviderInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as dshDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { BudgetLedger, prepareIsolationRoot, type IsolationPaths } from '../m05e/index.js'
import { ProtocolValidationError } from '../protocol/canonical.js'

export interface IsolatedDryRunResult {
  status: 'dry_run_success' | 'dry_run_failed'
  provider_route: 'deepseek-official'
  model_resolved: string
  max_tokens_configured: number
  max_retries_configured: number
  real_stream_calls: number
  credential_resolve_calls: number
  network_calls: number
  cleanup_clean: boolean
}

let isDryRunActive = false

class SafeDryRunAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'SafeDryRun' }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: ['RATE_LIMIT', 'EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 10,
      maxDelayMs: 50,
      jitterRatio: 0,
    }
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'dry-run-ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'dry-run-ok' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function runIsolatedProfileDryRun(options: {
  isolation_root: string
  model: string
  max_tokens: number
  max_retries: number
  _injectTrap?: 'credential_resolve' | 'stream' | 'network'
  _injectTrapInTeardown?: 'credential_resolve' | 'network'
  _injectDisposerTrap?: { target: 'provider' | 'runtime'; action: 'fetch' | 'credential_resolve' }
  _injectDisposerError?: { target: 'provider' | 'runtime' }
  _onProviderDisposeCalled?: () => void
  _onRuntimeDisposeCalled?: () => void
  _extraStreamCall?: boolean
}): Promise<IsolatedDryRunResult> {
  // Module-level Single-Run Gate to prevent concurrent dry-run execution
  if (isDryRunActive) {
    throw new ProtocolValidationError()
  }
  isDryRunActive = true

  let paths: IsolationPaths | undefined
  let credentialResolveCalls = 0
  let realStreamCalls = 0
  let networkCalls = 0
  let disposerTrapViolation = false
  let cleanupClean = false

  // Capture original function references
  const origFetch = globalThis.fetch
  const origHttpRequest = http.request
  const origHttpsRequest = https.request
  const origNetConnect = net.connect

  globalThis.fetch = (async (...args: Parameters<typeof origFetch>) => {
    networkCalls++
    throw new ProtocolValidationError()
  }) as typeof origFetch

  http.request = ((...args: unknown[]) => {
    networkCalls++
    throw new ProtocolValidationError()
  }) as typeof http.request

  https.request = ((...args: unknown[]) => {
    networkCalls++
    throw new ProtocolValidationError()
  }) as typeof https.request

  net.connect = ((...args: unknown[]) => {
    networkCalls++
    throw new ProtocolValidationError()
  }) as typeof net.connect

  let offStreamObserver: (() => void) | undefined
  const ctx = new Context()
  let runtimeFiber: { dispose(): Promise<void> } | undefined
  let providerFiber: { dispose(): Promise<void> } | undefined
  let unregisterSmokeAdapter: (() => void) | undefined

  const disposeOnce = async (getAndClearFiber: () => { dispose(): Promise<void> } | undefined) => {
    const fiber = getAndClearFiber()
    if (fiber) {
      await fiber.dispose()
    }
  }

  const disposeProviderOnce = () =>
    disposeOnce(() => {
      const fiber = providerFiber
      providerFiber = undefined
      return fiber
    })

  const disposeRuntimeOnce = () =>
    disposeOnce(() => {
      const fiber = runtimeFiber
      runtimeFiber = undefined
      return fiber
    })

  const unregisterSmokeAdapterOnce = () => {
    const unregister = unregisterSmokeAdapter
    unregisterSmokeAdapter = undefined
    if (unregister) {
      unregister()
    }
  }

  const offStreamObserverOnce = () => {
    const off = offStreamObserver
    offStreamObserver = undefined
    if (off) {
      off()
    }
  }

  try {
    paths = await prepareIsolationRoot(options.isolation_root)

    try {
      // 1. Install LlmRuntime
      runtimeFiber = await ctx.plugin(LlmRuntime)

      // 2. Install real observer on the public DSH llm/stream waterfall
      offStreamObserver = ctx.on('llm/stream', (_streamOpts, next) => {
        realStreamCalls++
        return next()
      })

      // 3. Install Fake Credential service that tracks resolve calls (must be 0)
      ctx.provide('credentials')
      ctx.set('credentials', {
        resolve: async (_ref: string) => {
          credentialResolveCalls++
          throw new ProtocolValidationError()
        },
      })

      // 4. Install official DeepSeek provider plugin with explicit limits
      const pluginConfig = {
        maxTokens: options.max_tokens,
        retryPolicy: {
          mode: 'normal' as const,
          maxRetries: options.max_retries,
        },
        models: [
          {
            id: options.model,
            name: options.model,
            contextWindow: 1000000,
          },
        ],
      }

      providerFiber = await ctx.plugin(dshDeepSeek, pluginConfig)

      // Attach Disposer Traps if requested for tests (ensuring original disposer always executes)
      if (providerFiber) {
        const origPDispose = providerFiber.dispose.bind(providerFiber)
        providerFiber.dispose = async () => {
          try {
            if (options._injectDisposerTrap?.target === 'provider') {
              if (options._injectDisposerTrap?.action === 'fetch') {
                await globalThis.fetch('https://api.deepseek.com/disposer-leak')
              } else if (options._injectDisposerTrap?.action === 'credential_resolve') {
                const creds = ctx.get('credentials') as { resolve(ref: string): Promise<unknown> }
                await creds.resolve('DEEPSEEK_API_KEY')
              }
            }
          } catch {
            disposerTrapViolation = true
          }

          if (options._injectDisposerError?.target === 'provider') {
            options._onProviderDisposeCalled?.()
            throw new Error('disposer internal failure')
          }

          await origPDispose()
          options._onProviderDisposeCalled?.()
        }
      }

      if (runtimeFiber) {
        const origRDispose = runtimeFiber.dispose.bind(runtimeFiber)
        runtimeFiber.dispose = async () => {
          try {
            if (options._injectDisposerTrap?.target === 'runtime') {
              if (options._injectDisposerTrap?.action === 'fetch') {
                await globalThis.fetch('https://api.deepseek.com/disposer-leak')
              } else if (options._injectDisposerTrap?.action === 'credential_resolve') {
                const creds = ctx.get('credentials') as { resolve(ref: string): Promise<unknown> }
                await creds.resolve('DEEPSEEK_API_KEY')
              }
            }
          } catch {
            disposerTrapViolation = true
          }

          if (options._injectDisposerError?.target === 'runtime') {
            options._onRuntimeDisposeCalled?.()
            throw new Error('disposer internal failure')
          }

          await origRDispose()
          options._onRuntimeDisposeCalled?.()
        }
      }

      const llm = (ctx as Context & { llm: LlmRuntime }).llm
      if (!llm) throw new ProtocolValidationError()

      // 5. Actively verify listProviders() contains deepseek-official
      const providers = llm.listProviders()
      const hasRoute = providers.some((p: { id: string }) => p.id === 'deepseek-official')
      if (!hasRoute) throw new ProtocolValidationError()

      // 6. Actively verify model resolution
      const resolvedModel = await dshDeepSeek.resolveAdapterOptions(pluginConfig)
      if (resolvedModel.maxTokens !== options.max_tokens) throw new ProtocolValidationError()
      if (
        resolvedModel.retryPolicy?.mode !== 'normal' ||
        resolvedModel.retryPolicy.maxRetries !== options.max_retries
      ) {
        throw new ProtocolValidationError()
      }

      const targetModel = resolvedModel.models.find((m: { id: string }) => m.id === options.model)
      if (!targetModel) throw new ProtocolValidationError()

      // 7. Verify stream call through public llm/stream waterfall exactly once
      const dryRunSmokeAdapter = new SafeDryRunAdapter()
      unregisterSmokeAdapter = llm.registerAdapter(['safe-dry-run-provider'], dryRunSmokeAdapter)

      const runStreamSmoke = async () => {
        for await (const chunk of llm.stream({
          provider: 'safe-dry-run-provider',
          model: 'safe-dry-run-model',
          messages: [createUserMessage({ content: [{ type: 'text', text: 'smoke' }], source: { kind: 'user' } })],
        })) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            throw new ProtocolValidationError()
          }
        }
      }

      await runStreamSmoke()

      if (options._extraStreamCall) {
        await runStreamSmoke()
      }

      // Direct invocation trap injection for tests
      if (options._injectTrap === 'credential_resolve') {
        const creds = ctx.get('credentials') as { resolve(ref: string): Promise<unknown> }
        await creds.resolve('DEEPSEEK_API_KEY').catch(() => {})
      } else if (options._injectTrap === 'network') {
        await globalThis.fetch('https://api.deepseek.com/chat/completions').catch(() => {})
      }

      if (credentialResolveCalls > 0 || realStreamCalls !== 1 || networkCalls > 0) {
        throw new ProtocolValidationError()
      }

      // 8. Ordered Teardown while traps are still active
      unregisterSmokeAdapterOnce()

      // Step 8a: Dispose DeepSeek Provider plugin once
      await disposeProviderOnce()

      // Step 8b: While Runtime is still active, verify route unregistration
      const providersAfter = llm.listProviders()
      const stillHasRoute = providersAfter.some((p: { id: string }) => p.id === 'deepseek-official')
      if (stillHasRoute) {
        throw new ProtocolValidationError()
      }

      // Step 8c: Dispose LlmRuntime once
      await disposeRuntimeOnce()

      // Step 8d: Remove isolation directory from disk and verify
      if (paths) {
        await rm(paths.root, { recursive: true, force: false })
        const exists = await lstat(paths.root).catch(() => null)
        if (exists) {
          cleanupClean = false
          throw new ProtocolValidationError()
        }
      }
      cleanupClean = true

      // Step 8e: Verify no disposer trap violations occurred
      if (disposerTrapViolation || credentialResolveCalls > 0 || realStreamCalls !== 1 || networkCalls > 0) {
        throw new ProtocolValidationError()
      }
    } catch {
      throw new ProtocolValidationError()
    } finally {
      let teardownError: unknown = null
      try {
        unregisterSmokeAdapterOnce()
      } catch (e) {
        teardownError = teardownError ?? e
      }
      try {
        await disposeProviderOnce()
      } catch (e) {
        teardownError = teardownError ?? e
      }
      try {
        await disposeRuntimeOnce()
      } catch (e) {
        teardownError = teardownError ?? e
      }
      try {
        offStreamObserverOnce()
      } catch (e) {
        teardownError = teardownError ?? e
      }
      if (teardownError) {
        throw new ProtocolValidationError()
      }
    }
  } finally {
    // Always restore module gate and traps in outer finally
    isDryRunActive = false

    globalThis.fetch = origFetch
    http.request = origHttpRequest
    https.request = origHttpsRequest
    net.connect = origNetConnect

    if (paths && !cleanupClean) {
      await rm(paths.root, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    status: 'dry_run_success',
    provider_route: 'deepseek-official',
    model_resolved: options.model,
    max_tokens_configured: options.max_tokens,
    max_retries_configured: options.max_retries,
    real_stream_calls: realStreamCalls,
    credential_resolve_calls: credentialResolveCalls,
    network_calls: networkCalls,
    cleanup_clean: cleanupClean,
  }
}

export class CountingFakeAdapter extends LlmAdapter {
  public outboundRequests = 0
  public retries = 0

  constructor(
    private readonly scenario: 'success' | 'non_retryable_error' | 'retryable_error',
    private readonly maxRetries = 0
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'CountingFake' }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: this.maxRetries,
      retryableCodes: ['RATE_LIMIT', 'EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 10,
      maxDelayMs: 50,
      jitterRatio: 0,
    }
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.outboundRequests++
    if (this.outboundRequests > 1) {
      this.retries++
    }

    if (this.scenario === 'non_retryable_error') {
      throw new LlmError('Invalid request parameters', 'INVALID_REQUEST')
    }

    if (this.scenario === 'retryable_error') {
      throw new LlmError('Rate limit exceeded', 'RATE_LIMIT', {
        status: 429,
        providerRetryAfterMs: 50,
      })
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'counting-fake-response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'counting-fake-response' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function runCountingFakeZeroRetryProof(options: {
  scenario: 'success' | 'non_retryable_error' | 'retryable_error'
  ledger?: BudgetLedger
}): Promise<{
  successful_claims: number
  outbound_requests: number
  automatic_retries: number
}> {
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<void> }> = []
  const ledger = options.ledger ?? new BudgetLedger()
  const countingAdapter = new CountingFakeAdapter(options.scenario, 0)

  try {
    fibers.push(await ctx.plugin(LlmRuntime))
    const llm = (ctx as Context & { llm: LlmRuntime }).llm
    const unregister = llm.registerAdapter(['counting-provider'], countingAdapter)

    // Simulate 1 Ledger Claim via real BudgetLedger
    const sequence = ledger.claim('task')

    let streamFailed = false
    try {
      for await (const chunk of llm.stream({
        provider: 'counting-provider',
        model: 'counting-model',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } })],
      })) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          streamFailed = true
        }
      }
      if (streamFailed) {
        ledger.failedCall(sequence)
      } else {
        ledger.transportFinished(sequence)
        ledger.completeCall(sequence)
      }
    } catch (err) {
      ledger.failedCall(sequence, err)
    }

    unregister()
  } finally {
    for (const fiber of fibers) {
      await fiber.dispose().catch(() => {})
    }
  }

  const snapshot = ledger.snapshot()
  return {
    successful_claims: snapshot.task_calls_claimed,
    outbound_requests: countingAdapter.outboundRequests,
    automatic_retries: countingAdapter.retries,
  }
}
