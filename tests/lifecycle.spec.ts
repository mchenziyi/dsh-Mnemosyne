import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

function expectTools(ctx: Context, enabled: boolean): void {
  for (const name of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember']) {
    expect(ctx.tools.get(name) !== undefined).toBe(enabled)
  }
}

describe('M0 lifecycle', () => {
  it('can load and dispose without global state', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools', 'llm'], apply }
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
    await ctx.plugin(LlmRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools', 'llm'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: false })
    expectTools(ctx, false)
    await fiber.dispose()
  })

  it('restarts cleanly when the enabled config changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools', 'llm'], apply }
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
      await ctx.plugin(LlmRuntime)
      const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools', 'llm'], apply }
      fibers.push(await ctx.plugin(plugin, { enabled: true }))
    }
    expectTools(first, true)
    expectTools(second, true)
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
  })

  it('awaits in-flight provider stream convergence during fiber dispose without leaking writes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    let providerFinallyRan = false
    class MockSlowLlm extends Service {
      constructor(c: Context) {
        super(c, 'llm')
      }
      stream(options: any) {
        return (async function* () {
          try {
            if (options.signal) {
              await new Promise((_, reject) => {
                options.signal.addEventListener('abort', () => reject(new Error('aborted')))
              })
            }
          } finally {
            providerFinallyRan = true
          }
        })()
      }
    }
    await ctx.plugin(MockSlowLlm)

    const plugin = { name: 'dsh-mnemosyne', Config, inject: ['tools', 'llm'], apply }
    const fiber = await ctx.plugin(plugin, { enabled: true })

    const session: any = {
      id: 'session_slow_disp',
      header: { cwd: '/tmp' },
      events: [
        { seq: 0, time: '2026-08-25T08:00:00.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
        { seq: 1, time: '2026-08-25T08:00:01.000Z', type: 'user/message', turn: 1, data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] } },
        { seq: 2, time: '2026-08-25T08:00:02.000Z', type: 'assistant/message', turn: 1, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'answer' }] } } },
        { seq: 3, time: '2026-08-25T08:00:03.000Z', type: 'turn/end', turn: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }
    const agent: any = { id: 'agent_1', session }

    ctx.emit('agent/created', { agent })
    ctx.emit('session/event', session, session.events[3])

    // Dispose fiber: must await provider convergence
    await fiber.dispose()
    expect(providerFinallyRan).toBe(true)
    expectTools(ctx, false)
  })
})
