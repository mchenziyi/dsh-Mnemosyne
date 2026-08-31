import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import {
  canonicalizeOKFMemoryV2,
  computeOKFMemoryV2Hash,
  type OKFMemoryV2,
} from '../src/v2/okf-memory.js'
import {
  canonicalizeOKFCatalogV1,
  computeOKFCatalogNodeIdV1,
  computeOKFCatalogV1Hash,
  validateOKFCatalogV1,
  type OKFCatalogV1,
} from '../src/v2/okf-catalog.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'
import { MemoryStoreError } from '../src/memory-store-error.js'

const roots: string[] = []

async function project(): Promise<{ root: string; scope: string }> {
  const created = await mkdtemp(join(tmpdir(), 'mnemosyne-v2-store-'))
  const root = await realpath(created)
  roots.push(root)
  return { root, scope: computeProjectScopeId(root) }
}

function memory(scope: string, id = 'mem_v2_alpha', related: string[] = []): OKFMemoryV2 {
  const value: OKFMemoryV2 = {
    schema_version: 2,
    memory_id: id,
    project_scope_id: scope,
    title: '先确认错误来源',
    summary: '遇到依赖安装失败时，先判断错误来源，不要直接删除锁文件。',
    content: '## 遇到的问题\n\n依赖安装失败。\n\n## 已知踩坑\n\n直接删除锁文件会导致无关依赖漂移。\n\n## 验证方式\n\n重新执行类型检查与测试。',
    related_memory_refs: related,
    created_at: '2026-08-28T00:00:00.000Z',
    content_sha256: '',
  }
  value.content_sha256 = computeOKFMemoryV2Hash(value)
  return value
}

function catalog(scope: string, memoryId = 'mem_v2_alpha'): OKFCatalogV1 {
  const dependenciesId = computeOKFCatalogNodeIdV1(scope, 'node_root', '依赖管理')
  const value: OKFCatalogV1 = {
    schema_version: 1,
    project_scope_id: scope,
    root_node_id: 'node_root',
    nodes: [
      {
        node_id: 'node_root',
        title: '项目记忆',
        summary: '项目记忆根目录。',
        parent_node_id: null,
        child_node_refs: [dependenciesId],
        memory_refs: [],
      },
      {
        node_id: dependenciesId,
        title: '依赖管理',
        summary: '依赖安装、锁文件与版本冲突相关经验。',
        parent_node_id: 'node_root',
        child_node_refs: [],
        memory_refs: [memoryId],
      },
    ],
    updated_at: '2026-08-28T00:00:01.000Z',
    content_sha256: '',
  }
  value.content_sha256 = computeOKFCatalogV1Hash(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v2 OKF memory schema and store', () => {
  it('canonicalizes memory deterministically and rejects tampering', () => {
    const scope = `sha256_${'1'.repeat(64)}`
    const first = memory(scope, 'mem_v2_alpha', ['mem_z', 'mem_a'])
    const second = memory(scope, 'mem_v2_alpha', ['mem_a', 'mem_z'])
    second.content_sha256 = computeOKFMemoryV2Hash(second)

    expect(canonicalizeOKFMemoryV2(first)).toBe(canonicalizeOKFMemoryV2(second))
    expect(() => canonicalizeOKFMemoryV2({ ...first, summary: 'tampered' })).toThrow(MemoryStoreError)
    expect(() => canonicalizeOKFMemoryV2({ ...first, tags: [] } as unknown as OKFMemoryV2)).toThrow(MemoryStoreError)
  })

  it('writes immutable memories, returns noop, and never lists legacy v1 facts', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    const item = memory(scope)

    expect(await store.putMemory(item)).toMatchObject({ status: 'created', memory_id: item.memory_id })
    expect(await store.putMemory(item)).toMatchObject({ status: 'noop', memory_id: item.memory_id })
    expect(await store.getMemory(item.memory_id)).toEqual(item)

    await mkdir(join(root, '.dsh-mnemosyne', 'facts', 'long-term'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, '.dsh-mnemosyne', 'facts', 'long-term', 'mem_legacy.json'), '{"schema_version":1}', { mode: 0o600 })
    expect((await store.listMemories()).map((entry) => entry.memory_id)).toEqual([item.memory_id])
    expect(await readFile(join(root, '.dsh-mnemosyne', 'facts', 'long-term', 'mem_legacy.json'), 'utf8')).toBe('{"schema_version":1}')
  })

  it('rejects identity conflicts and dangling related memories', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    const item = memory(scope)
    await store.putMemory(item)

    const changed = { ...item, summary: '不同内容', content_sha256: '' }
    changed.content_sha256 = computeOKFMemoryV2Hash(changed)
    await expect(store.putMemory(changed)).rejects.toMatchObject({ code: 'memory_store_identity_conflict' })
    await expect(store.putMemory(memory(scope, 'mem_v2_related', ['mem_missing']))).rejects.toMatchObject({ code: 'memory_store_not_found' })
  })

  it('validates catalog tree and memory reference closure before immutable publication', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    await store.putMemory(memory(scope))
    const value = catalog(scope)

    const created = await store.putCatalog(value)
    expect(created.status).toBe('created')
    expect(await store.getCatalog(created.catalog_id)).toEqual(validateOKFCatalogV1(value))
    expect(canonicalizeOKFCatalogV1(value)).toContain('"root_node_id":"node_root"')

    const dangling = catalog(scope, 'mem_missing')
    await expect(store.putCatalog(dangling)).rejects.toMatchObject({ code: 'memory_store_not_found' })

    const cyclic = structuredClone(value)
    cyclic.nodes[0]!.parent_node_id = cyclic.nodes[1]!.node_id
    cyclic.nodes[1]!.child_node_refs = ['node_root']
    expect(() => canonicalizeOKFCatalogV1(cyclic)).toThrow(MemoryStoreError)
  })

  it('rejects cross-project objects and keeps canonical files byte-stable', async () => {
    const { root, scope } = await project()
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: scope })
    const otherScope = `sha256_${'f'.repeat(64)}`
    await expect(store.putMemory(memory(otherScope))).rejects.toMatchObject({ code: 'memory_store_scope_mismatch' })

    const item = memory(scope)
    await store.putMemory(item)
    const bytes = await readFile(join(root, '.dsh-mnemosyne', 'v2', 'memories', `${item.memory_id}.json`), 'utf8')
    expect(bytes).toBe(canonicalizeOKFMemoryV2(item))
  })
})
