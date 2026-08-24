import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config as PluginConfig } from './config.js'
import { createOpenTool } from './open-tool.js'
import { createSearchTool } from './search-tool.js'
import { createFixtureRuntime } from './retrieval/runtime.js'
import { createStatusTool } from './status.js'
import { createScopeRuntime } from './runtime-scope.js'

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(
  ctx: Context,
  configOrCb?: PluginConfig | (() => void),
  maybeCb?: () => void
): void {
  const config: PluginConfig = typeof configOrCb === 'function' ? {} : configOrCb ?? {}
  const onSessionEvent: () => void = typeof configOrCb === 'function' ? configOrCb : maybeCb ?? (() => {})

  const scopeRuntime = createScopeRuntime({ projectRoot: config.projectRoot })
  const retrievalRuntime = createFixtureRuntime()

  ctx.effect(() => () => {
    scopeRuntime.clear()
    retrievalRuntime.clear()
  }, 'mnemosyne runtime cleanup')

  ctx.tools.register(createStatusTool(scopeRuntime))
  ctx.tools.register(createSearchTool(retrievalRuntime))
  ctx.tools.register(createOpenTool(retrievalRuntime))

  ctx.on('session/event', (session: Session) => {
    scopeRuntime.observeSession(session)
    onSessionEvent()
  })

  ctx.on('session/disposed', (session: Session) => {
    scopeRuntime.disposeSession(session)
  })
}
