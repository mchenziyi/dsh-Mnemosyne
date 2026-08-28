import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  createRecallRuntimeV2,
  createRecallPreStepHandlerV2,
  type RecallNavigationRequestV2,
  type RecallNavigatorV2,
} from '../src/v2/recall-runtime.js'
import type { CompiledOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import type { ResolvedScope, ScopeRuntime } from '../src/runtime-scope.js'

function world(): CompiledOKFGenerationV2 {
  const files = new Map<string, string>([
    ['indexes/root.json', JSON.stringify({ schema_version: 1, root_node_id: 'node_root', children: [{ ref: 'node_build', title: '构建问题' }, { ref: 'node_database', title: '数据库问题' }] })],
    ['indexes/nodes/node_build.json', JSON.stringify({ schema_version: 1, node_id: 'node_build', title: '构建问题', summary: '构建和依赖故障。', children: [], memories: [{ ref: 'mem_lock', title: '不要删除锁文件' }, { ref: 'mem_peer', title: '先检查 Peer 冲突' }] })],
    ['indexes/nodes/node_database.json', JSON.stringify({ schema_version: 1, node_id: 'node_database', title: '数据库问题', summary: '数据库迁移问题。', children: [], memories: [{ ref: 'mem_db', title: '迁移前先备份' }] })],
    ['summaries/mem_lock.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_lock', title: '不要删除锁文件', summary: '直接删除锁文件会导致无关依赖漂移。' })],
    ['summaries/mem_peer.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_peer', title: '先检查 Peer 冲突', summary: '先定位 peer dependency 的真实来源。' })],
    ['summaries/mem_db.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_db', title: '迁移前先备份', summary: '数据库迁移前创建备份。' })],
    ['summaries/mem_related.json', JSON.stringify({ schema_version: 1, memory_id: 'mem_related', title: 'Workspace 依赖一致性', summary: '检查 workspace 中的依赖版本一致性。' })],
    ['contents/mem_lock.md', '# 不要删除锁文件\n\n完整锁文件经验。\n\n## 相关记忆\n\n- Workspace 依赖一致性 (mem_related)\n'],
    ['contents/mem_peer.md', '# 先检查 Peer 冲突\n\n完整 Peer 经验。\n\n## 相关记忆\n\n- 无\n'],
    ['contents/mem_db.md', '# 迁移前先备份\n\n完整数据库经验。\n\n## 相关记忆\n\n- 无\n'],
    ['contents/mem_related.md', '# Workspace 依赖一致性\n\n完整 Workspace 经验。\n\n## 相关记忆\n\n- 无\n'],
  ])
  return {
    generation_id: `gen_${'a'.repeat(64)}`,
    manifest: {
      schema_version: 1,
      generation_id: `gen_${'a'.repeat(64)}`,
      project_scope_id: `sha256_${'b'.repeat(64)}`,
      compiler_version: 'dsh-mnemosyne-okf-v2/1',
      catalog_id: `catalog_${'c'.repeat(64)}`,
      catalog_sha256: `sha256_${'c'.repeat(64)}`,
      memory_refs: ['mem_db', 'mem_lock', 'mem_peer', 'mem_related'].map((memory_id) => ({ memory_id, content_sha256: `sha256_${'d'.repeat(64)}` })),
      output_refs: [],
      created_at: '2026-08-28T02:00:00.000Z',
    },
    files,
  }
}

const scope: ResolvedScope = {
  schema_version: 1,
  session_id: 'session_v2',
  project_root: '/project',
  source: 'session_header',
  project_scope_id: `sha256_${'b'.repeat(64)}`,
  session_scope_id: `sha256_${'e'.repeat(64)}`,
}

