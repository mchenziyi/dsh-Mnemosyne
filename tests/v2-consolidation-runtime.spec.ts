import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectScopeId, computeSessionScopeId, type ResolvedScope } from '../src/runtime-scope.js'
import { createConsolidationRuntimeV2, createLlmConsolidationModelV2, type ConsolidationModelRequestV2 } from '../src/v2/consolidation-runtime.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { readCurrentOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import { canonicalHash } from '../src/protocol/canonical.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'

const roots: string[] = []

async function project(session = 'session_a'): Promise<ResolvedScope> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-consolidation-')))
  roots.push(root)
  const projectScope = computeProjectScopeId(root)
  return {
    schema_version: 1,
    session_id: session,
    project_root: root,
    source: 'session_header',
    project_scope_id: projectScope,
    session_scope_id: computeSessionScopeId(projectScope, session),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v2 consolidation runtime', () => {
  it('reports a stable judgment model failure stage', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({ model: async () => { throw new Error('provider details must not leak') } })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result).toEqual({ status: 'failed', reason_code: 'consolidation_judgment_model_failed' })
  })

  it('reports invalid judgment output separately from model failure', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({ model: async () => ({ decision: 'create' } as any) })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result).toEqual({ status: 'failed', reason_code: 'consolidation_judgment_invalid' })
  })

  it('keeps only a safe LLM failure code for developer diagnosis', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({ model: async () => {
      throw Object.assign(new Error('secret path must not leak'), { failure: { code: 'NO_ADAPTER' } })
    } })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result).toEqual({ status: 'failed', reason_code: 'consolidation_judgment_model_no_adapter' })
  })

  it('preserves the concrete stream protocol failure code', async () => {
    const scope = await project()
    const model = createLlmConsolidationModelV2({
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as any)
    const runtime = createConsolidationRuntimeV2({ model })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result.reason_code).toBe('consolidation_judgment_model_stream_finish_with_open_block')
  })

  it('automatically creates and publishes a three-level OKF path', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({
      model: async (request: any) => {
        if (request.stage === 'judgment') return {
          decision: 'create',
          title: '刷新令牌轮换前保留旧令牌窗口',
          summary: '轮换 Refresh Token 时需要保留短暂兼容窗口。',
          content: '## 已知踩坑\n\n立即撤销旧令牌会中断并发刷新请求。',
          related_memory_refs: [],
        }
        if (request.stage === 'category_summary') {
          return request.current_depth === 3 ? { decision: 'attach' } : { decision: 'expand' }
        }
        const titles = ['Authentication', 'JWT', 'Refresh Token']
        return { decision: 'new', title: titles[request.current_depth]!, summary: `${titles[request.current_depth]} 分类。` }
      },
    })
    const result = await runtime.consolidate({
      scope,
      evidence: { task: '修复令牌轮换中断', outcome: '加入兼容窗口后验证通过。' },
      used_memory_refs: [], provider: 'p', model: 'm', now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })

    expect(result.status).toBe('created')
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const catalog = await store.getCatalog(world.manifest.catalog_id)
    const root = catalog.nodes.find((node) => node.node_id === catalog.root_node_id)!
    const authentication = catalog.nodes.find((node) => node.node_id === root.child_node_refs[0])!
    const jwt = catalog.nodes.find((node) => node.node_id === authentication.child_node_refs[0])!
    const refreshToken = catalog.nodes.find((node) => node.node_id === jwt.child_node_refs[0])!
    expect([authentication.title, jwt.title, refreshToken.title]).toEqual(['Authentication', 'JWT', 'Refresh Token'])
    expect(refreshToken.memory_refs).toEqual([result.memory_id])
    expect(authentication.memory_refs).toEqual([])
    expect(jwt.memory_refs).toEqual([])
  })

  it('does not lose catalog entries when two turns consolidate concurrently', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        if (request.stage === 'judgment') return {
          decision: 'create',
          title: `经验 ${request.evidence.task}`,
          summary: `总结 ${request.evidence.task}`,
          content: `## 内容\n\n${request.evidence.task}`,
          related_memory_refs: [],
        }
        if (request.stage === 'category_titles') return { decision: 'new', title: `分类 ${request.memory.title}`, summary: '并发分类。' }
        return { decision: 'attach' }
      },
    })
    const base = { scope, used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }
    const [first, second] = await Promise.all([
      runtime.consolidate({ ...base, evidence: { task: 'A', outcome: 'done' }, now: '2026-08-28T03:00:00.000Z' }),
      runtime.consolidate({ ...base, evidence: { task: 'B', outcome: 'done' }, now: '2026-08-28T03:00:01.000Z' }),
    ])

    expect([first.status, second.status]).toEqual(['created', 'created'])
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(world.manifest.memory_refs.map((ref) => ref.memory_id).sort()).toEqual([first.memory_id, second.memory_id].sort())
  })

  it('automatically creates a project-level memory, catalog, and current generation', async () => {
    const scope = await project()
    const seen: ConsolidationModelRequestV2[] = []
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        seen.push(structuredClone(request))
        if (request.stage === 'judgment') return {
          decision: 'create',
          title: '删除锁文件前先定位错误来源',
          summary: '安装失败时先区分 Peer 冲突、锁文件漂移和网络问题。',
          content: '## 遇到的问题\n\n依赖安装失败。\n\n## 已知踩坑\n\n直接删除锁文件会引起无关漂移。\n\n## 验证方式\n\n类型检查和测试通过。',
          related_memory_refs: [],
        }
        if (request.stage === 'category_titles') return { decision: 'new', title: '依赖管理', summary: '依赖、锁文件和版本冲突。' }
        return { decision: 'attach' }
      },
    })
    const result = await runtime.consolidate({
      scope,
      evidence: { task: '修复安装失败', outcome: '确认是 Peer 冲突并完成修复。' },
      used_memory_refs: [],
      provider: 'p', model: 'm', now: '2026-08-28T03:00:00.000Z', signal: new AbortController().signal,
    })

    expect(result.status).toBe('created')
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const memories = await store.listMemories()
    expect(memories).toHaveLength(1)
    expect(memories[0]).not.toHaveProperty('session_scope_id')
    expect(memories[0]!.title).toBe('删除锁文件前先定位错误来源')
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(world.files.get(`summaries/${memories[0]!.memory_id}.json`)).toContain('安装失败时先区分')
    expect(seen.map((request) => request.stage)).toEqual(['judgment', 'category_titles', 'category_summary'])
  })

  it('skips without creating v2 storage when no reusable knowledge exists', async () => {
    const scope = await project()
    const runtime = createConsolidationRuntimeV2({ model: async () => ({ decision: 'skip', reason_code: 'no_reusable_knowledge' }) })
    const result = await runtime.consolidate({
      scope, evidence: { task: '问候', outcome: '普通回复' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-28T03:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ status: 'skipped', reason_code: 'no_reusable_knowledge' })
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(await store.listMemories()).toEqual([])
  })

  it('returns noop for the same canonical knowledge instead of duplicating it', async () => {
    const scope = await project()
    const model = async (request: ConsolidationModelRequestV2): Promise<any> => request.stage === 'judgment' ? {
      decision: 'create', title: '稳定经验', summary: '相同总结', content: '## 经验\n\n相同正文', related_memory_refs: [],
    } : request.stage === 'category_titles' ? { decision: 'new', title: '通用', summary: '通用经验。' } : { decision: 'attach' }
    const runtime = createConsolidationRuntimeV2({ model })
    const base = { scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }
    expect((await runtime.consolidate({ ...base, now: '2026-08-28T03:00:00.000Z' })).status).toBe('created')
    expect((await runtime.consolidate({ ...base, now: '2026-08-28T04:00:00.000Z' })).status).toBe('noop')
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(await store.listMemories()).toHaveLength(1)
  })

  it('recovers an unpublished immutable memory instead of returning a false noop', async () => {
    const scope = await project()
    const knowledge = {
      title: '恢复未完成发布', summary: '已写入但未进入 CURRENT 的记忆必须在重试时完成发布。',
      content: '## 问题\n\n发布在 CURRENT 更新前失败。', related_memory_refs: [] as string[],
    }
    const fingerprint = canonicalHash({ schema_version: 1, project_scope_id: scope.project_scope_id, ...knowledge })
    const orphan: OKFMemoryV2 = {
      schema_version: 2, memory_id: `mem_${fingerprint.slice('sha256_'.length)}`,
      project_scope_id: scope.project_scope_id, ...knowledge,
      created_at: '2026-08-28T03:00:00.000Z', content_sha256: '',
    }
    orphan.content_sha256 = computeOKFMemoryV2Hash(orphan)
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    await store.putMemory(orphan)

    const runtime = createConsolidationRuntimeV2({ model: async (request) => request.stage === 'judgment'
      ? { decision: 'create', ...knowledge }
      : request.stage === 'category_titles' ? { decision: 'new', title: '可靠发布', summary: '发布恢复。' } : { decision: 'attach' } })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'retry', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-28T04:00:00.000Z', signal: new AbortController().signal,
    })
    expect(result.status).toBe('created')
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(world.manifest.memory_refs.map((ref) => ref.memory_id)).toEqual([orphan.memory_id])
  })

  it('creates a related pitfall memory and leaves the old memory bytes unchanged', async () => {
    const scope = await project()
    let round = 0
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        if (request.stage === 'category_titles') return round === 1
          ? { decision: 'new', title: '构建', summary: '构建问题。' }
          : { decision: 'existing', node_ref: request.categories[0]!.ref }
        if (request.stage === 'category_summary') return { decision: 'attach' }
        round++
        return round === 1 ? {
          decision: 'create', title: '旧经验', summary: '原有处理方法。', content: '## 方法\n\n原始正文。', related_memory_refs: [],
        } : {
          decision: 'create', title: '旧经验在单包工作区不适用', summary: '单包工作区使用旧方法会破坏锁文件。',
          content: '## 新踩坑\n\n在单包工作区不要使用旧方法。', related_memory_refs: request.used_memory_refs,
        }
      },
    })
    const base = { scope, evidence: { task: 'task', outcome: 'done' }, provider: 'p', model: 'm', signal: new AbortController().signal }
    const first = await runtime.consolidate({ ...base, used_memory_refs: [], now: '2026-08-28T03:00:00.000Z' })
    const oldPath = join(scope.project_root, '.dsh-mnemosyne', 'v2', 'memories', `${first.memory_id}.json`)
    const before = await readFile(oldPath)
    const second = await runtime.consolidate({ ...base, used_memory_refs: [first.memory_id!], now: '2026-08-28T04:00:00.000Z' })
    expect(second.status).toBe('created')
    expect(await readFile(oldPath)).toEqual(before)
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect((await store.getMemory(second.memory_id!)).related_memory_refs).toEqual([first.memory_id])
  })

  it('shows only category titles during category selection', async () => {
    const scope = await project()
    let categoryRequest = ''
    let count = 0
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        if (request.stage === 'category_titles') {
          categoryRequest = JSON.stringify(request)
          return count++ === 0 ? { decision: 'new', title: '分类 A', summary: '不应在未来 category title 请求中出现的分类总结。' } : { decision: 'existing', node_ref: request.categories[0]!.ref }
        }
        if (request.stage === 'category_summary') return { decision: 'attach' }
        return { decision: 'create', title: `经验 ${count}`, summary: '总结', content: '## 内容\n\n正文', related_memory_refs: [] }
      },
    })
    const base = { scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }
    await runtime.consolidate({ ...base, now: '2026-08-28T03:00:00.000Z' })
    await runtime.consolidate({ ...base, now: '2026-08-28T04:00:00.000Z' })
    expect(categoryRequest).toContain('分类 A')
    expect(categoryRequest).not.toContain('不应在未来 category title 请求中出现的分类总结')
  })
})
