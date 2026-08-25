import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProductionRetrievalRuntime } from '../src/okf-retrieval-runtime.js'
import { computeProjectScopeId, computeSessionScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { computeFactHash, type ShortTermMemoryFact, type LongTermMemoryFact } from '../src/memory-fact.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

function makeShortFact(projectScopeId: string, sessionScopeId: string, id: string, title = 'Short Title', body = 'Short Body'): ShortTermMemoryFact {
  const f: ShortTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'short_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    session_scope_id: sessionScopeId,
    title,
    summary: 'Summary of ' + id,
    body,
    tags: ['auth', 'session'],
    created_at: '2026-08-25T10:00:00.000Z',
    expires_at: '2026-08-25T14:00:00.000Z',
    content_sha256: '',
  }
  f.content_sha256 = computeFactHash(f)
  return f
}

function makeLongFact(projectScopeId: string, id: string, title = 'Long Title', body = 'Long Body'): LongTermMemoryFact {
  const f: LongTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'long_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    title,
    summary: 'Summary of ' + id,
    body,
    tags: ['compiler', 'component-build'],
    created_at: '2026-08-25T10:00:00.000Z',
    source_short_term_refs: [],
    content_sha256: '',
  }
  f.content_sha256 = computeFactHash(f)
  return f
}

function mockToolContext(sessionId: string, projectRoot: string): ToolRunContext {
  return {
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        header: { cwd: projectRoot },
      },
    },
  } as unknown as ToolRunContext
}

