import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from './typert.remote-client.js'

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.remote.$mount(TYPERT_REMOTE)
}

export const inject = ['remote'] as const
