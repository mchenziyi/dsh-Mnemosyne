import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

describe('M0 lifecycle', () => {
  it('can load and dispose without global state', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: true })
    expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m0-status'), name: 'mnemosyne_status', arguments: {} })
    expect(result.value).toEqual({
      plugin: 'dsh-Mnemosyne', version: '0.0.0-dev', protocol_version: 1,
      memory_enabled: false, status: 'ready',
    })
    await fiber.dispose()
    expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
  })

  it('disabled instances register no contributions', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: false })
    expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
    await fiber.dispose()
  })

  it('restarts cleanly when the enabled config changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: true })
    expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
    await fiber.update({ enabled: false })
    expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
    await fiber.update({ enabled: true })
    expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
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
    expect(first.tools.get('mnemosyne_status')).toBeDefined()
    expect(second.tools.get('mnemosyne_status')).toBeDefined()
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
  })
})
