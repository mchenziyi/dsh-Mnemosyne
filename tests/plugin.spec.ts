import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import * as MnemosynePlugin from '../src/index.js'

describe('MVP-05 plugin integration', () => {
  it('registers status, search, open, and remember tools with declared llm and tools dependencies', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)

    expect(MnemosynePlugin.name).toBe('dsh-mnemosyne')
    expect(MnemosynePlugin.inject).toEqual(['tools', 'llm'])

    const fiber = await ctx.plugin(MnemosynePlugin, { enabled: true, autoCapture: true })

    for (const toolName of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember']) {
      expect(ctx.tools.get(toolName)).toBeDefined()
    }

    await fiber.dispose()

    for (const toolName of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember']) {
      expect(ctx.tools.get(toolName)).toBeUndefined()
    }
  })

  it('respects enabled=false and autoCapture=false options', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)

    const fiberDisabled = await ctx.plugin(MnemosynePlugin, { enabled: false })
    expect(ctx.tools.get('mnemosyne_remember')).toBeUndefined()
    await fiberDisabled.dispose()

    const fiberNoCapture = await ctx.plugin(MnemosynePlugin, { enabled: true, autoCapture: false })
    expect(ctx.tools.get('mnemosyne_remember')).toBeDefined()
    await fiberNoCapture.dispose()
  })
})
