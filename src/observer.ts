import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
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
import { createProjectConsolidationBarrierV2 } from './v2/project-consolidation-barrier.js'
import { createMutationCoordinator } from './mutation-coordinator.js'
import { createMapOfferPreStepHandlerV3 } from './v3/recall-pre-step.js'
import { createConsolidationSubagentModelV3 } from './v3/consolidation-subagent.js'
import { createMapRecallToolRuntimeV3 } from './v3/map-recall-tool.js'
import { withRecallPolicyV3 } from './v3/recall-policy.js'
import { createDshSubagentFactoryV3, type DshSubagentFactoryV3 } from './v3/dsh-subagent.js'
import { modelUsageFromSessionEventV3, type AggregateModelUsageV3, type ModelUsageV3 } from './v3/model-usage.js'
import type { CompiledOKFGenerationV2 } from './v2/okf-compiler.js'
import { createSubagentLifecycleV3 } from './v3/subagent-lifecycle.js'
import type { ConsolidationStatusService, ConsolidationStatus } from './consolidation-status.js'

export interface ObserverInstallOptions {
  readonly mode?: 'v2' | 'v3'
  readonly loadWorld?: (scope: ResolvedScope) => Promise<CompiledOKFGenerationV2>
  readonly subagentFactory?: DshSubagentFactoryV3
}

function timestamp(): string {
  return new Date().toISOString()
}

function turnOf(event: SessionEvent): number | null {
  const top = (event as { turn?: unknown }).turn
  if (typeof top === 'number' && Number.isInteger(top) && top > 0) return top
  const nested = (event.data as { turn?: unknown } | undefined)?.turn
  return typeof nested === 'number' && Number.isInteger(nested) && nested > 0 ? nested : null
}

