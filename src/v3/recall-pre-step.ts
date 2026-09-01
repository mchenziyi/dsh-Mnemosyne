import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ResolvedScope, ScopeRuntime } from '../runtime-scope.js'
import type { RecallRuntimeV2, RecallResultV2 } from '../v2/recall-runtime.js'
import { readCurrentOKFGenerationV2 } from '../v2/okf-compiler.js'
import { createMapFirstRecallV3, type MapRecallDecisionV3 } from './map-first-recall.js'
import { buildRecallSubagentPromptV3, createDshSubagentFactoryV3, runDshSubagentV3 } from './dsh-subagent.js'
import { pinGenerationV3 } from './map-offer.js'

function taskText(messages: readonly UserMessage[]): string {
  return messages.filter((message) => message.source.kind === 'user').flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text)).join('\n').slice(0, 32768)
}

function recallMessage(contents: Array<{ ref: string; content: string }>): UserMessage {
  const body = contents.map((item) => `<!-- memory_ref:${item.ref} -->\n${item.content}`).join('\n\n---\n\n')
  return createUserMessage({ content: [{ type: 'text', text: `[Mnemosyne Recall v3 — plugin generated; not user authored]\n\n${body}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } })
}

function parseDecision(text: string): MapRecallDecisionV3 {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('subagent_invalid_output') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'selected_refs') || !Array.isArray((value as { selected_refs?: unknown }).selected_refs)) throw new Error('subagent_invalid_output')
  return value as MapRecallDecisionV3
}

export interface RecallPreStepHandlerV3Options {
  scopeRuntime: ScopeRuntime
  legacyRuntime: RecallRuntimeV2
  beforeRecall?: (scope: ResolvedScope, signal: AbortSignal) => Promise<void>
  onResult?: (payload: { agent: Agent; turn: number }, result: RecallResultV2) => void | Promise<void>
}

export function createRecallPreStepHandlerV3(options: RecallPreStepHandlerV3Options) {
  const factory = createDshSubagentFactoryV3()
  return async (payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.step !== 1 || payload.agent.session.header.origin === 'subagent') return decision
    const provider = payload.agent.options.provider
    const model = payload.agent.options.model
    if (!provider || !model) return decision
    const resolution = options.scopeRuntime.observeSession(payload.agent.session)
    if (resolution.status !== 'ready' || payload.signal.aborted) return decision
    await options.beforeRecall?.(resolution.scope, payload.signal)
    if (payload.signal.aborted) return decision
    const task = taskText(decision.messages)
    let legacy: RecallResultV2 | undefined
    const mapRuntime = createMapFirstRecallV3({
      invoke: async (request) => {
        const prompt = buildRecallSubagentPromptV3(request)
        const output = await runDshSubagentV3(payload.agent, { task: prompt, provider, model, signal: payload.signal }, factory)
        return parseDecision(output)
      },
      fallback: async () => {
        legacy = await options.legacyRuntime.recall({ scope: resolution.scope, task, provider, model, signal: payload.signal })
        return { status: legacy.status === 'completed' ? 'completed' : legacy.status === 'empty' ? 'no_match' : legacy.status, selected_memory_refs: legacy.selected_memory_refs, contents: [], fallback_used: true, reason_code: legacy.reason_code }
      },
    })
    let world
    try {
      world = await readCurrentOKFGenerationV2({ project_root: resolution.scope.project_root, project_scope_id: resolution.scope.project_scope_id })
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'memory_compile_not_found') return decision
      const empty = await options.legacyRuntime.recall({ scope: resolution.scope, task, provider, model, signal: payload.signal })
      await options.onResult?.({ agent: payload.agent, turn: payload.turn }, empty)
      if (empty.status === 'completed') return { kind: 'enter', messages: [empty.message, ...decision.messages] }
      return decision
    }
    const result = await mapRuntime.recall(pinGenerationV3(world), task, payload.signal)
    if (legacy) {
      await options.onResult?.({ agent: payload.agent, turn: payload.turn }, legacy)
      if (legacy.status === 'completed') return { kind: 'enter', messages: [legacy.message, ...decision.messages] }
      return decision
    }
    if (result.status !== 'completed') return decision
    const v2Result: RecallResultV2 = { status: 'completed', reason_code: null, selected_memory_refs: result.selected_memory_refs, expansion_steps: 0, message: recallMessage(result.contents) }
    await options.onResult?.({ agent: payload.agent, turn: payload.turn }, v2Result)
    return { kind: 'enter', messages: [v2Result.message, ...decision.messages] }
  }
}
