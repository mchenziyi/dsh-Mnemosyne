import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from '../src/v2/okf-memory.js'
import { computeOKFCatalogNodeIdV1, computeOKFCatalogV1Hash, type OKFCatalogV1 } from '../src/v2/okf-catalog.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import {
  compileOKFGenerationV2,
  publishOKFGenerationV2,
  readCurrentOKFGenerationV2,
} from '../src/v2/okf-compiler.js'

const roots: string[] = []

async function project(): Promise<{ root: string; scope: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-compiler-')))
  roots.push(root)
  return { root, scope: computeProjectScopeId(root) }
}

function makeMemory(scope: string, id: string, title: string, related: string[] = []): OKFMemoryV2 {
  const value: OKFMemoryV2 = {
    schema_version: 2,
    memory_id: id,
    project_scope_id: scope,
    title,
    summary: `${title} 的简短总结。`,
    content: `## 问题\n\n${title} 的完整正文。\n\n## 已知踩坑\n\n避免重复犯错。`,
    related_memory_refs: related,
    created_at: '2026-08-28T01:00:00.000Z',
    content_sha256: '',
  }
  value.content_sha256 = computeOKFMemoryV2Hash(value)
  return value
}

function makeCatalog(scope: string): OKFCatalogV1 {
  const buildId = computeOKFCatalogNodeIdV1(scope, 'node_root', '构建问题')
  const value: OKFCatalogV1 = {
    schema_version: 1,
    project_scope_id: scope,
    root_node_id: 'node_root',
    nodes: [
      {
        node_id: 'node_root', title: '项目记忆', summary: '根摘要不得进入 Root Title Index。', parent_node_id: null,
        child_node_refs: [buildId], memory_refs: [],
      },
      {
        node_id: buildId, title: '构建问题', summary: '构建和依赖问题的分类总结。', parent_node_id: 'node_root',
        child_node_refs: [], memory_refs: ['mem_lockfile', 'mem_peer'],
      },
    ],
    updated_at: '2026-08-28T01:00:01.000Z',
    content_sha256: '',
  }
  value.content_sha256 = computeOKFCatalogV1Hash(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v2 OKF compiler', () => {
  it('separates title, summary, and content views byte-for-byte', () => {
    const scope = `sha256_${'2'.repeat(64)}`
    const lockfile = makeMemory(scope, 'mem_lockfile', '不要直接删除锁文件', ['mem_peer'])
    const peer = makeMemory(scope, 'mem_peer', '先检查 Peer 冲突')
    const output = compileOKFGenerationV2({
      catalog: makeCatalog(scope), memories: [peer, lockfile], created_at: '2026-08-28T01:00:02.000Z',
    })

    const root = output.files.get('indexes/root.json')!
    expect(root).toContain('构建问题')
    expect(root).not.toContain('构建和依赖问题的分类总结')
    expect(root).not.toContain('不要直接删除锁文件')

    const buildId = computeOKFCatalogNodeIdV1(scope, 'node_root', '构建问题')
    const node = output.files.get(`indexes/nodes/${buildId}.json`)!
    expect(node).toContain('构建和依赖问题的分类总结')
    expect(node).toContain('不要直接删除锁文件')
    expect(node).not.toContain('不要直接删除锁文件 的简短总结')
    expect(node).not.toContain('完整正文')

    const summary = output.files.get('summaries/mem_lockfile.json')!
    expect(summary).toContain('不要直接删除锁文件 的简短总结')
    expect(summary).not.toContain('完整正文')

    const content = output.files.get('contents/mem_lockfile.md')!
    expect(content).toContain('不要直接删除锁文件 的完整正文')
    expect(content).toContain('先检查 Peer 冲突')
    expect(content).not.toContain('先检查 Peer 冲突 的完整正文')
  })

  it('is deterministic for the same explicit inputs', () => {
    const scope = `sha256_${'3'.repeat(64)}`
    const memories = [makeMemory(scope, 'mem_peer', 'Peer'), makeMemory(scope, 'mem_lockfile', 'Lockfile')]
    const request = { catalog: makeCatalog(scope), memories, created_at: '2026-08-28T01:00:02.000Z' }
    const first = compileOKFGenerationV2(request)
    const second = compileOKFGenerationV2({ ...request, memories: [...memories].reverse() })
    expect(second.generation_id).toBe(first.generation_id)
    expect([...second.files]).toEqual([...first.files])
  })

  it('rejects dangling catalog and related memory references', () => {
    const scope = `sha256_${'4'.repeat(64)}`
    const catalog = makeCatalog(scope)
    expect(() => compileOKFGenerationV2({
      catalog, memories: [makeMemory(scope, 'mem_lockfile', 'Lockfile')], created_at: '2026-08-28T01:00:02.000Z',
    })).toThrow()

    const related = makeMemory(scope, 'mem_lockfile', 'Lockfile', ['mem_missing'])
    const reduced = structuredClone(catalog)
    reduced.nodes[1]!.memory_refs = ['mem_lockfile']
    reduced.content_sha256 = computeOKFCatalogV1Hash(reduced)
    expect(() => compileOKFGenerationV2({ catalog: reduced, memories: [related], created_at: '2026-08-28T01:00:02.000Z' })).toThrow()
  })

  it('atomically publishes a verified v2 CURRENT world', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    await store.putMemory(makeMemory(scope, 'mem_peer', '先检查 Peer 冲突'))
    await store.putMemory(makeMemory(scope, 'mem_lockfile', '不要直接删除锁文件', ['mem_peer']))
    const catalogResult = await store.putCatalog(makeCatalog(scope))

    const published = await publishOKFGenerationV2({
      project_root: root,
      project_scope_id: scope,
      catalog_id: catalogResult.catalog_id,
      created_at: '2026-08-28T01:00:02.000Z',
    })
    const world = await readCurrentOKFGenerationV2({ project_root: root, project_scope_id: scope })
    expect(world.manifest.generation_id).toBe(published.generation_id)
    expect(world.files.get('indexes/root.json')).toContain('构建问题')
    expect(world.files.get('contents/mem_lockfile.md')).toContain('先检查 Peer 冲突')
  })

  it('publishes only memories referenced by the selected catalog', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    await store.putMemory(makeMemory(scope, 'mem_peer', '先检查 Peer 冲突'))
    await store.putMemory(makeMemory(scope, 'mem_lockfile', '不要直接删除锁文件'))
    await store.putMemory(makeMemory(scope, 'mem_unpublished', '未发布的孤立写入'))
    const catalogResult = await store.putCatalog(makeCatalog(scope))

    const world = await publishOKFGenerationV2({
      project_root: root,
      project_scope_id: scope,
      catalog_id: catalogResult.catalog_id,
      created_at: '2026-08-28T01:00:02.000Z',
    })
    expect(world.manifest.memory_refs.map((ref) => ref.memory_id)).toEqual(['mem_lockfile', 'mem_peer'])
    expect(world.files.has('contents/mem_unpublished.md')).toBe(false)
  })
})
