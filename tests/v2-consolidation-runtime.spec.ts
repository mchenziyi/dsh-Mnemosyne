import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectScopeId, computeSessionScopeId, type ResolvedScope } from '../src/runtime-scope.js'
import { createConsolidationRuntimeV2, createLlmConsolidationModelV2, type ConsolidationModelRequestV2 } from '../src/v2/consolidation-runtime.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { publishOKFGenerationV2, readCurrentOKFGenerationV2 } from '../src/v2/okf-compiler.js'
import { canonicalHash } from '../src/protocol/canonical.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'

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

async function seedRootCategories(scope: ResolvedScope, categories: Array<{ title: string; summary: string }>): Promise<void> {
  const root = { node_id: 'node_root', title: '项目记忆', summary: '项目级持久记忆。', parent_node_id: null, child_node_refs: [] as string[], memory_refs: [] as string[] }
  const nodes = categories.map((category) => ({
    node_id: computeOKFCatalogNodeIdV1(scope.project_scope_id, root.node_id, category.title),
    title: category.title,
    summary: category.summary,
    parent_node_id: root.node_id,
    child_node_refs: [] as string[],
    memory_refs: [] as string[],
  }))
  root.child_node_refs = nodes.map((node) => node.node_id)
  const catalog: OKFCatalogV1 = {
    schema_version: 1,
    project_scope_id: scope.project_scope_id,
    root_node_id: root.node_id,
    nodes: [root, ...nodes],
    updated_at: '2026-08-31T03:00:00.000Z',
    content_sha256: '',
  }
  catalog.content_sha256 = computeOKFCatalogV1Hash(catalog)
  const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  const stored = await store.putCatalog(catalog)
  await publishOKFGenerationV2({
    project_root: scope.project_root,
    project_scope_id: scope.project_scope_id,
    catalog_id: stored.catalog_id,
    created_at: catalog.updated_at,
  })
}

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

  it('accepts a valid consolidation judgment larger than the recall text limit', async () => {
    const content = 'x'.repeat(9000)
    const payload = JSON.stringify({ decision: 'create', title: '长内容经验', summary: '可复用经验。', content, related_memory_refs: [] })
    const model = createLlmConsolidationModelV2({
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as any)
    await expect(model({ schema_version: 1, stage: 'judgment', evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [] }, { provider: 'p', model: 'm', signal: new AbortController().signal })).resolves.toMatchObject({ decision: 'create', content })
  })

  it('rejects an oversized consolidation judgment', async () => {
    const content = 'x'.repeat(40000)
    const payload = JSON.stringify({ decision: 'create', title: '超长经验', summary: '经验。', content, related_memory_refs: [] })
    const model = createLlmConsolidationModelV2({
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as any)
    await expect(model({ schema_version: 1, stage: 'judgment', evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [] }, { provider: 'p', model: 'm', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'stream_text_size_exceeded' })
  })

  it('automatically creates and publishes a three-level OKF path', async () => {
    const scope = await project()
    const stages: string[] = []
    const runtime = createConsolidationRuntimeV2({
      model: async (request: any) => {
        stages.push(request.stage)
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
    expect(stages).toEqual(['judgment', 'category_new', 'category_summary', 'category_new', 'category_summary', 'category_new'])
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
        if (request.stage === 'category_titles') return { decision: 'no_candidate' }
        if (request.stage === 'category_new') return { decision: 'new', title: `分类 ${request.memory.title}`, summary: '并发分类。' }
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
        if (request.stage === 'category_new') return { decision: 'new', title: '依赖管理', summary: '依赖、锁文件和版本冲突。' }
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
    expect(seen.map((request) => request.stage)).toEqual(['judgment', 'category_new', 'category_summary'])
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
    } : request.stage === 'category_new' ? { decision: 'new', title: '通用', summary: '通用经验。' } : { decision: 'attach' }
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
      : request.stage === 'category_new' ? { decision: 'new', title: '可靠发布', summary: '发布恢复。' } : { decision: 'attach' } })
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
        if (request.stage === 'category_new') return { decision: 'new', title: '构建', summary: '构建问题。' }
        if (request.stage === 'category_titles') return { decision: 'candidate', node_ref: request.categories[0]!.ref }
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
        if (request.stage === 'category_new') {
          return { decision: 'new', title: '分类 A', summary: '不应在未来 category title 请求中出现的分类总结。' }
        }
        if (request.stage === 'category_titles') {
          categoryRequest = JSON.stringify(request)
          return { decision: 'candidate', node_ref: request.categories[0]!.ref }
        }
        if (request.stage === 'category_summary') return { decision: 'attach' }
        count++
        return { decision: 'create', title: `经验 ${count}`, summary: '总结', content: `## 内容\n\n正文 ${count}`, related_memory_refs: [] }
      },
    })
    const base = { scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }
    await runtime.consolidate({ ...base, now: '2026-08-28T03:00:00.000Z' })
    await runtime.consolidate({ ...base, now: '2026-08-28T04:00:00.000Z' })
    expect(categoryRequest).toContain('分类 A')
    expect(categoryRequest).not.toContain('不应在未来 category title 请求中出现的分类总结')
  })

  it('discloses only the selected category summary and tries the next title after reject', async () => {
    const scope = await project()
    await seedRootCategories(scope, [
      { title: '后端配置', summary: 'BACKEND_SUMMARY_SENTINEL' },
      { title: '前端配置', summary: 'FRONTEND_SUMMARY_SENTINEL' },
    ])
    const titleRequests: string[] = []
    const summaryRequests: string[] = []
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        if (request.stage === 'judgment') return {
          decision: 'create', title: '前端环境变量必须使用 VITE 前缀', summary: 'Vite 只向客户端暴露带 VITE 前缀的环境变量。',
          content: '## 已知踩坑\n\n未加前缀的变量在客户端不可见。', related_memory_refs: [],
        }
        if (request.stage === 'category_titles') {
          titleRequests.push(JSON.stringify(request))
          const selected = request.categories.find((category) => category.title === '后端配置') ?? request.categories[0]!
          return { decision: 'candidate', node_ref: selected.ref } as any
        }
        if (request.stage === 'category_summary') {
          summaryRequests.push(JSON.stringify(request))
          return request.category.title === '后端配置' ? { decision: 'reject' } as any : { decision: 'attach' }
        }
        throw new Error('category_new must not be called')
      },
    })
    const result = await runtime.consolidate({
      scope, evidence: { task: '修复 Vite 环境变量', outcome: '增加 VITE 前缀后通过。' }, used_memory_refs: [],
      provider: 'p', model: 'm', now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })

    expect(result.status).toBe('created')
    expect(titleRequests).toHaveLength(2)
    expect(titleRequests[0]).toContain('后端配置')
    expect(titleRequests[0]).toContain('前端配置')
    expect(titleRequests[0]).not.toContain('BACKEND_SUMMARY_SENTINEL')
    expect(titleRequests[0]).not.toContain('FRONTEND_SUMMARY_SENTINEL')
    expect(titleRequests[1]).not.toContain('后端配置')
    expect(titleRequests[1]).toContain('前端配置')
    expect(summaryRequests).toHaveLength(2)
    expect(summaryRequests[0]).toContain('BACKEND_SUMMARY_SENTINEL')
    expect(summaryRequests[0]).not.toContain('FRONTEND_SUMMARY_SENTINEL')
    expect(summaryRequests[1]).not.toContain('BACKEND_SUMMARY_SENTINEL')
    expect(summaryRequests[1]).toContain('FRONTEND_SUMMARY_SENTINEL')

    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const catalog = await store.getCatalog(world.manifest.catalog_id)
    const frontend = catalog.nodes.find((node) => node.title === '前端配置')!
    expect(frontend.memory_refs).toEqual([result.memory_id])
  })

  it('creates a new category only after the selected existing candidate is rejected', async () => {
    const scope = await project()
    await seedRootCategories(scope, [{ title: '后端配置', summary: '后端服务配置。' }])
    const stages: string[] = []
    let newCategoryRequest = ''
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        stages.push(request.stage)
        if (request.stage === 'judgment') return {
          decision: 'create', title: '前端构建产物使用内容哈希命名', summary: '静态资源文件名绑定内容哈希。',
          content: '## 经验\n\n构建产物使用内容哈希以支持长期缓存。', related_memory_refs: [],
        }
        if (request.stage === 'category_titles') return { decision: 'candidate', node_ref: request.categories[0]!.ref } as any
        if (request.stage === 'category_summary') return request.category.title === '后端配置'
          ? { decision: 'reject' } as any
          : { decision: 'attach' }
        if (request.stage === 'category_new') {
          newCategoryRequest = JSON.stringify(request)
          return { decision: 'new', title: '前端构建', summary: '前端构建与静态资源发布。' } as any
        }
        throw new Error('unexpected stage')
      },
    })
    const result = await runtime.consolidate({
      scope, evidence: { task: '配置静态资源缓存', outcome: '内容哈希构建通过。' }, used_memory_refs: [],
      provider: 'p', model: 'm', now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })

    expect(result.status).toBe('created')
    expect(stages).toEqual(['judgment', 'category_titles', 'category_summary', 'category_new', 'category_summary'])
    expect(newCategoryRequest).not.toContain('后端配置')
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    const catalog = await store.getCatalog(world.manifest.catalog_id)
    const backend = catalog.nodes.find((node) => node.title === '后端配置')!
    const frontend = catalog.nodes.find((node) => node.title === '前端构建')!
    expect(backend.memory_refs).toEqual([])
    expect(frontend.memory_refs).toEqual([result.memory_id])
  })

  it('fails closed when category_new repeats a rejected sibling title', async () => {
    const scope = await project()
    await seedRootCategories(scope, [{ title: '后端配置', summary: '后端服务配置。' }])
    const runtime = createConsolidationRuntimeV2({
      model: async (request) => {
        if (request.stage === 'judgment') return {
          decision: 'create', title: '新经验', summary: '新的前端经验。', content: '## 经验\n\n正文。', related_memory_refs: [],
        }
        if (request.stage === 'category_titles') return { decision: 'candidate', node_ref: request.categories[0]!.ref }
        if (request.stage === 'category_summary') return { decision: 'reject' }
        if (request.stage === 'category_new') return { decision: 'new', title: '后端配置', summary: '试图复用已拒绝标题。' }
        throw new Error('unexpected stage')
      },
    })
    const result = await runtime.consolidate({
      scope, evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [], provider: 'p', model: 'm',
      now: '2026-08-31T04:00:00.000Z', signal: new AbortController().signal,
    })

    expect(result).toEqual({ status: 'failed', reason_code: 'consolidation_category_invalid' })
    const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    expect(await store.listMemories()).toEqual([])
  })
})