describe('MVP-04C: OKF Bound Open & Disclosure Registry', () => {
  const sessionId = 'session_open_01'
  const evaluationAt = '2026-08-25T12:00:00.000Z'

  it('26. Valid 3-parameter Open returns full body L3 disclosure', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-26-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const sessionScopeId = computeSessionScopeId(projectScopeId, sessionId)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_open_01', 'Auth Token', 'Detailed Secret Body Text'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_open_02', 'Compiler Cache', 'Detailed Compiler Cache Body'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      // 1. Search
      const searchRes = await retrievalRuntime.search({ query: 'Compiler' }, exec)
      expect(searchRes.level).toBe(2)
      expect(searchRes.items.length).toBe(1)
      expect(searchRes.items[0].memory_ref.memory_id).toBe('mem_open_02')
      expect((searchRes.items[0] as unknown as { body?: string }).body).toBeUndefined()

      // 2. Open
      const openRes = await retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_open_02',
      }, exec)

      expect(openRes.level).toBe(3)
      expect(openRes.memory_ref.memory_id).toBe('mem_open_02')
      expect(openRes.body).toBe('Detailed Compiler Cache Body')
      expect(openRes.parent_disclosure_sha256).toBe(searchRes.content_sha256)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('27. Any missing or invalid parameter in Open is strictly rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-27-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_open_02'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      const searchRes = await retrievalRuntime.search({ query: 'Long' }, exec)

      // Wrong retrieval_id
      await expect(retrievalRuntime.open({
        retrieval_id: 'retrieval_wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrong',
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_open_02',
      }, exec)).rejects.toThrow()

      // Wrong search_disclosure_sha256
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        memory_id: 'mem_open_02',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('28. Memory not returned by parent Search Disclosure cannot be opened', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-28-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_open_included', 'Included Fact'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_open_unrelated', 'Unrelated Fact Other Topic'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      // Search only matches mem_open_included
      const searchRes = await retrievalRuntime.search({ query: 'Included' }, exec)
      expect(searchRes.items.map(i => i.memory_ref.memory_id)).toEqual(['mem_open_included'])

      // Attempt to open unreturned memory fails closed
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_open_unrelated',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('29. Cross-Session or Cross-Project open is rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-29-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_open_cross'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const execSessionA = mockToolContext('session_A', realRoot)
      const execSessionB = mockToolContext('session_B', realRoot)

      const searchRes = await retrievalRuntime.search({ query: 'Long' }, execSessionA)

      // Session B trying to open Session A's search grant is rejected
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_open_cross',
      }, execSessionB)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('30. When CURRENT advances after Search, Open still reads the Search-fixed historical Generation', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-30-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_v1', 'Version 1 Fact', 'Body of Version 1'))
      const compiler = createOKFCompiler()
      const gen1Res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      // 1. Search against Gen 1
      const searchRes = await retrievalRuntime.search({ query: 'Version' }, exec)
      expect(searchRes.generation_ref?.generation_id).toBe(gen1Res.generation_id)

      // 2. Add new fact and advance CURRENT to Gen 2
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_v2', 'Version 2 Fact', 'Body of Version 2'))
      const gen2Res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: '2026-08-25T13:00:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })
      expect(gen2Res.generation_id).not.toBe(gen1Res.generation_id)

      // 3. Open Gen 1 search result still opens Gen 1 world!
      const openRes = await retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_v1',
      }, exec)

      expect(openRes.generation_ref.generation_id).toBe(gen1Res.generation_id)
      expect(openRes.body).toBe('Body of Version 1')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('31. Old Generation deletion or corruption causes Open to fail closed without fallback', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-31-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_del_01', 'Del Fact', 'Body'))
      const compiler = createOKFCompiler()
      const gen1Res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      const searchRes = await retrievalRuntime.search({ query: 'Del' }, exec)

      // Delete the Gen 1 generation directory
      await rm(join(realRoot, '.dsh-mnemosyne', 'generations', gen1Res.generation_id), { recursive: true, force: true })

      // Open MUST fail closed (not fallback)
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_del_01',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('33. Runtime clear / dispose invalidates all prior grants', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-33-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_clear_01'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      const searchRes = await retrievalRuntime.search({ query: 'Long' }, exec)

      // Clear runtime
      retrievalRuntime.clear()

      // Open now fails
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_clear_01',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('34. Cross-session search/open isolation with keyword collision', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-open-34-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const sessionScopeIdA = computeSessionScopeId(projectScopeId, 'session_A')
      const sessionScopeIdB = computeSessionScopeId(projectScopeId, 'session_B')

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_long_coll', 'Collision Long Fact', 'Body of Long Collision'))
      await store.putShortTerm(sessionScopeIdA, makeShortFact(projectScopeId, sessionScopeIdA, 'mem_short_a', 'Collision Short A', 'Private Session A Body'))
      await store.putShortTerm(sessionScopeIdB, makeShortFact(projectScopeId, sessionScopeIdB, 'mem_short_b', 'Collision Short B', 'Private Session B Body'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const retrievalRuntime = createProductionRetrievalRuntime(scopeRuntime)

      const execA = mockToolContext('session_A', realRoot)
      const execB = mockToolContext('session_B', realRoot)

      // Session A search
      const searchResA = await retrievalRuntime.search({ query: 'Collision' }, execA)
      const idsA = searchResA.items.map((it) => it.memory_ref.memory_id)
      expect(idsA).toContain('mem_short_a')
      expect(idsA).toContain('mem_long_coll')
      expect(idsA).not.toContain('mem_short_b')

      // Session A open own memory -> succeeds
      const openA = await retrievalRuntime.open({
        retrieval_id: searchResA.retrieval_id,
        search_disclosure_sha256: searchResA.content_sha256,
        memory_id: 'mem_short_a',
      }, execA)
      expect(openA.body).toBe('Private Session A Body')

      // Session A open B's memory with A's grant -> fails
      await expect(retrievalRuntime.open({
        retrieval_id: searchResA.retrieval_id,
        search_disclosure_sha256: searchResA.content_sha256,
        memory_id: 'mem_short_b',
      }, execA)).rejects.toThrow()

      // Session B search
      const searchResB = await retrievalRuntime.search({ query: 'Collision' }, execB)
      const idsB = searchResB.items.map((it) => it.memory_ref.memory_id)
      expect(idsB).toContain('mem_short_b')
      expect(idsB).toContain('mem_long_coll')
      expect(idsB).not.toContain('mem_short_a')

      // Session B open own memory -> succeeds
      const openB = await retrievalRuntime.open({
        retrieval_id: searchResB.retrieval_id,
        search_disclosure_sha256: searchResB.content_sha256,
        memory_id: 'mem_short_b',
      }, execB)
      expect(openB.body).toBe('Private Session B Body')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
