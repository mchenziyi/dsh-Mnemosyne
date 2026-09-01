import { describe, expect, it } from 'vitest'
import { install } from '../src/observer.js'

describe('v3 observer wiring', () => {
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
})