describe('v2 recall runtime', () => {
  it('enforces Title → Summary → Content and never exposes unselected branches', async () => {
    const seen: RecallNavigationRequestV2[] = []
    const navigator: RecallNavigatorV2 = async (request) => {
      seen.push(structuredClone(request))
      if (request.stage === 'root_titles') return { selected_refs: ['node_build'] }
      if (request.stage === 'node_summary') return { selected_refs: ['node_build'] }
      if (request.stage === 'node_titles') return { selected_refs: ['mem_lock'] }
      if (request.stage === 'memory_summaries') return { selected_refs: request.items[0]?.ref === 'mem_related' ? ['mem_related'] : ['mem_lock'] }
      if (request.stage === 'related_titles') return { selected_refs: ['mem_related'] }
      return { selected_refs: [] }
    }
    const runtime = createRecallRuntimeV2({ loadWorld: async () => world(), navigator })
    const result = await runtime.recall({ scope, task: '安装依赖失败了，应该怎么排查？', provider: 'p', model: 'm', signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    expect(result.selected_memory_refs).toEqual(['mem_lock', 'mem_related'])
    expect(result.message?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' })
    const finalText = (result.message!.content[0] as { text: string }).text
    expect(finalText).toContain('完整锁文件经验')
    expect(finalText).toContain('完整 Workspace 经验')
    expect(finalText).not.toContain('完整 Peer 经验')
    expect(finalText).not.toContain('完整数据库经验')

    expect(seen[0]!.stage).toBe('root_titles')
    expect(JSON.stringify(seen[0])).not.toContain('构建和依赖故障')
    expect(JSON.stringify(seen[0])).not.toContain('完整')
    expect(JSON.stringify(seen)).not.toContain('数据库迁移前创建备份')
    const memorySummaryRequest = seen.find((request) => request.stage === 'memory_summaries' && request.items.some((item) => item.ref === 'mem_lock'))!
    expect(JSON.stringify(memorySummaryRequest)).not.toContain('完整锁文件经验')
    expect(seen.length).toBeLessThanOrEqual(6)
  })

  it('caps each navigation at 5 summaries, 3 contents, and 6 expansion calls', async () => {
    const oversizedWorld = world()
    const node = JSON.parse(oversizedWorld.files.get('indexes/nodes/node_build.json')!)
    node.memories = Array.from({ length: 8 }, (_, index) => ({ ref: `mem_${index}`, title: `Memory ${index}` }))
    oversizedWorld.files.set('indexes/nodes/node_build.json', JSON.stringify(node))
    for (let index = 0; index < 8; index++) {
      oversizedWorld.files.set(`summaries/mem_${index}.json`, JSON.stringify({ schema_version: 1, memory_id: `mem_${index}`, title: `Memory ${index}`, summary: `Summary ${index}` }))
      oversizedWorld.files.set(`contents/mem_${index}.md`, `Content ${index}`)
    }
    const requests: RecallNavigationRequestV2[] = []
    const runtime = createRecallRuntimeV2({
      loadWorld: async () => oversizedWorld,
      navigator: async (request) => {
        requests.push(request)
        if (request.stage === 'root_titles' || request.stage === 'node_summary') return { selected_refs: ['node_build'] }
        if (request.stage === 'node_titles') return { selected_refs: node.memories.map((item: { ref: string }) => item.ref) }
        if (request.stage === 'memory_summaries') return { selected_refs: request.items.map((item) => item.ref) }
        return { selected_refs: [] }
      },
    })
    const result = await runtime.recall({ scope, task: 'task', provider: 'p', model: 'm', signal: new AbortController().signal })
    expect(requests.find((request) => request.stage === 'memory_summaries')!.items).toHaveLength(5)
    expect(result.selected_memory_refs).toHaveLength(3)
    expect(requests.length).toBeLessThanOrEqual(6)
  })

  it('fails open without injecting content when the model selects an undisclosed ref', async () => {
    const runtime = createRecallRuntimeV2({
      loadWorld: async () => world(),
      navigator: async () => ({ selected_refs: ['mem_not_disclosed'] }),
    })
    const result = await runtime.recall({ scope, task: 'task', provider: 'p', model: 'm', signal: new AbortController().signal })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'recall_selection_invalid' })
    expect('message' in result).toBe(false)
  })

  it('returns empty without a model call when no v2 generation exists', async () => {
    let calls = 0
    const runtime = createRecallRuntimeV2({
      loadWorld: async () => { throw Object.assign(new Error('missing'), { code: 'memory_compile_not_found' }) },
      navigator: async () => { calls++; return { selected_refs: [] } },
    })
    expect(await runtime.recall({ scope, task: 'task', provider: 'p', model: 'm', signal: new AbortController().signal })).toMatchObject({ status: 'empty' })
    expect(calls).toBe(0)
  })

  it('pre-step handler injects one durable plugin recall only on the first step', async () => {
    const recallMessage = createUserMessage({ content: [{ type: 'text', text: 'remembered content' }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } })
    let calls = 0
    const runtime = { recall: async () => ({ status: 'completed' as const, reason_code: null, selected_memory_refs: ['mem_lock'], expansion_steps: 4, message: recallMessage }) }
    const scopeRuntime = { observeSession: () => ({ status: 'ready' as const, scope }) } as unknown as ScopeRuntime
    const handler = createRecallPreStepHandlerV2({ runtime, scopeRuntime })
    const user = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }) as UserMessage
    const payload = { agent: { options: { provider: 'p', model: 'm' }, session: { id: 'session_v2' } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }

    const first = await handler(payload as never, async () => { calls++; return { kind: 'enter', messages: [user] } })
    expect(first).toMatchObject({ kind: 'enter' })
    expect((first as { messages: UserMessage[] }).messages[0]!.source).toMatchObject({ kind: 'plugin', form: 'recall' })
    const second = await handler({ ...payload, step: 2 } as never, async () => { calls++; return { kind: 'enter', messages: [user] } })
    expect((second as { messages: UserMessage[] }).messages).toEqual([user])
    expect(calls).toBe(2)
  })
})
