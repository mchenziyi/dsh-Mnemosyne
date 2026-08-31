import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { Config as PluginConfig } from './config.js'
import { createScopeRuntime, type ResolvedScope } from './runtime-scope.js'
import { extractAcquisitionEvidence } from './acquisition-evidence.js'
import {
  createLlmRecallNavigatorV2,
  createRecallPreStepHandlerV2,
  createRecallRuntimeV2,
  type RecallResultV2,
  type RecallRuntimeEventV2,
} from './v2/recall-runtime.js'
import { createConsolidationRuntimeV2, createLlmConsolidationModelV2 } from './v2/consolidation-runtime.js'
import { createRuntimeLoggerV2, type RuntimeLogRecordV2 } from './v2/runtime-log.js'

function timestamp(): string {
  return new Date().toISOString()
}

function turnOf(event: SessionEvent): number | null {
  const top = (event as { turn?: unknown }).turn
  if (typeof top === 'number' && Number.isInteger(top) && top > 0) return top
  const nested = (event.data as { turn?: unknown } | undefined)?.turn
  return typeof nested === 'number' && Number.isInteger(nested) && nested > 0 ? nested : null
}

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(
  ctx: Context,
  configOrCb?: PluginConfig | (() => void),
  maybeCb?: () => void,
): void {
  const config: PluginConfig = typeof configOrCb === 'function' ? {} : configOrCb ?? {}
  const onSessionEvent: () => void = typeof configOrCb === 'function' ? configOrCb : maybeCb ?? (() => {})
  const scopeRuntime = createScopeRuntime({ projectRoot: config.projectRoot })
  const logger = createRuntimeLoggerV2()
  const sessionToAgent = new Map<string, Agent>()
  const recalledByTurn = new Map<string, string[]>()
  const pending = new Set<Promise<void>>()
  const runtimeAbort = new AbortController()
  let disposed = false

  const log = (scope: ResolvedScope, record: RuntimeLogRecordV2): void => {
    void logger.log(scope, record).catch(() => undefined)
  }

  const recallRuntime = createRecallRuntimeV2({
    navigator: (request, route) => createLlmRecallNavigatorV2(ctx.llm)(request, route),
    onEvent(request, event: RecallRuntimeEventV2) {
      const base = { timestamp: timestamp() }
      if (event.event === 'recall_start') log(request.scope, { ...base, event: 'recall_start', result: 'started' })
      else if (event.event === 'recall_layer') log(request.scope, {
        ...base, event: 'recall_layer', stage: event.stage, expansion_step: event.step,
        disclosed_count: event.disclosed_refs.length, selected_count: event.selected_refs.length,
        index_refs: event.disclosed_refs, result: 'selected',
      })
      else if (event.event === 'recall_completed') log(request.scope, {
        ...base, event: 'recall_completed', result: 'completed', memory_refs: event.selected_memory_refs,
        expansion_step: event.expansion_steps,
      })
      else if (event.event === 'recall_no_match') log(request.scope, {
        ...base, event: 'recall_no_match', result: 'no_match', reason_code: 'recall_no_match', expansion_step: event.expansion_steps,
      })
      else log(request.scope, {
        ...base, event: 'recall_failed', result: 'failed', reason_code: event.reason_code, expansion_step: event.expansion_steps,
      })
    },
  })

  const recallHandler = createRecallPreStepHandlerV2({
    runtime: recallRuntime,
    scopeRuntime,
    onResult(payload, result: RecallResultV2) {
      recalledByTurn.set(`${payload.agent.session.id}:${payload.turn}`, result.selected_memory_refs)
    },
  })
  ctx.on('agent/pre-step', (payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => recallHandler(payload, next))

  const consolidationRuntime = createConsolidationRuntimeV2({
    model: (request, route) => createLlmConsolidationModelV2(ctx.llm)(request, route),
  })

  ctx.effect(() => async () => {
    disposed = true
    runtimeAbort.abort()
    await Promise.allSettled([...pending])
    await logger.dispose()
    scopeRuntime.clear()
    sessionToAgent.clear()
    recalledByTurn.clear()
  }, 'mnemosyne v2 runtime cleanup')

  ctx.on('agent/created', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (agent?.session?.id) sessionToAgent.set(String(agent.session.id), agent)
  })

  ctx.on('agent/disposed', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (agent?.session?.id) sessionToAgent.delete(String(agent.session.id))
  })

  ctx.on('session/event', async (session: Session, event: SessionEvent) => {
    if (!session) return
    const resolution = scopeRuntime.observeSession(session)
    onSessionEvent()
    if (disposed || resolution.status !== 'ready' || event?.type !== 'turn/end') return
    const reason = (event.data as { reason?: { kind?: string } | string } | undefined)?.reason
    const reasonKind = typeof reason === 'string' ? reason : reason?.kind
    if (reasonKind !== 'completed' && reasonKind !== 'stop') return
    const turn = turnOf(event)
    if (turn === null) return
    const evidence = extractAcquisitionEvidence(session, event, resolution.scope)
    if (!evidence) {
      log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'evidence_unavailable' })
      return
    }
    const agent = sessionToAgent.get(String(session.id))
    const agentOptions = (agent as { options?: { provider?: string; model?: string } } | undefined)?.options
    const provider = agentOptions?.provider ?? evidence.route.provider
    const model = agentOptions?.model ?? evidence.route.model
    if (!provider || !model) {
      log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'model_route_unavailable' })
      return
    }
    const used = recalledByTurn.get(`${session.id}:${turn}`) ?? []
    recalledByTurn.delete(`${session.id}:${turn}`)
    log(resolution.scope, { event: 'consolidation_start', timestamp: timestamp(), turn, result: 'started', memory_refs: used })
    const operation = consolidationRuntime.consolidate({
      scope: resolution.scope,
      evidence: { task: evidence.user_text, outcome: evidence.assistant_text },
      used_memory_refs: used,
      provider,
      model,
      now: evidence.turn_end_time,
      signal: runtimeAbort.signal,
    }).then((result) => {
      if (result.status === 'created') {
        log(resolution.scope, { event: 'consolidation_created', timestamp: timestamp(), turn, result: 'created', memory_refs: result.memory_id ? [result.memory_id] : [] })
        log(resolution.scope, { event: 'catalog_updated', timestamp: timestamp(), turn, result: 'created', catalog_id: result.catalog_id })
        log(resolution.scope, { event: 'generation_published', timestamp: timestamp(), turn, result: 'published', generation_id: result.generation_id })
      } else if (result.status === 'noop') {
        log(resolution.scope, { event: 'consolidation_noop', timestamp: timestamp(), turn, result: 'noop', reason_code: result.reason_code, memory_refs: result.memory_id ? [result.memory_id] : [] })
      } else if (result.status === 'skipped') {
        log(resolution.scope, { event: 'consolidation_skip', timestamp: timestamp(), turn, result: 'skipped', reason_code: result.reason_code })
      } else {
        log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: result.reason_code })
      }
    }).catch(() => {
      log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'consolidation_failed' })
    }).finally(() => pending.delete(operation))
    pending.add(operation)
  })

  ctx.on('session/disposed', (session: Session) => {
    if (!session) return
    const id = String(session.id)
    sessionToAgent.delete(id)
    for (const key of recalledByTurn.keys()) if (key.startsWith(`${id}:`)) recalledByTurn.delete(key)
    scopeRuntime.disposeSession(session)
  })
}
