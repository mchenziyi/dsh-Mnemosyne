import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config as PluginConfig } from './config.js'
import { createOpenTool } from './open-tool.js'
import { createSearchTool } from './search-tool.js'
import { createProductionRetrievalRuntime } from './okf-retrieval-runtime.js'
import { createStatusTool } from './status.js'
import { createScopeRuntime } from './runtime-scope.js'
import { createRememberTool } from './remember-tool.js'
import { createAcquisitionRuntime } from './acquisition-runtime.js'
import { createCandidateWriter } from './candidate-writer.js'
import { createManagementRuntime } from './management-runtime.js'
import { createForgetTool, createListTool, createPromoteTool } from './management-tools.js'

import { createMutationCoordinator } from './mutation-coordinator.js'

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(
  ctx: Context,
  configOrCb?: PluginConfig | (() => void),
  maybeCb?: () => void
): void {
  const config: PluginConfig = typeof configOrCb === 'function' ? {} : configOrCb ?? {}
  const onSessionEvent: () => void = typeof configOrCb === 'function' ? configOrCb : maybeCb ?? (() => {})

  let llmRuntime: any = undefined
  try {
    llmRuntime = ctx.llm
  } catch {}

  const scopeRuntime = createScopeRuntime({ projectRoot: config.projectRoot })
  const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
  const coordinator = createMutationCoordinator()
  const candidateWriter = createCandidateWriter({ coordinator })
  const acquisitionRuntime = createAcquisitionRuntime({
    scopeRuntime,
    llm: llmRuntime,
    writer: candidateWriter,
    autoCapture: config.autoCapture,
  })
  const managementRuntime = createManagementRuntime({
    scopeRuntime,
    coordinator,
    onForgetCommitted: () => {
      retrievalRuntime.clear()
    },
  })

  const sessionToAgent = new Map<string, Agent>()

  ctx.effect(() => async () => {
    await acquisitionRuntime.dispose()
    await managementRuntime.dispose()
    retrievalRuntime.clear()
    scopeRuntime.clear()
    sessionToAgent.clear()
  }, 'mnemosyne runtime cleanup')

  ctx.tools.register(createStatusTool(scopeRuntime))
  ctx.tools.register(createSearchTool(retrievalRuntime))
  ctx.tools.register(createOpenTool(retrievalRuntime))
  ctx.tools.register(createRememberTool({ scopeRuntime, writer: candidateWriter }))
  ctx.tools.register(createListTool(managementRuntime))
  ctx.tools.register(createPromoteTool(managementRuntime))
  ctx.tools.register(createForgetTool(managementRuntime))

  ctx.on('agent/created', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (!agent) return
    const sid = agent.session?.id ? String(agent.session.id) : String(agent.id)
    if (sid) {
      sessionToAgent.set(sid, agent)
    }
  })

  ctx.on('agent/disposed', (payload: { agent: Agent }) => {
    const agent = payload?.agent
    if (!agent) return
    const sid = agent.session?.id ? String(agent.session.id) : String(agent.id)
    if (sid) {
      sessionToAgent.delete(sid)
    }
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!session) return
    scopeRuntime.observeSession(session)
    if (event && event.type === 'turn/end') {
      const endData = event.data as { reason?: { kind?: string } } | undefined
      if (endData?.reason?.kind === 'completed') {
        const sid = session.id ? String(session.id) : ''
        if (sessionToAgent.has(sid)) {
          acquisitionRuntime.enqueueTurn(session, event)
        }
      }
    }
    onSessionEvent()
  })

  ctx.on('session/disposed', (session: Session) => {
    if (!session) return
    const sid = session.id ? String(session.id) : ''
    if (sid) {
      sessionToAgent.delete(sid)
    }
    scopeRuntime.disposeSession(session)
  })
}
