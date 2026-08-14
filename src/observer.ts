import type { Context } from '@deepseek-ai/cordis'
import { createOpenTool } from './open-tool.js'
import { createSearchTool } from './search-tool.js'
import { createFixtureRuntime } from './retrieval/runtime.js'
import { createStatusTool } from './status.js'

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(ctx: Context, onSessionEvent: () => void = () => {}): void {
  const runtime = createFixtureRuntime()
  ctx.effect(() => () => runtime.clear(), 'mnemosyne runtime cleanup')
  ctx.tools.register(createStatusTool())
  ctx.tools.register(createSearchTool(runtime))
  ctx.tools.register(createOpenTool(runtime))
  ctx.on('session/event', () => {
    onSessionEvent()
  })
}
