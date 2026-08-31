import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { readCurrentOKFGenerationV2 } from '../src/v2/okf-compiler.js'

function expectTools(ctx: Context, enabled: boolean): void {
  for (const name of ['mnemosyne_status', 'mnemosyne_acquisition_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember']) {
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
    expectTools(ctx, false)
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
    expectTools(ctx, false)
    await fiber.update({ enabled: false })
    expectTools(ctx, false)
    await fiber.update({ enabled: true })
    expectTools(ctx, false)
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
    expectTools(first, false)
    expectTools(second, false)
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

  it('automatically consolidates a completed turn without exposing a tool', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-observer-')))
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      let call = 0
      class MockLlm extends Service {
        constructor(c: Context) { super(c, 'llm') }
        stream() {
          const payload = call++ === 0
            ? { decision: 'create', title: '构建前先验证输入', summary: '运行构建前先确认输入文件完整。', content: '## 已知踩坑\n\n缺少输入时构建结果不可信。', related_memory_refs: [] }
            : { decision: 'new', title: '构建', summary: '构建与输入校验。' }
          return (async function* () {
            const text = JSON.stringify(payload)
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      }
      await ctx.plugin(MockLlm)
      const fiber = await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['llm'], apply }, { enabled: true })
      const events: any[] = [
        { seq: 0, time: '2026-08-28T08:00:00.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
        { seq: 1, time: '2026-08-28T08:00:01.000Z', type: 'user/message', turn: 1, data: { content: [{ type: 'text', text: '修复构建输入问题' }] } },
        { seq: 2, time: '2026-08-28T08:00:02.000Z', type: 'assistant/message', turn: 1, data: { message: { content: [{ type: 'text', text: '已确认缺少输入并完成修复。' }], provider: 'p', model: 'm' } } },
        { seq: 3, time: '2026-08-28T08:00:03.000Z', type: 'turn/end', turn: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      const session: any = { id: 'session_auto_v2', header: { cwd: root }, events }
      const agent: any = { id: 'session_auto_v2', session, options: { provider: 'p', model: 'm' } }
      ctx.emit('agent/created', { agent })
      ctx.emit('session/event', session, events[3])
      await fiber.dispose()

      const projectScope = computeProjectScopeId(root)
      const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: projectScope })
      expect((await store.listMemories()).map((memory) => memory.title)).toEqual(['构建前先验证输入'])
      expect((await readCurrentOKFGenerationV2({ project_root: root, project_scope_id: projectScope })).manifest.memory_refs).toHaveLength(1)
      const log = await readFile(join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')
      expect(log).toContain('consolidation_created')
      expectTools(ctx, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
