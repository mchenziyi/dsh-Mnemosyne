import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

function expectTools(ctx: Context, enabled: boolean): void {
  for (const name of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open']) {
    expect(ctx.tools.get(name) !== undefined).toBe(enabled)
  }
}

describe('M0 lifecycle', () => {
  it('can load and dispose without global state', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: true })
    expectTools(ctx, true)
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m0-status'), name: 'mnemosyne_status', arguments: {} })
    expect(result.value).toEqual({
      plugin: 'dsh-Mnemosyne',
      version: '0.0.0-dev',
      protocol_version: 3,
      memory_enabled: true,
      status: 'ready',
      scope: {
        status: 'unavailable',
        source: 'none',
        project_scope_id: null,
        session_scope_id: null,
        reason: 'missing_agent',
      },
      memory: {
        availability: 'unavailable',
        generation_id: null,
        short_term_count: 0,
        long_term_count: 0,
        total_count: 0,
        reason: 'missing_agent',
      },
    })
    await fiber.dispose()
    expectTools(ctx, false)
  })

  it('disabled instances register no contributions', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: false })
    expectTools(ctx, false)
    await fiber.dispose()
  })

  it('restarts cleanly when the enabled config changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: true })
    expectTools(ctx, true)
    await fiber.update({ enabled: false })
    expectTools(ctx, false)
    await fiber.update({ enabled: true })
    expectTools(ctx, true)
    await fiber.dispose()
  })

  it('keeps two root contexts isolated', async () => {
    const first = new Context()
    const second = new Context()
    const fibers = []
    for (const ctx of [first, second]) {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
      fibers.push(await ctx.plugin(plugin, { enabled: true }))
    }
    expectTools(first, true)
    expectTools(second, true)
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
  })
})
