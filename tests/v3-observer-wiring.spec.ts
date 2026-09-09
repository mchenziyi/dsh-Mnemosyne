import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { install, resolveParentAgentV3 } from '../src/observer.js'

describe('v3 observer wiring', () => {
  const agent = (id: string, origin?: string) => ({ session: { id, header: { origin } } }) as any

  it('resolves only an exact non-subagent parent and never falls through to a mismatched agent', () => {
    const map = new Map([['parent', agent('parent')]])
    expect(resolveParentAgentV3('parent', map)).toBe(map.get('parent'))
    expect(resolveParentAgentV3('parent', new Map(), { get: () => agent('other'), list: () => [agent('sub', 'subagent')] }, agent('other'))).toBeUndefined()
  })

  it('uses registry get then list when the creation map is empty', () => {
    const expected = agent('parent')
    expect(resolveParentAgentV3('parent', new Map(), { get: () => undefined, list: () => [expected] })).toBe(expected)
  })

  it('routes an installed pre-step through the v3 map-first handler', async () => {
    const listeners = new Map<string, (payload: any, next?: any) => any>()
    const ctx = {
      llm: {},
      on(event: string, handler: any) { listeners.set(event, handler) },
      effect() { return undefined },
    } as any
    const world = { generation_id: 'gen_' + 'a'.repeat(64), manifest: { project_scope_id: 'sha256_' + 'b'.repeat(64), catalog_id: 'catalog_' + 'c'.repeat(64) }, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }] })],
      ['indexes/nodes/node_auth.json', JSON.stringify({ schema_version: 1, node_id: 'node_auth', title: 'Authentication', summary: '认证经验', children: [], memories: [{ ref: 'mem_jwt', title: 'JWT' }] })],
      ['summaries/mem_jwt.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_jwt', title: 'JWT', summary: '刷新经验' })],
      ['contents/mem_jwt.md', '完整经验正文'],
    ]) } as any
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] as any[] } }
    const subagentFactory = async (_parent: any, request: any) => {
      const packet = JSON.parse(request.task.split('\n').at(-1)!)
      const selected = packet.items.length ? [packet.items[0].ref] : []
      child.session.events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ selected_refs: selected }) }] } } }]
      return { agent: child, dispose: async () => undefined } as any
    }
    install(ctx, { projectRoot: process.cwd() }, undefined, { mode: 'v3', loadWorld: async () => world, subagentFactory })
    const handler = listeners.get('agent/pre-step')!
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: '认证刷新问题' }] }
    const result = await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: { cwd: process.cwd() } } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    expect(result.kind).toBe('enter')
    expect(result.messages.map((message: any) => message.source.form)).toEqual(['catalog', undefined])
    expect(result.messages[0].content[0].text).toContain('Authentication')
  })

  it('registers consolidation before returning and creates the child on the next event-loop turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mnemosyne-v3-observer-'))
    let cleanup: (() => Promise<void>) | undefined
    let releaseChild!: () => void
    const childDone = new Promise<void>((resolve) => { releaseChild = resolve })
    try {
      const listeners = new Map<string, (...args: any[]) => any>()
      const immediateDiagnostics: string[] = []
      const ctx = {
        llm: {},
        logger: () => ({ info: (message: string) => immediateDiagnostics.push(message) }),
        on(event: string, handler: (...args: any[]) => any) { listeners.set(event, handler) },
        effect(setup: () => () => Promise<void>) { cleanup = setup() },
      } as any
      let factoryCalls = 0
      const child = {
        status: 'idle',
        followup: () => undefined,
        whenIdle: () => childDone,
        session: { events: [{ type: 'assistant/message', data: { usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 40 }, message: { content: [{ type: 'text', text: '{"decision":"skip","reason_code":"no_reusable_knowledge"}' }] } } }] },
      }
      const subagentFactory = async () => {
        factoryCalls++
        return { agent: child, dispose: async () => undefined } as any
      }
      install(ctx, {}, undefined, { mode: 'v3', subagentFactory })

      const events = [
        { seq: 0, time: '2026-09-03T01:00:00.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
        { seq: 1, time: '2026-09-03T01:00:01.000Z', type: 'user/message', turn: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '完成普通任务' }] } },
        { seq: 2, time: '2026-09-03T01:00:02.000Z', type: 'assistant/attempt', turn: 1, data: { stream: [{ type: 'usage', usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 60 } }] } },
        { seq: 3, time: '2026-09-03T01:00:03.000Z', type: 'assistant/message', turn: 1, data: { usage: { inputTokens: 9, outputTokens: 3, cacheReadTokens: 90 }, message: { provider: 'p', model: 'm', content: [{ type: 'text', text: '任务已完成' }] } } },
        { seq: 4, time: '2026-09-03T01:00:04.000Z', type: 'turn/end', turn: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      const session = { id: 'session_v3_deferred', header: { cwd: root }, events } as any
      const parent = { session, options: { provider: 'p', model: 'm' }, ctx: { agents: {} } } as any
      listeners.get('agent/created')!({ agent: parent })

      expect(listeners.get('session/event')!(session, events[2])).toBeUndefined()
      expect(listeners.get('session/event')!(session, events[3])).toBeUndefined()
      expect(listeners.get('session/event')!(session, events[4])).toBeUndefined()
      expect(factoryCalls).toBe(0)
      await Promise.resolve()
      expect(factoryCalls).toBe(0)

      const flush = listeners.get('session/flush')!(session)
      let flushed = false
      void Promise.resolve(flush).then(() => { flushed = true })
      await Promise.resolve()
      expect(flushed).toBe(false)

      await new Promise<void>((resolve) => setImmediate(resolve))
      // A child's request checkpoint cannot join the operation owning it.
      const childFlush = listeners.get('session/flush')!({ id: 'child', header: { cwd: root, origin: 'subagent' } })
      const otherFlush = listeners.get('session/flush')!({ id: 'other', header: { cwd: join(root, 'other') } })
      let childFlushed = false
      let otherFlushed = false
      void childFlush.then(() => { childFlushed = true })
      void otherFlush.then(() => { otherFlushed = true })
      let recalled = false
      const recall = listeners.get('agent/pre-step')!({ agent: parent, turn: 2, step: 1, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
      void recall.then(() => { recalled = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(childFlushed).toBe(true)
      expect(otherFlushed).toBe(true)
      expect(flushed).toBe(false)
      expect(recalled).toBe(false)
      releaseChild()
      await flush
      await recall
      expect(recalled).toBe(true)
      expect(factoryCalls).toBe(1)
      await cleanup?.()
      cleanup = undefined

      const rows = (await readFile(join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      const attemptIds = new Set(rows.filter((row) => row.event.startsWith('consolidation_')).map((row) => row.attempt_id).filter(Boolean))
      expect(attemptIds.size).toBe(1)
      expect(rows.map((row) => row.event)).toEqual(expect.arrayContaining([
        'consolidation_operation_registered',
        'consolidation_operation_scheduled',
        'consolidation_operation_started',
        'consolidation_skip',
      ]))
      expect(rows.filter((row) => row.event === 'model_usage')).toEqual(expect.arrayContaining([
        expect.objectContaining({ model_role: 'parent', usage_source: 'attempt', event_seq: 2, uncached_input_tokens: 6, cache_read_tokens: 60 }),
        expect.objectContaining({ model_role: 'parent', usage_source: 'message', event_seq: 3, uncached_input_tokens: 9, cache_read_tokens: 90 }),
        expect.objectContaining({ model_role: 'consolidation', usage_source: 'aggregate', stage: 'judgment', uncached_input_tokens: 4, cache_read_tokens: 40 }),
      ]))
      expect(immediateDiagnostics.some((message) => message.includes('consolidation_operation_started'))).toBe(true)
    } finally {
      releaseChild()
      await cleanup?.()
      await rm(root, { recursive: true, force: true })
    }
  })
})
