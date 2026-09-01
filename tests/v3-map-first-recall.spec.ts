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
})
