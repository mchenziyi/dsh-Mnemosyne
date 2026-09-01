import { describe, expect, it } from 'vitest'
import { createRecallPreStepHandlerV3 } from '../src/v3/recall-pre-step.js'
import { SubagentUnavailableError } from '../src/v3/map-first-recall.js'

describe('v3 recall pre-step', () => {
  it('injects the title map and only final content into the parent step', async () => {
    const scope = { project_root: '/tmp/project', project_scope_id: 'sha256_' + 'a'.repeat(64), session_scope_id: 'sha256_' + 'b'.repeat(64) }
    const world = { generation_id: 'gen_' + 'c'.repeat(64), manifest: { project_scope_id: scope.project_scope_id, catalog_id: 'catalog_' + 'd'.repeat(64) }, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }] })],
      ['indexes/nodes/node_auth.json', JSON.stringify({ schema_version: 1, node_id: 'node_auth', title: 'Authentication', summary: '认证经验', children: [], memories: [{ ref: 'mem_jwt', title: 'JWT' }] })],
      ['summaries/mem_jwt.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_jwt', title: 'JWT', summary: '刷新经验' })],
      ['contents/mem_jwt.md', '完整经验正文'],
    ]) } as any
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] as any[] } }
    const factory = async (_parent: any, request: any) => {
      const packet = JSON.parse(request.task.split('\n').at(-1)!)
      const selected = packet.items.length ? [packet.items[0].ref] : []
      child.session.events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ selected_refs: selected }) }] } } }]
      return { agent: child, dispose: async () => undefined } as any
    }
    const events: string[] = []
    const handler = createRecallPreStepHandlerV3({ scopeRuntime: { observeSession: () => ({ status: 'ready', scope }) } as any, legacyRuntime: { recall: async () => ({ status: 'empty', reason_code: 'memory_empty', selected_memory_refs: [], expansion_steps: 0 }) } as any, loadWorld: async () => world, subagentFactory: factory, onEvent: (_scope, event) => events.push(event.event) })
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '认证刷新问题' }] } as any
    const result = await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: {} } } as any, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    expect(result.kind).toBe('enter')
    expect((result as any).messages.map((message: any) => message.source.form)).toEqual(['catalog', 'recall', undefined])
    expect(JSON.stringify((result as any).messages[0])).toContain('Authentication')
    expect(JSON.stringify((result as any).messages[0])).not.toContain('认证经验')
    expect(JSON.stringify((result as any).messages[1])).toContain('完整经验正文')
    expect(events).toEqual(['recall_start', 'recall_layer', 'recall_layer', 'recall_layer', 'recall_layer', 'recall_completed'])
  })

  it('does not recurse for subagent-origin sessions', async () => {
    let legacy = 0
    const handler = createRecallPreStepHandlerV3({ scopeRuntime: { observeSession: () => ({ status: 'ready', scope: {} }) } as any, legacyRuntime: { recall: async () => { legacy++; throw new Error() } } as any })
    const result = await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: { origin: 'subagent' } } } as any, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect(result).toEqual({ kind: 'enter', messages: [] }); expect(legacy).toBe(0)
  })

  it('reports an explicit legacy fallback without treating no-match as fallback', async () => {
    const scope = { project_root: '/tmp/project', project_scope_id: 'sha256_' + 'a'.repeat(64), session_scope_id: 'sha256_' + 'b'.repeat(64) }
    const events: any[] = []
    const handler = createRecallPreStepHandlerV3({
      scopeRuntime: { observeSession: () => ({ status: 'ready', scope }) } as any,
      legacyRuntime: { recall: async () => ({ status: 'empty', reason_code: 'memory_empty', selected_memory_refs: [], expansion_steps: 0 }) } as any,
      loadWorld: async () => ({ generation_id: 'gen_' + 'c'.repeat(64), manifest: { project_scope_id: scope.project_scope_id, catalog_id: 'catalog_' + 'd'.repeat(64) }, files: new Map([['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [], memories: [] })]]) } as any),
      subagentFactory: async () => { throw new SubagentUnavailableError() },
      onEvent: (_scope, event) => events.push(event),
    })
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] } as any
    await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: {} } } as any, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    expect(events.map((event) => event.event)).toContain('recall_fallback')
    expect(events.find((event) => event.event === 'recall_fallback').reason_code).toBe('subagent_unavailable')
  })

  it('still exposes the title map when navigation finds no matching memory', async () => {
    const scope = { project_root: '/tmp/project', project_scope_id: 'sha256_' + 'a'.repeat(64), session_scope_id: 'sha256_' + 'b'.repeat(64) }
    const world = { generation_id: 'gen_' + 'c'.repeat(64), manifest: { project_scope_id: scope.project_scope_id, catalog_id: 'catalog_' + 'd'.repeat(64) }, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }] })],
      ['indexes/nodes/node_auth.json', JSON.stringify({ schema_version: 1, node_id: 'node_auth', title: 'Authentication', summary: 'SECRET_SUMMARY', children: [], memories: [] })],
    ]) } as any
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] as any[] } }
    const handler = createRecallPreStepHandlerV3({
      scopeRuntime: { observeSession: () => ({ status: 'ready', scope }) } as any,
      legacyRuntime: { recall: async () => ({ status: 'empty', reason_code: 'memory_empty', selected_memory_refs: [], expansion_steps: 0 }) } as any,
      loadWorld: async () => world,
      subagentFactory: async () => {
        child.session.events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"selected_refs":[]}' }] } } }]
        return { agent: child, dispose: async () => undefined } as any
      },
    })
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'unrelated task' }] } as any
    const result = await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: {} } } as any, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    expect(result.kind).toBe('enter')
    expect((result as any).messages.map((message: any) => message.source.form)).toEqual(['catalog', undefined])
    expect(JSON.stringify((result as any).messages[0])).toContain('Authentication')
    expect(JSON.stringify((result as any).messages[0])).not.toContain('SECRET_SUMMARY')
  })
})
