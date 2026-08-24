import { Context, type Plugin } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  type GenerateOptions,
  type LlmProviderInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as dshDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { isAbsolute, normalize, sep } from 'node:path'
import { assertSafeText, ProtocolValidationError } from '../protocol/canonical.js'
import { validateRealCanaryPlan, type RealCanaryPlan } from '../m05f/authorization.js'
import { validateRealCanaryAuthorizationRequest, type RealCanaryAuthorizationRequest } from '../m05f/authorization.js'

export interface ResolvedCredential {
  value: string
  source: string
}

export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

export interface CredentialService {
  resolve(ref: string): Promise<ResolvedCredential | undefined>
  describe(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export type CredentialSeamInstaller = Plugin

export interface ProviderBridgeOptions {
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
  dsh_home: string
  workspace: string
  credentialProvider?: CredentialSeamInstaller
  requiredCredentialSource?: string
}

export interface ReadyProviderBridge {
  status: 'ready'
  ctx: Context
  adapter: LlmAdapter
  dispose: () => Promise<void>
}

export interface BlockedProviderBridge {
  status: 'blocked'
  reason_code: 'real_canary_blocked_credential_isolation_unavailable'
  dispose: () => Promise<void>
}

export type RealProviderBridge = ReadyProviderBridge | BlockedProviderBridge

export class PublicSeamDelegatingAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context & { llm?: LlmRuntime },
    private readonly provider: string,
    private readonly model: string
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const llm = this.ctx.llm
    if (!llm) throw new ProtocolValidationError()
    yield* llm.stream({
      ...options,
      provider: this.provider,
      model: this.model,
    })
  }
}

function assertValidIsolatedDirectory(path: string): void {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolute(path) ||
    path.split(sep).includes('..') ||
    normalize(path).split(sep).includes('..')
  ) {
    throw new ProtocolValidationError()
  }
}

function isValidCredentialService(service: unknown): service is CredentialService {
  if (!service || typeof service !== 'object') {
    return false
  }
  const s = service as Record<string, unknown>
  return (
    typeof s.resolve === 'function' &&
    typeof s.describe === 'function' &&
    typeof s.set === 'function' &&
    typeof s.unset === 'function'
  )
}

export async function createRealProviderBridge(
  options: ProviderBridgeOptions
): Promise<RealProviderBridge> {
  const plan = validateRealCanaryPlan(options.plan)
  const auth = validateRealCanaryAuthorizationRequest(options.authorization)

  assertValidIsolatedDirectory(options.dsh_home)
  assertValidIsolatedDirectory(options.workspace)

  if (plan.runtime.model !== auth.runtime.model) {
    throw new ProtocolValidationError()
  }
  assertSafeText(plan.runtime.credential_ref, 64)
  if (plan.runtime.credential_ref.length === 0) {
    throw new ProtocolValidationError()
  }

  // Section 2.3: If isolated Credential seam cannot be mounted or verified, return stable blocked
  if (!options.credentialProvider) {
    return {
      status: 'blocked',
      reason_code: 'real_canary_blocked_credential_isolation_unavailable',
      dispose: async () => {},
    }
  }

  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<void> }> = []

  const dispose = async () => {
    let failed = false
    for (const fiber of fibers.reverse()) {
      try {
        await fiber.dispose()
      } catch {
        failed = true
      }
    }
    if (failed) {
      // Sanitized: no raw exception concatenation
      throw new Error('Provider bridge cleanup failed')
    }
  }

  // 1. Install LlmRuntime service
  try {
    const runtimeFiber = await ctx.plugin(LlmRuntime)
    fibers.push(runtimeFiber)
  } catch {
    await dispose().catch(() => {})
    return {
      status: 'blocked',
      reason_code: 'real_canary_blocked_credential_isolation_unavailable',
      dispose: async () => {},
    }
  }

  // 2. Install isolated credential provider plugin
  try {
    const credFiber = await ctx.plugin(options.credentialProvider)
    fibers.push(credFiber)
  } catch {
    return {
      status: 'blocked',
      reason_code: 'real_canary_blocked_credential_isolation_unavailable',
      dispose,
    }
  }

  // Section 2.3: Verify ctx.get("credentials") exists and resolve/describe/set/unset are complete
  const credService: unknown = ctx.get('credentials')
  if (!isValidCredentialService(credService)) {
    return {
      status: 'blocked',
      reason_code: 'real_canary_blocked_credential_isolation_unavailable',
      dispose,
    }
  }

  // CTO Review 8.1: If requiredCredentialSource is specified, verify configured=true and source matches without resolving key
  if (options.requiredCredentialSource !== undefined) {
    let desc: CredentialInfo | undefined
    try {
      desc = await credService.describe(plan.runtime.credential_ref)
    } catch {
      return {
        status: 'blocked',
        reason_code: 'real_canary_blocked_credential_isolation_unavailable',
        dispose,
      }
    }
    if (!desc || !desc.configured || desc.source !== options.requiredCredentialSource) {
      return {
        status: 'blocked',
        reason_code: 'real_canary_blocked_credential_isolation_unavailable',
        dispose,
      }
    }
  }

  // 3. Install official DeepSeek provider plugin via public root export apply ONLY after credential seam is verified
  const pluginConfig: dshDeepSeek.Config = {
    apiKeyEnv: plan.runtime.credential_ref,
    maxTokens: 4096,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 0,
    },
    models: [
      {
        id: plan.runtime.model,
        name: plan.runtime.model,
        contextWindow: 1000000,
      },
    ],
  }

  const providerFiber = await ctx.plugin(dshDeepSeek, pluginConfig)
  fibers.push(providerFiber)

  const adapter = new PublicSeamDelegatingAdapter(
    ctx as Context & { llm: LlmRuntime },
    'deepseek-official',
    plan.runtime.model
  )

  return { status: 'ready', ctx, adapter, dispose }
}
