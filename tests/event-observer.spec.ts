import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Config } from '../src/index.js'
import { install } from '../src/observer.js'

describe('M0 event observer', () => {
  it('observes session/event without retaining or printing payload', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let observedEvents = 0
    const plugin = {
      name: 'dsh-mnemosyne',
      inject: ['tools'],
      apply(inner: Context) { install(inner, () => { observedEvents += 1 }) },
    }
    const fiber = await ctx.plugin(plugin)
    ctx.emit('session/event', {} as never, { type: 'user/message', seq: 1, data: { message: { role: 'user', content: 'secret' } } } as never)
    expect(observedEvents).toBe(1)
    await fiber.dispose()
    ctx.emit('session/event', {} as never, { type: 'user/message', seq: 2, data: { message: { role: 'user', content: 'after-dispose' } } } as never)
    expect(observedEvents).toBe(1)
  })

  it('does not retain listeners across config updates', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let observedEvents = 0
    const plugin = {
      name: 'dsh-mnemosyne',
      Config,
      inject: ['tools'],
      apply(inner: Context, config: { enabled?: boolean }) {
        if (config.enabled === false) return
        install(inner, () => { observedEvents += 1 })
      },
    }
    const fiber = await ctx.plugin(plugin, { enabled: true })
    ctx.emit('session/event', {} as never, { type: 'user/message', seq: 1 } as never)
    expect(observedEvents).toBe(1)
    await fiber.update({ enabled: false })
    ctx.emit('session/event', {} as never, { type: 'user/message', seq: 2 } as never)
    expect(observedEvents).toBe(1)
    await fiber.update({ enabled: true })
    ctx.emit('session/event', {} as never, { type: 'user/message', seq: 3 } as never)
    expect(observedEvents).toBe(2)
    await fiber.dispose()
  })
})
