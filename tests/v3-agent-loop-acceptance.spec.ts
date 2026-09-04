import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { ToolCallId, createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
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
function toolCallStream(mapRef: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call_mnemosyne_recall'), name: 'mnemosyne_recall', argumentsDelta: JSON.stringify({ map_ref: mapRef }) }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call_mnemosyne_recall'), name: 'mnemosyne_recall', arguments: JSON.stringify({ map_ref: mapRef }) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('v3 real AgentLoop wiring', () => {
  it.each([
    { checkpoints: false, decision: 'skip' },
    { checkpoints: true, decision: 'skip' },
    { checkpoints: true, decision: 'create' },
    { checkpoints: true, decision: 'missing_refs' },
  ])('completes parent-owned consolidation: $decision, checkpoints=$checkpoints', async ({ checkpoints, decision }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v3-alpha4-')))
    roots.push(root)
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    let pluginFiber: { dispose(): Promise<void> } | undefined
    let childCalls = 0
    let childFlushes = 0
    class Adapter extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'v3-alpha4-offline' } }
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (JSON.stringify(options.messages).includes('Mnemosyne Consolidation Subagent')) {
          expect(options.system).toContain('You are a memory-processing subagent, not a coding agent.')
          expect(options.system).not.toContain('Parent coding agent identity.')
          expect(options.system).not.toContain('Injected coding instructions.')
          expect(options.system).toContain('Your final response MUST be exactly one JSON object')
          expect(options.system).not.toContain('完成普通任务')
          expect(options.system).not.toContain('parent complete')
          expect(options.tools ?? []).toEqual([])
          childCalls++
          if (checkpoints) expect(childFlushes).toBeGreaterThan(0)
          if (decision === 'create' || decision === 'missing_refs') {
            const prompt = options.messages.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).find((text) => text.startsWith('You are the Mnemosyne Consolidation Subagent.'))!
            const request = JSON.parse(prompt.split('\n').at(-1)!)
            if (request.stage !== 'judgment') expect(options.system).not.toContain('For create, all five keys are required')
            if (request.stage === 'judgment') {
              expect(options.system).toContain('related_memory_refs is mandatory even when there are no related memories; emit []')
              return textStream(JSON.stringify({ decision: 'create', title: 'JSONL 容错', summary: '逐行隔离解析错误。', content: '## 已知踩坑\n单行解析失败不能中断后续统计。', ...(decision === 'create' ? { related_memory_refs: [] } : {}) }))
            }
            if (request.stage === 'category_titles') return textStream('{"decision":"no_candidate"}')
            if (request.stage === 'category_new') return textStream('{"decision":"new","title":"数据处理","summary":"流式数据处理经验。"}')
            return textStream('{"decision":"attach"}')
          }
          return textStream(JSON.stringify({ decision: 'skip', reason_code: 'no_reusable_knowledge' }))
        }
        expect(options.system).toContain('Parent coding agent identity.')
        expect(options.system).toContain('Injected coding instructions.')
        expect(options.system).not.toContain('You are a memory-processing subagent')
        return textStream('parent complete')
      }
    }
    let unregister: (() => void) | undefined
    try {
      fibers.push(await ctx.plugin(SessionStore)); fibers.push(await ctx.plugin(AgentRegistry)); fibers.push(await ctx.plugin(LlmRuntime)); fibers.push(await ctx.plugin(SystemPrompt, { persona: 'Parent coding agent identity.' })); fibers.push(await ctx.plugin(ToolRuntime)); fibers.push(await ctx.plugin(SessionProjection)); fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        return { ...assembly, sections: [...assembly.sections, { name: 'test-coding-policy', text: 'Injected coding instructions.' }] }
      })
      if (checkpoints) {
        // Run the public Web checkpoint policy; a separate durability listener
        // observes child flushes without requiring a storage backend here.
        ctx.on('session/flush', async (session) => {
          if (session.header.origin !== 'subagent') return
          await new Promise<void>((resolve) => setImmediate(resolve))
          childFlushes++
        })
        fibers.push(await ctx.plugin({ ...SessionCheckpointPolicy, inject: ['llm', 'sessions', 'tools'] }))
      }
      unregister = ctx.llm.registerAdapter(['v3-alpha4-offline'], new Adapter())
      pluginFiber = await ctx.plugin({
        name: 'mnemosyne-v3-alpha4-test',
        inject: ['llm', 'agents'],
        apply: (pluginCtx: Context) => install(pluginCtx, { projectRoot: root }, undefined, { mode: 'v3' }),
      })
      const agent = ctx.agentLoop.create(SessionId('v3_alpha4_parent'), { provider: 'v3-alpha4-offline', model: 'offline' }, { cwd: root })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '完成普通任务' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const logPath = join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl')
      let rows: any[] = []
      for (let i = 0; i < 100; i++) {
        try {
          rows = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
          if (rows.some((row) => row.event === (decision === 'skip' ? 'consolidation_skip' : decision === 'missing_refs' ? 'consolidation_failed' : 'generation_published'))) break
        } catch { /* logger may not have created the file yet */ }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (decision !== 'create') expect(childCalls).toBe(1)
      else expect(childCalls).toBeGreaterThan(1)
      if (checkpoints) expect(childFlushes).toBeGreaterThan(0)
      const attemptRows = rows.filter((row) => row.attempt_id)
      expect(new Set(attemptRows.map((row) => row.attempt_id)).size).toBe(1)
      const reasons = attemptRows.map((row) => row.reason_code).filter(Boolean)
      expect(reasons).toEqual(expect.arrayContaining([
        'model_callback_entered',
        'subagent_model_promise_returned',
        'subagent_model_promise_settled',
        'subagent_run_entered',
        'create_watchdog_armed',
        'subagent_factory_entered',
        'agents_create_call_started',
        'subagent_setup_started',
        'subagent_setup_completed',
        'subagent_publish_started',
        'subagent_publish_completed',
        'agents_create_call_returned',
        'subagent_create_settled',
      ]))
      expect(attemptRows.map((row) => row.event)).toEqual(expect.arrayContaining([
        'consolidation_operation_registered',
        'consolidation_operation_scheduled',
        'consolidation_operation_started',
        'consolidation_subagent_created',
        'consolidation_subagent_followup_sent',
        'consolidation_subagent_completed',
        'consolidation_subagent_disposed',
        decision === 'skip' ? 'consolidation_skip' : decision === 'missing_refs' ? 'consolidation_failed' : 'consolidation_created',
      ]))
      if (decision === 'create') {
        expect(attemptRows.map((row) => row.event)).toEqual(expect.arrayContaining(['catalog_updated', 'generation_published']))
        expect(await readFile(join(root, '.dsh-mnemosyne', 'v2', 'CURRENT'), 'utf8')).toContain('gen_')
      }
      if (decision === 'missing_refs') {
        expect(attemptRows.find((row) => row.event === 'consolidation_failed')?.reason_code).toBe('consolidation_judgment_missing_related_memory_refs')
        expect(attemptRows.filter((row) => row.event === 'consolidation_subagent_disposed')).toHaveLength(1)
        expect(rows.some((row) => ['consolidation_created', 'catalog_updated', 'generation_published'].includes(row.event))).toBe(false)
        expect(JSON.stringify(rows)).not.toContain('JSONL 容错')
        expect(JSON.stringify(rows)).not.toContain('单行解析失败不能中断后续统计')
        await expect(readFile(join(root, '.dsh-mnemosyne', 'v2', 'CURRENT'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await pluginFiber?.dispose()
      unregister?.()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15000)

  it.each([false, true])('injects map usage rules before the parent model runs (complete persona: %s)', async (completePersona) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v3-agent-')))
    roots.push(root)
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    const requests: GenerateOptions[] = []
    let parentCalls = 0
    let childCalls = 0
    let mapRequested = false
    let consolidationSettled = false
    class Adapter extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'v3-offline' } }
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        parentCalls += 1
        const visible = JSON.stringify(options.messages)
        if (!mapRequested && visible.includes('[Mnemosyne Map v3')) {
          const mapText = options.messages
            .flatMap((message) => message.content)
            .find((block) => block.type === 'text' && block.text.startsWith('[Mnemosyne Map v3'))
          if (mapText?.type === 'text') {
            const map = JSON.parse(mapText.text.slice(mapText.text.indexOf('\n') + 1)) as { map_ref?: unknown }
            if (typeof map.map_ref === 'string') { mapRequested = true; return toolCallStream(map.map_ref) }
          }
        }
        return textStream('parent complete')
      }
    }
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] as any[] } }
    const subagentFactory = async (_parent: any, request: any) => {
      childCalls += 1
      const packet = JSON.parse(request.task.split('\n').at(-1)!)
      if (packet.stage === 'judgment') child.whenIdle = async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        consolidationSettled = true
      }
      const output = packet.stage === 'judgment' ? JSON.stringify({ decision: 'skip', reason_code: 'no_reusable_knowledge' }) : JSON.stringify({ selected_refs: [] })
      child.session.events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: output }] } } }]
      return { agent: child, dispose: async () => undefined } as any
    }
    const world = { generation_id: 'gen_' + 'a'.repeat(64), manifest: { project_scope_id: 'sha256_' + 'b'.repeat(64), catalog_id: 'catalog_' + 'c'.repeat(64) }, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }] })],
    ]) } as any
    try {
      fibers.push(await ctx.plugin(SessionStore)); fibers.push(await ctx.plugin(AgentRegistry)); fibers.push(await ctx.plugin(LlmRuntime)); fibers.push(await ctx.plugin(SystemPrompt)); fibers.push(await ctx.plugin(ToolRuntime)); fibers.push(await ctx.plugin(SessionProjection)); fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
      if (completePersona) ctx.systemPrompt.section({ name: 'test-complete-persona', order: 0, complete: true, text: 'You are a helpful software engineer assistant.' })
      const unregister = ctx.llm.registerAdapter(['v3-offline'], new Adapter())
      fibers.push(await ctx.plugin({
        name: 'mnemosyne-v3-agent-test',
        inject: ['llm', 'agents'],
        apply: (pluginCtx: Context) => install(pluginCtx, { projectRoot: root }, undefined, { mode: 'v3', loadWorld: async () => world, subagentFactory }),
      }))
      const agent = ctx.agentLoop.create(SessionId('v3_parent'), { provider: 'v3-offline', model: 'offline' }, { cwd: root })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '完成一个任务' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      // Consolidation starts from the committed turn/end event and is joined
      // by session/flush, so allow that event dispatch to settle here.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(consolidationSettled).toBe(true)
      // This is a request-contract test, not proof of real-model compliance.
      if (completePersona) expect(requests[0].system).toBe('You are a helpful software engineer assistant.')
      else expect(requests[0].system).toContain('must call mnemosyne_recall')
      const visibleRules = JSON.stringify(requests[0].messages)
      expect(visibleRules).toContain('must call mnemosyne_recall')
      expect(visibleRules).toContain('titles are unrelated')
      expect(visibleRules).toContain('Title → Summary → Content')
      expect(requests.some((request) => JSON.stringify(request.messages).includes('Authentication'))).toBe(true)
      expect(parentCalls).toBeGreaterThanOrEqual(1)
      expect(childCalls).toBeGreaterThanOrEqual(1)
      expect(parentCalls).toBeGreaterThanOrEqual(2)
      expect(agent.session.snapshotEvents().some((event) => event.type === 'tool/result')).toBe(true)
      unregister()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }, 15000)
})
