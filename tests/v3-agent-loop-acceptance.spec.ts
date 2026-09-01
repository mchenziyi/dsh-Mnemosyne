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
import { install } from '../src/observer.js'

const roots: string[] = []
function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('v3 real AgentLoop wiring', () => {
  it('injects a title map through the installed v3 observer before the parent model runs', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v3-agent-')))
    roots.push(root)
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    const requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'v3-offline' } }
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        return textStream('parent complete')
      }
    }
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] as any[] } }
    const subagentFactory = async (_parent: any, request: any) => {
      const packet = JSON.parse(request.task.split('\n').at(-1)!)
      const output = packet.stage === 'judgment' ? JSON.stringify({ decision: 'skip', reason_code: 'no_reusable_knowledge' }) : JSON.stringify({ selected_refs: [] })
      child.session.events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: output }] } } }]
      return { agent: child, dispose: async () => undefined } as any
    }
    const world = { generation_id: 'gen_' + 'a'.repeat(64), manifest: { project_scope_id: 'sha256_' + 'b'.repeat(64), catalog_id: 'catalog_' + 'c'.repeat(64) }, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }] })],
    ]) } as any
    try {
      fibers.push(await ctx.plugin(SessionStore)); fibers.push(await ctx.plugin(AgentRegistry)); fibers.push(await ctx.plugin(LlmRuntime)); fibers.push(await ctx.plugin(SystemPrompt)); fibers.push(await ctx.plugin(ToolRuntime)); fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      const unregister = ctx.llm.registerAdapter(['v3-offline'], new Adapter())
      install(ctx, { projectRoot: root }, undefined, { mode: 'v3', loadWorld: async () => world, subagentFactory })
      const agent = ctx.agentLoop.create(SessionId('v3_parent'), { provider: 'v3-offline', model: 'offline' }, { cwd: root })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '完成一个任务' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(requests.some((request) => JSON.stringify(request.messages).includes('Authentication'))).toBe(true)
      unregister()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15000)
})
