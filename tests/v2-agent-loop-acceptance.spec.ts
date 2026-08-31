import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as MnemosynePlugin from '../src/index.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'

const roots: string[] = []

function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.2 real AgentLoop acceptance', () => {
  it('recalls a Session A memory in Session B through durable Title → Summary → Content disclosure', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-agent-loop-')))
    roots.push(root)

    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    const mainRequests: GenerateOptions[] = []
    let pluginFiber: { dispose(): Promise<void> } | undefined
    class AcceptanceAdapter extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'v2-acceptance' } }
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const system = options.system ?? ''
        if (system.startsWith('You navigate project memory.')) {
          const message = options.messages.at(-1)!
          const text = message.content.find((block) => block.type === 'text')?.text ?? '{}'
          const request = JSON.parse(text) as { stage: string; items: Array<{ ref: string }> }
          return textStream(JSON.stringify({ selected_refs: request.items.length === 0 ? [] : [request.items[0]!.ref] }))
        }
        if (system.startsWith('Judge whether the completed turn')) {
          const message = options.messages.at(-1)!
          const text = message.content.find((block) => block.type === 'text')?.text ?? '{}'
          const request = JSON.parse(text) as { evidence?: { task?: string } }
          return textStream(JSON.stringify(request.evidence?.task?.includes('首次遇到依赖安装失败')
            ? {
                decision: 'create', title: '删除锁文件前先定位失败来源',
                summary: '安装失败时先区分依赖约束、锁文件漂移和网络异常，避免直接重建解析树。',
                content: '## 已知踩坑\n\n未定位失败来源便删除锁文件，会造成无关依赖整体漂移。\n\n## 验证方式\n\n先执行依赖约束检查，再运行定向测试。',
                related_memory_refs: [],
              }
            : { decision: 'skip', reason_code: 'no_reusable_knowledge' }))
        }
        if (system.startsWith('Choose one offered direct child category')) {
          return textStream(JSON.stringify({ decision: 'new', title: '依赖管理', summary: '依赖安装与版本约束问题。' }))
        }
        if (system.startsWith('After reading the selected category summary')) return textStream(JSON.stringify({ decision: 'attach' }))
        mainRequests.push(options)
        return textStream('已按历史踩坑先定位依赖约束，没有删除锁文件。')
      }
    }

    let unregister: (() => void) | undefined
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(AgentRegistry))
      fibers.push(await ctx.plugin(LlmRuntime))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      unregister = ctx.llm.registerAdapter(['acceptance'], new AcceptanceAdapter())
      pluginFiber = await ctx.plugin(MnemosynePlugin, { enabled: true })

      const agentA = ctx.agentLoop.create(
        SessionId('session_accept_a'),
        { provider: 'acceptance', model: 'offline' },
        { cwd: root },
      )
      agentA.followup(createUserMessage({
        content: [{ type: 'text', text: '首次遇到依赖安装失败，定位到依赖约束后完成修复。' }],
        source: { kind: 'user' },
      }))
      await agentA.whenIdle()
      await pluginFiber.dispose()
      pluginFiber = undefined

      const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: computeProjectScopeId(root) })
      expect((await store.listMemories()).map((memory) => memory.title)).toEqual(['删除锁文件前先定位失败来源'])

      pluginFiber = await ctx.plugin(MnemosynePlugin, { enabled: true })

      const agent = ctx.agentLoop.create(
        SessionId('session_accept_b'),
        { provider: 'acceptance', model: 'offline' },
        { cwd: root },
      )
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '包一直装不上，我该从哪里下手，先别重建整个依赖解析结果。' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      const recallEvents = agent.session.events.filter((event) => {
        if (event.type !== 'user/message') return false
        const message = event.data as { source?: { kind?: string; plugin?: string; form?: string } }
        return message.source?.kind === 'plugin' && message.source.plugin === 'dsh-mnemosyne' && message.source.form === 'recall'
      })
      expect(recallEvents).toHaveLength(1)
      expect(JSON.stringify(recallEvents[0])).toContain('未定位失败来源便删除锁文件')
      expect(mainRequests).toHaveLength(2)
      expect(JSON.stringify(mainRequests[1]!.messages)).toContain('未定位失败来源便删除锁文件')
      for (const name of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open', 'mnemosyne_remember']) {
        expect(ctx.tools.get(name)).toBeUndefined()
      }
    } finally {
      await pluginFiber?.dispose()
      unregister?.()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15000)
})
