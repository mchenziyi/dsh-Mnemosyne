import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

describe('M0.5B real Tool registry path', () => {
  it('executes search to open through ctx.tools and disposes all three tools', async () => {
    const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true })
    expect(ctx.tools.get('mnemosyne_search')).toBeDefined(); expect(ctx.tools.get('mnemosyne_open')).toBeDefined()
    const searchResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05b-search'), name: 'mnemosyne_search', arguments: { query: 'compiler cache targeted rebuild' } })
    expect(searchResult.isError).toBe(false); const search = searchResult.value as { retrieval_ref: string; content_sha256: string; items: Array<{ memory_id: string }> }; expect(search.items.length).toBeGreaterThan(0)
    const openResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05b-open'), name: 'mnemosyne_open', arguments: { retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id } })
    expect(openResult.isError).toBe(false); expect((openResult.value as { level: number }).level).toBe(3)
    for (const [name, arguments_] of [
      ['mnemosyne_search', { query: 'secret=/Users/private\u0000' }],
      ['mnemosyne_search', { query: 'cache', unexpected: 'password=secret' }],
      ['mnemosyne_open', { retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id, unexpected: '/private/tmp' }],
    ] as const) {
      const invalid = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(`m05b-invalid-${name}`), name, arguments: arguments_ })
      expect(invalid.isError).toBe(true)
      expect(JSON.stringify(invalid)).not.toContain('password=secret')
      expect(JSON.stringify(invalid)).not.toContain('/private/tmp')
    }
    await fiber.dispose()
    expect(ctx.tools.get('mnemosyne_status')).toBeUndefined(); expect(ctx.tools.get('mnemosyne_search')).toBeUndefined(); expect(ctx.tools.get('mnemosyne_open')).toBeUndefined()
  })

  it('keeps disabled and independent instances isolated', async () => {
    const first = new Context(); const second = new Context()
    for (const ctx of [first, second]) { await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime) }
    const firstFiber = await first.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true })
    const secondFiber = await second.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: false })
    expect(first.tools.get('mnemosyne_search')).toBeDefined(); expect(second.tools.get('mnemosyne_search')).toBeUndefined()
    expect(second.tools.get('mnemosyne_status')).toBeUndefined(); expect(second.tools.get('mnemosyne_open')).toBeUndefined()
    await firstFiber.dispose(); await secondFiber.dispose()
  })
})
