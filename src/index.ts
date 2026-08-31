import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import { Config, type Config as PluginConfig } from './config.js'
import { install } from './observer.js'

export { Config }
export type { Config as PluginConfig }
export { AUDIT_COMMIT, COMPATIBILITY, CORDIS_VERSION, DSH_VERSION, SCHEMASTERY_VERSION } from './compatibility.js'
export const name = 'dsh-mnemosyne'
export const inject = ['llm'] as const

export function apply(ctx: Context, config: PluginConfig): void {
  if (config.enabled === false) return
  install(ctx, config)
}
