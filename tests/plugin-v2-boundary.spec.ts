import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as MnemosynePlugin from '../src/index.js'

const NAMES = ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember', 'mnemosyne_list', 'mnemosyne_promote', 'mnemosyne_forget', 'mnemosyne_acquisition_status']

describe('v0.2 zero-operation plugin boundary', () => {
  it('registers no user or model-visible Mnemosyne tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    expect(MnemosynePlugin.inject).toEqual(['llm'])
    expect(MnemosynePlugin).not.toHaveProperty('createStatusTool')
    const fiber = await ctx.plugin(MnemosynePlugin, { enabled: true })
    for (const name of NAMES) expect(ctx.tools.get(name)).toBeUndefined()
    await fiber.dispose()
  })

  it('disabled instances add no runtime contribution', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(MnemosynePlugin, { enabled: false })
    for (const name of NAMES) expect(ctx.tools.get(name)).toBeUndefined()
    await fiber.dispose()
  })
})
