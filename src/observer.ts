import type { Context } from '@deepseek-ai/cordis'
import { createStatusTool } from './status.js'

/** Internal lifecycle seam used by component tests; not exported by the package. */
export function install(ctx: Context, onSessionEvent: () => void = () => {}): void {
  ctx.tools.register(createStatusTool())
  ctx.on('session/event', () => {
    onSessionEvent()
  })
}