export function resolveParentAgentV3(sessionId: string, sessionToAgent: ReadonlyMap<string, Agent>, registry?: { get?: (id: string) => Agent | undefined; list?: () => Agent[] }, fallback?: Agent): Agent | undefined {
  const candidates = [sessionToAgent.get(sessionId), registry?.get?.(sessionId), ...(registry?.list?.() ?? []), fallback]
  return candidates.find((candidate) => candidate !== undefined && candidate.session?.header?.origin !== 'subagent' && String(candidate.session.id) === sessionId)
}

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(
  ctx: Context,
  configOrCb?: PluginConfig | (() => void),
  maybeCb?: () => void,
  installOptions: ObserverInstallOptions = {},
): void {
  const config: PluginConfig = typeof configOrCb === 'function' ? {} : configOrCb ?? {}
  const onSessionEvent: () => void = typeof configOrCb === 'function' ? configOrCb : maybeCb ?? (() => {})
  const scopeRuntime = createScopeRuntime({ projectRoot: config.projectRoot })
  const logger = createRuntimeLoggerV2()
  const sessionToAgent = new Map<string, Agent>()
  const recalledByTurn = new Map<string, string[]>()
  const handledTurns = new Set<string>()
  const visibleStatusSessions = new Set<string>()
  const consolidationBarrier = createProjectConsolidationBarrierV2()
  const consolidationCoordinator = createMutationCoordinator()
  const subagentLifecycle = createSubagentLifecycleV3()
  const subagentFactory: DshSubagentFactoryV3 | undefined = installOptions.mode === 'v3'
    ? installOptions.subagentFactory ?? createDshSubagentFactoryV3()
    : undefined
  const runtimeAbort = new AbortController()
  let disposed = false

  const hostLogger = (() => {
    try { return ctx.logger?.('dsh-mnemosyne') }
    catch { return undefined }
  })()

  const log = (scope: ResolvedScope, record: RuntimeLogRecordV2): void => {
    void logger.log(scope, record).catch(() => undefined)
  }
  const logModelUsage = (scope: ResolvedScope, modelRole: 'parent' | 'recall' | 'consolidation', usageSource: 'message' | 'attempt' | 'aggregate', usage: ModelUsageV3 | AggregateModelUsageV3, extra: Pick<RuntimeLogRecordV2, 'turn' | 'stage' | 'attempt_id' | 'event_seq'> = {}): void => {
    log(scope, {
      event: 'model_usage', timestamp: timestamp(), model_role: modelRole, usage_source: usageSource,
      uncached_input_tokens: usage.uncached_input_tokens, output_tokens: usage.output_tokens,
      ...('cache_read_tokens' in usage && usage.cache_read_tokens !== undefined ? { cache_read_tokens: usage.cache_read_tokens } : {}),
      ...('cache_write_tokens' in usage && usage.cache_write_tokens !== undefined ? { cache_write_tokens: usage.cache_write_tokens } : {}),
      ...('reasoning_tokens' in usage && usage.reasoning_tokens !== undefined ? { reasoning_tokens: usage.reasoning_tokens } : {}),
      ...('model_calls' in usage ? { model_calls: usage.model_calls, failed_attempts: usage.failed_attempts } : {}),
      ...extra,
    })
  }
  const setVisibleStatus = (session: Session, status: ConsolidationStatus, turn: number): void => {
    try {
      const service = ctx.get?.('mnemosyneStatus') as unknown as ConsolidationStatusService | undefined
      const id = String(session.id)
      service?.set(id, status, turn)
      visibleStatusSessions.add(id)
    } catch { /* status is advisory and must never affect memory work */ }
  }
  const clearVisibleStatus = (session: Session): void => {
    try {
      const service = ctx.get?.('mnemosyneStatus') as unknown as ConsolidationStatusService | undefined
      const id = String(session.id)
      service?.clear(id)
      visibleStatusSessions.delete(id)
    } catch { /* status cleanup is advisory and must never affect lifecycle */ }
  }

  const immediateDiagnostic = (attemptId: string, phase: string, reasonCode: string, elapsedMs: number): void => {
    try { hostLogger?.info(`[mnemosyne-lifecycle] attempt_id=${attemptId} phase=${phase} reason_code=${reasonCode} elapsed_ms=${elapsedMs}`) }
    catch { /* diagnostics must not affect execution */ }
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

  const mapRecallToolRuntime = installOptions.mode === 'v3' ? createMapRecallToolRuntimeV3({ scopeRuntime, legacyRuntime: recallRuntime, subagentFactory: subagentFactory ?? installOptions.subagentFactory, parentTasks: (agent) => subagentLifecycle.for(agent), onUsage: (scope, stage, usage) => {
    logModelUsage(scope, 'recall', 'aggregate', usage, { stage })
  }, onEvent: (scope, event) => {
    if (event.event === 'recall_start') log(scope, { event: 'recall_start', timestamp: timestamp(), result: 'started', route: 'map' })
    else if (event.event === 'recall_layer') log(scope, { event: 'recall_layer', timestamp: timestamp(), result: 'selected', route: 'map', stage: event.stage, disclosed_count: event.disclosed_count ?? 0, selected_count: event.selected_count ?? 0 })
    else if (event.event === 'recall_completed') log(scope, { event: 'recall_completed', timestamp: timestamp(), result: 'completed', route: 'map', selected_count: event.selected_count ?? 0 })
    else if (event.event === 'recall_no_match') log(scope, { event: 'recall_no_match', timestamp: timestamp(), result: 'no_match', route: 'map', reason_code: event.reason_code ?? 'recall_no_match' })
    else if (event.event === 'recall_fallback') log(scope, { event: 'recall_start', timestamp: timestamp(), result: 'started', route: 'legacy_fallback', fallback_reason: event.reason_code ?? 'subagent_unavailable' })
    else log(scope, { event: 'recall_failed', timestamp: timestamp(), result: 'failed', route: 'map', reason_code: event.reason_code ?? 'recall_navigation_failed' })
  } }) : undefined

  if (installOptions.mode === 'v3') {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => withRecallPolicyV3(await next()))
  }

  const recallHandlerV2 = createRecallPreStepHandlerV2({
    runtime: recallRuntime,
    scopeRuntime,
    beforeRecall: (scope) => consolidationBarrier.wait(scope.project_scope_id),
    onResult(payload, result: RecallResultV2) {
      recalledByTurn.set(`${payload.agent.session.id}:${payload.turn}`, result.selected_memory_refs)
    },
  })
  const recallHandler = installOptions.mode === 'v3' && mapRecallToolRuntime ? createMapOfferPreStepHandlerV3({
    scopeRuntime,
    loadWorld: installOptions.loadWorld,
    recallToolRuntime: mapRecallToolRuntime,
    beforeRecall: (scope) => consolidationBarrier.wait(scope.project_scope_id),
  }) : recallHandlerV2
  ctx.on('agent/pre-step', (payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => {
    if (payload.agent.session?.header?.origin === 'subagent') return Promise.resolve({ kind: 'enter', messages: payload.messages })
    return recallHandler(payload, next)
  })

  const consolidationRuntimeV2 = createConsolidationRuntimeV2({
    model: (request, route) => createLlmConsolidationModelV2(ctx.llm)(request, route),
    coordinator: consolidationCoordinator,
  })

  ctx.effect(() => async () => {
    disposed = true
    runtimeAbort.abort()
    await subagentLifecycle.waitAll()
    await consolidationBarrier.waitAll()
    await logger.dispose()
    // Release process-local status snapshots even when their sessions never
    // emit a final disposal event.
    for (const id of visibleStatusSessions) {
      try {
        const service = ctx.get?.('mnemosyneStatus') as unknown as ConsolidationStatusService | undefined
        service?.clear(id)
      } catch { /* best-effort cleanup */ }
    }
    scopeRuntime.clear()
    sessionToAgent.clear()
    recalledByTurn.clear()
    visibleStatusSessions.clear()
  }, 'mnemosyne v2 runtime cleanup')

  ctx.on('agent/created', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (agent?.session?.id) sessionToAgent.set(String(agent.session.id), agent)
    if (agent && mapRecallToolRuntime && agent.session?.header?.origin !== 'subagent' && agent.ctx?.tools) agent.ctx.tools.register(mapRecallToolRuntime.createTool() as never)
  })

  ctx.on('agent/disposed', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (agent?.session?.id) sessionToAgent.delete(String(agent.session.id))
    if (agent && agent.session?.header?.origin !== 'subagent') void subagentLifecycle.dispose(agent)
  })

  const runConsolidation = async (session: Session, resolution: { status: 'ready'; scope: ResolvedScope }, evidence: NonNullable<ReturnType<typeof extractAcquisitionEvidence>>, used: string[], agent: Agent | undefined, signal: AbortSignal, attemptId: string): Promise<void> => {
    const agentOptions = (agent as { options?: { provider?: string; model?: string } } | undefined)?.options
    const provider = agentOptions?.provider ?? evidence.route.provider
    const model = agentOptions?.model ?? evidence.route.model
    if (!provider || !model) {
      setVisibleStatus(session, 'failed', evidence.turn)
      log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn: evidence.turn, result: 'failed', reason_code: 'model_route_unavailable', attempt_id: attemptId })
      return
    }
    if (installOptions.mode === 'v3' && (!agent || !agent.ctx?.agents)) {
      setVisibleStatus(session, 'failed', evidence.turn)
      log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn: evidence.turn, result: 'failed', reason_code: 'consolidation_agent_unavailable', attempt_id: attemptId })
      return
    }
    const v3Agent = agent as Agent
    recalledByTurn.delete(`${session.id}:${evidence.turn}`)
    log(resolution.scope, { event: 'consolidation_start', timestamp: timestamp(), turn: evidence.turn, result: 'started', memory_refs: used, attempt_id: attemptId })
    setVisibleStatus(session, 'running', evidence.turn)
    const startedAt = Date.now()
    const onSubagentEvent = (event: Parameters<NonNullable<Parameters<typeof createConsolidationSubagentModelV3>[3]>>[0], detail?: Parameters<NonNullable<Parameters<typeof createConsolidationSubagentModelV3>[3]>>[1]): void => {
        const eventMap = {
          created: 'consolidation_subagent_created',
          followup_sent: 'consolidation_subagent_followup_sent',
          running: 'consolidation_subagent_diagnostic',
          error: 'consolidation_subagent_diagnostic',
          completed: 'consolidation_subagent_completed',
          timeout: 'consolidation_subagent_timeout',
          disposed: 'consolidation_subagent_disposed',
        } as const
        const phase = detail?.phase ?? (event === 'running' || event === 'error' ? event : undefined)
        const reasonCode = detail?.reason_code ?? `subagent_${event}`
        const elapsedMs = detail?.elapsed_ms ?? Date.now() - startedAt
        log(resolution.scope, {
          event: eventMap[event], timestamp: timestamp(), turn: evidence.turn,
          result: event === 'timeout' || event === 'error' ? 'failed' : 'observed',
          elapsed_ms: elapsedMs, attempt_id: attemptId,
          ...(phase === undefined ? {} : { phase }),
          ...(detail?.status === undefined ? {} : { child_status: detail.status }),
          ...(detail?.turn === undefined ? {} : { child_turn: detail.turn }),
          ...(detail?.step === undefined ? {} : { child_step: detail.step }),
          ...(detail?.reason_code === undefined ? {} : { reason_code: detail.reason_code }),
        })
        immediateDiagnostic(attemptId, phase ?? 'running', reasonCode, elapsedMs)
    }
    const subagentModel = installOptions.mode === 'v3'
      ? createConsolidationSubagentModelV3(v3Agent, subagentFactory, undefined, onSubagentEvent, false, (stage, usage) => {
        logModelUsage(resolution.scope, 'consolidation', 'aggregate', usage, { turn: evidence.turn, stage, attempt_id: attemptId })
      })
      : undefined
    const consolidationRuntime = installOptions.mode === 'v3' && subagentModel
      ? createConsolidationRuntimeV2({ model: (request, route) => {
        const elapsedMs = Date.now() - startedAt
        log(resolution.scope, { event: 'consolidation_subagent_diagnostic', timestamp: timestamp(), turn: evidence.turn, result: 'observed', phase: 'creating', stage: request.stage, elapsed_ms: elapsedMs, reason_code: 'model_callback_entered', attempt_id: attemptId })
        immediateDiagnostic(attemptId, 'creating', 'model_callback_entered', elapsedMs)
        let modelPromise: Promise<ReturnType<typeof subagentModel> extends Promise<infer T> ? T : never>
        try {
          log(resolution.scope, { event: 'consolidation_subagent_diagnostic', timestamp: timestamp(), turn: evidence.turn, result: 'observed', phase: 'creating', stage: request.stage, elapsed_ms: Date.now() - startedAt, reason_code: 'subagent_model_call_started', attempt_id: attemptId })
          immediateDiagnostic(attemptId, 'creating', 'subagent_model_call_started', Date.now() - startedAt)
          modelPromise = subagentModel(request, route)
          log(resolution.scope, { event: 'consolidation_subagent_diagnostic', timestamp: timestamp(), turn: evidence.turn, result: 'observed', phase: 'creating', stage: request.stage, elapsed_ms: Date.now() - startedAt, reason_code: 'subagent_model_promise_returned', attempt_id: attemptId })
          immediateDiagnostic(attemptId, 'creating', 'subagent_model_promise_returned', Date.now() - startedAt)
        } catch (error) {
          immediateDiagnostic(attemptId, 'creating', 'subagent_model_sync_failed', Date.now() - startedAt)
          throw error
        }
        return modelPromise.finally(() => {
          const settledElapsedMs = Date.now() - startedAt
          log(resolution.scope, { event: 'consolidation_subagent_diagnostic', timestamp: timestamp(), turn: evidence.turn, result: 'observed', phase: 'running', stage: request.stage, elapsed_ms: settledElapsedMs, reason_code: 'subagent_model_promise_settled', attempt_id: attemptId })
          immediateDiagnostic(attemptId, 'running', 'subagent_model_promise_settled', settledElapsedMs)
        })
      }, coordinator: consolidationCoordinator })
      : consolidationRuntimeV2
    const request = {
      scope: resolution.scope,
      evidence: { task: evidence.user_text, outcome: evidence.assistant_text },
      used_memory_refs: used,
      provider,
      model,
      now: evidence.turn_end_time,
      signal,
    }
    // `parent.ctx.agents.create()` already carries the parent ownership
    // context. Wrapping the whole operation in withInitiator would make the
    // registry wait on the child creation it is itself trying to publish.
    await consolidationRuntime.consolidate(request).then((result) => {
      if (result.status === 'created') {
        setVisibleStatus(session, 'created', evidence.turn)
        log(resolution.scope, { event: 'consolidation_created', timestamp: timestamp(), turn: evidence.turn, result: 'created', memory_refs: result.memory_id ? [result.memory_id] : [], elapsed_ms: Date.now() - startedAt, attempt_id: attemptId })
        log(resolution.scope, { event: 'catalog_updated', timestamp: timestamp(), turn: evidence.turn, result: 'created', catalog_id: result.catalog_id, attempt_id: attemptId })
        log(resolution.scope, { event: 'generation_published', timestamp: timestamp(), turn: evidence.turn, result: 'published', generation_id: result.generation_id, attempt_id: attemptId })
      } else if (result.status === 'noop') { setVisibleStatus(session, 'skipped', evidence.turn); log(resolution.scope, { event: 'consolidation_noop', timestamp: timestamp(), turn: evidence.turn, result: 'noop', reason_code: result.reason_code, memory_refs: result.memory_id ? [result.memory_id] : [], elapsed_ms: Date.now() - startedAt, attempt_id: attemptId })
      } else if (result.status === 'skipped') { setVisibleStatus(session, 'skipped', evidence.turn); log(resolution.scope, { event: 'consolidation_skip', timestamp: timestamp(), turn: evidence.turn, result: 'skipped', reason_code: result.reason_code, elapsed_ms: Date.now() - startedAt, attempt_id: attemptId })
      } else { setVisibleStatus(session, 'failed', evidence.turn); log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn: evidence.turn, result: 'failed', reason_code: result.reason_code, elapsed_ms: Date.now() - startedAt, attempt_id: attemptId }) }
    }).catch(() => { setVisibleStatus(session, 'failed', evidence.turn); log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn: evidence.turn, result: 'failed', reason_code: 'consolidation_failed', elapsed_ms: Date.now() - startedAt, attempt_id: attemptId }) })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!session) return
    const resolution = scopeRuntime.observeSession(session)
    onSessionEvent()
    if (!disposed && installOptions.mode === 'v3' && resolution.status === 'ready' && session.header.origin !== 'subagent') {
      const usage = modelUsageFromSessionEventV3(event)
      if (usage) {
        const seq = (event as { seq?: unknown }).seq
        logModelUsage(resolution.scope, 'parent', event.type === 'assistant/attempt' ? 'attempt' : 'message', usage, {
          ...(turnOf(event) === null ? {} : { turn: turnOf(event)! }),
          ...(typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? { event_seq: seq } : {}),
        })
      }
    }
    if (disposed || resolution.status !== 'ready' || session.header.origin === 'subagent' || event?.type !== 'turn/end') return
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
    const resolutionStartedAt = Date.now()
    if (installOptions.mode === 'v3') log(resolution.scope, { event: 'agent_resolution_started', timestamp: timestamp(), turn, result: 'started', elapsed_ms: 0 })
    let registry: { get?: (id: string) => Agent | undefined; list?: () => Agent[] } | undefined
    try {
      registry = (ctx as unknown as { agents?: { get?: (id: string) => Agent | undefined; list?: () => Agent[] } }).agents
        ?? (ctx.get?.('agents') as unknown as { get?: (id: string) => Agent | undefined; list?: () => Agent[] } | undefined)
    } catch { registry = undefined }
    let fallbackAgent: Agent | undefined
    try {
      fallbackAgent = (ctx as unknown as { agent?: Agent }).agent
    } catch {
      fallbackAgent = undefined
    }
    const agent = resolveParentAgentV3(String(session.id), sessionToAgent, registry, fallbackAgent)
    const parentAgent = agent && agent.session?.header?.origin !== 'subagent' && String(agent.session.id) === String(session.id) ? agent : undefined
    if (installOptions.mode === 'v3') {
      if (!parentAgent || !parentAgent.ctx?.agents) {
        log(resolution.scope, { event: 'agent_resolution_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'consolidation_agent_unavailable', elapsed_ms: Date.now() - resolutionStartedAt })
        log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'consolidation_agent_unavailable' })
        return
      }
      log(resolution.scope, { event: 'agent_resolution_succeeded', timestamp: timestamp(), turn, result: 'succeeded', elapsed_ms: Date.now() - resolutionStartedAt })
    }
    const key = `${session.id}:${turn}`
    if (handledTurns.has(key)) return
    handledTurns.add(key)
    const attemptId = `a_${randomUUID().replaceAll('-', '')}`
    const selectedAgent = parentAgent ?? agent
    const parentTasks = installOptions.mode === 'v3' && selectedAgent ? subagentLifecycle.for(selectedAgent) : undefined
    const operationSignal = parentTasks ? AbortSignal.any([runtimeAbort.signal, parentTasks.signal]) : runtimeAbort.signal
    const used = selectedAgent && mapRecallToolRuntime ? mapRecallToolRuntime.consumeUsedRefs(selectedAgent, evidence.turn) : recalledByTurn.get(`${session.id}:${evidence.turn}`) ?? []
    if (installOptions.mode !== 'v3') {
      const operation = runConsolidation(session, resolution, evidence, used, selectedAgent, operationSignal, attemptId)
      consolidationBarrier.track(resolution.scope.project_scope_id, operation)
      return
    }
    let settleOperation!: () => void
    const operation = new Promise<void>((resolve) => { settleOperation = resolve })
    if (parentTasks) void parentTasks.track(operation).catch(() => undefined)
    consolidationBarrier.track(resolution.scope.project_scope_id, operation)
    log(resolution.scope, { event: 'consolidation_operation_registered', timestamp: timestamp(), turn, result: 'started', attempt_id: attemptId })
    immediateDiagnostic(attemptId, 'scheduled', 'consolidation_operation_registered', 0)
    log(resolution.scope, { event: 'consolidation_operation_scheduled', timestamp: timestamp(), turn, result: 'started', attempt_id: attemptId })
    immediateDiagnostic(attemptId, 'scheduled', 'consolidation_operation_scheduled', 0)
    setImmediate(() => {
      log(resolution.scope, { event: 'consolidation_operation_started', timestamp: timestamp(), turn, result: 'started', attempt_id: attemptId })
      immediateDiagnostic(attemptId, 'running', 'consolidation_operation_started', 0)
      if (operationSignal.aborted) {
        setVisibleStatus(session, 'failed', evidence.turn)
        log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'subagent_aborted', attempt_id: attemptId })
        settleOperation()
        return
      }
      void runConsolidation(session, resolution, evidence, used, selectedAgent, operationSignal, attemptId).then(settleOperation, () => {
        log(resolution.scope, { event: 'consolidation_failed', timestamp: timestamp(), turn, result: 'failed', reason_code: 'consolidation_failed', attempt_id: attemptId })
        settleOperation()
      })
    })
  })

  // DSH dispatches session/event asynchronously, but awaits session/flush
  // before tearing down the session. Keep the parent-owned consolidation
  // operation alive until its durable checkpoint has completed.
  ctx.on('session/flush', async (session: Session) => {
    // Child request checkpoints must not wait for the consolidation that owns
    // the child. Other session/flush listeners still persist its event log.
    if (!session || disposed || session.header.origin === 'subagent') return
    const resolution = scopeRuntime.observeSession(session)
    if (resolution.status === 'ready') await consolidationBarrier.wait(resolution.scope.project_scope_id)
  })

  ctx.on('session/disposed', (session: Session) => {
    if (!session) return
    const id = String(session.id)
    clearVisibleStatus(session)
    const agent = sessionToAgent.get(id)
    sessionToAgent.delete(id)
    if (agent && mapRecallToolRuntime) mapRecallToolRuntime.clearAgent(agent)
    for (const key of recalledByTurn.keys()) if (key.startsWith(`${id}:`)) recalledByTurn.delete(key)
    for (const key of handledTurns) if (key.startsWith(`${id}:`)) handledTurns.delete(key)
    scopeRuntime.disposeSession(session)
  })
}
