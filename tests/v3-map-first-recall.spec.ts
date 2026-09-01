import { describe, expect, it } from 'vitest'
import { createMapFirstRecallV3, SubagentUnavailableError } from '../src/v3/map-first-recall.js'

const pin = { generation_id: 'gen_' + 'a'.repeat(64), project_scope_id: 'sha256_' + 'b'.repeat(64), catalog_id: 'catalog_' + 'c'.repeat(64), files: new Map([
  ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }], memories: [] })],
  ['indexes/nodes/node_auth.json', JSON.stringify({ schema_version: 1, node_id: 'node_auth', title: 'Authentication', summary: '认证问题。', children: [], memories: [{ ref: 'mem_jwt', title: 'JWT refresh' }] })],
  ['summaries/mem_jwt.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_jwt', title: 'JWT refresh', summary: '刷新令牌经验。' })], ['contents/mem_jwt.md', '# JWT refresh\n\ncontent'],
]) } as any

describe('v3 map-first recall', () => {
  it('navigates Title → Summary → Content and returns a receipt', async () => {
    const stages: string[] = []
    const runtime = createMapFirstRecallV3({ invoke: async (request) => { stages.push(request.stage); if (request.stage === 'root_titles') return { selected_refs: ['node_auth'] }; if (request.stage === 'node_summary') return { selected_refs: ['node_auth'] }; if (request.stage === 'node_titles') return { selected_refs: ['mem_jwt'] }; return { selected_refs: ['mem_jwt'] } }, fallback: async () => { throw new Error('must not fallback') } })
    const result = await runtime.recall(pin, 'refresh token', new AbortController().signal)
    expect(result.status).toBe('completed'); expect(result.selected_memory_refs).toEqual(['mem_jwt']); expect(stages).toEqual(['root_titles', 'node_summary', 'node_titles', 'memory_summaries']); expect(result.receipt?.generation_id).toBe(pin.generation_id)
  })
  it('falls back only on explicit subagent unavailability', async () => {
    let fallback = 0
    const runtime = createMapFirstRecallV3({ invoke: async () => { throw new SubagentUnavailableError() }, fallback: async () => { fallback++; return { status: 'no_match', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_no_match' } } })
    const result = await runtime.recall(pin, 'task', new AbortController().signal)
    expect(fallback).toBe(1); expect(result.fallback_used).toBe(true)
  })

  it('reaches memories stored under the maximum catalog depth', async () => {
    const deepPin = { ...pin, files: new Map([
      ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_auth', title: 'Authentication' }], memories: [] })],
      ['indexes/nodes/node_auth.json', JSON.stringify({ schema_version: 1, node_id: 'node_auth', title: 'Authentication', summary: '认证。', children: [{ ref: 'node_jwt', title: 'JWT' }], memories: [] })],
      ['indexes/nodes/node_jwt.json', JSON.stringify({ schema_version: 1, node_id: 'node_jwt', title: 'JWT', summary: '令牌。', children: [{ ref: 'node_refresh', title: 'Refresh Token' }], memories: [] })],
      ['indexes/nodes/node_refresh.json', JSON.stringify({ schema_version: 1, node_id: 'node_refresh', title: 'Refresh Token', summary: '刷新令牌。', children: [], memories: [{ ref: 'mem_refresh', title: '保留兼容窗口' }] })],
      ['summaries/mem_refresh.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_refresh', title: '保留兼容窗口', summary: '轮换时保留旧令牌窗口。' })],
      ['contents/mem_refresh.md', '# 保留兼容窗口\n\ncontent'],
    ]) } as any
    const runtime = createMapFirstRecallV3({
      invoke: async (request) => {
        if (request.stage === 'memory_summaries') return { selected_refs: ['mem_refresh'] }
        const preferred = request.items.find((item) => item.ref === 'node_auth')
          ?? request.items.find((item) => item.ref === 'node_jwt')
          ?? request.items.find((item) => item.ref === 'node_refresh')
          ?? request.items.find((item) => item.ref === 'mem_refresh')
        return { selected_refs: preferred ? [preferred.ref] : [] }
      },
      fallback: async () => { throw new Error('must not fallback') },
    })
    const result = await runtime.recall(deepPin, 'refresh token rotation', new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(result.selected_memory_refs).toEqual(['mem_refresh'])
  })
})
