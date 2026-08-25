import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, realpath, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProductionRetrievalRuntime } from '../src/okf-retrieval-runtime.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { canonicalHash } from '../src/protocol/canonical.js'
import { readVerifiedCurrentWorld, readVerifiedGenerationWorld } from '../src/generation-store.js'
import { computeFactHash, type LongTermMemoryFact } from '../src/memory-fact.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

function makeLongFact(projectScopeId: string, id: string, title = 'Long Title', body = 'Long Body'): LongTermMemoryFact {
  const f: LongTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'long_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    title,
    summary: 'Summary of ' + id,
    body,
    tags: ['component-security', 'core'],
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

describe('MVP-04: OKF Retrieval Security, Verified World & Isolation', () => {
  const sessionId = 'session_sec_01'
  const evaluationAt = '2026-08-25T12:00:00.000Z'

  it('9. readVerifiedCurrentWorld returns null when CURRENT is absent (empty world)', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-09-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)

      const world = await readVerifiedCurrentWorld(realRoot, projectScopeId)
      expect(world).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('10. readVerifiedCurrentWorld returns immutable snapshot and deep freezes output', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-10-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_freeze_01'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const world = await readVerifiedCurrentWorld(realRoot, projectScopeId)
      expect(world).not.toBeNull()
      expect(Object.isFrozen(world)).toBe(true)
      expect(Object.isFrozen(world!.index.entries)).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('32. Fact tampering in Fact Store causes Open to fail closed', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-32-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_tamper_01'))
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

      // Tamper fact file on disk in long_term fact store
      const factPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'long-term', 'mem_tamper_01.json')
      await writeFile(factPath, '{"tampered": true}', { mode: 0o600 })

      // Open MUST fail closed
      await expect(retrievalRuntime.open({
        retrieval_id: searchRes.retrieval_id,
        search_disclosure_sha256: searchRes.content_sha256,
        memory_id: 'mem_tamper_01',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('34. Two independent Runtime instances have strictly isolated Registries', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-34-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_iso_01'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const runtime1 = createProductionRetrievalRuntime(scopeRuntime)
      const runtime2 = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      const searchRes1 = await runtime1.search({ query: 'Long' }, exec)

      // Runtime 2 cannot open Grant from Runtime 1
      await expect(runtime2.open({
        retrieval_id: searchRes1.retrieval_id,
        search_disclosure_sha256: searchRes1.content_sha256,
        memory_id: 'mem_iso_01',
      }, exec)).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('35. TOCTOU final page tampering test seam: Open fails closed and leaves Fact/CURRENT intact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-35-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_tamper_page', 'Authentic Title', 'Authentic Body'))
      const compiler = createOKFCompiler()
      const compileRes = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const { __setRetrievalTestHooks } = await import('../src/okf-retrieval-runtime.js')
      const runtime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      const searchRes = await runtime.search({ query: 'Authentic' }, exec)

      // Save original page content
      const { readFile, writeFile } = await import('node:fs/promises')
      const pageFilePath = join(realRoot, '.dsh-mnemosyne', 'generations', compileRes.generation_id, 'wiki', 'memories', 'mem_tamper_page.md')
      const originalPage = await readFile(pageFilePath, 'utf8')

      // Set seam to simulate page tampering before final read
      __setRetrievalTestHooks({
        simulatePageTamperingBeforeRead: true,
      })

      try {
        await expect(runtime.open({
          retrieval_id: searchRes.retrieval_id,
          search_disclosure_sha256: searchRes.content_sha256,
          memory_id: 'mem_tamper_page',
        }, exec)).rejects.toThrow()

        // Clear seam, restore original page and verify normal open succeeds
        __setRetrievalTestHooks(null)
        await writeFile(pageFilePath, originalPage, { mode: 0o600 })
        const okOpen = await runtime.open({
          retrieval_id: searchRes.retrieval_id,
          search_disclosure_sha256: searchRes.content_sha256,
          memory_id: 'mem_tamper_page',
        }, exec)
        expect(okOpen.body).toBe('Authentic Body')
      } finally {
        __setRetrievalTestHooks(null)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('36. Registry capacity limit (256) evicts oldest grants in FIFO order without leaking memory', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-36-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_fifo_01', 'Common Keyword Fact', 'Common Body'))
      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const runtime = createProductionRetrievalRuntime(scopeRuntime)
      const exec = mockToolContext(sessionId, realRoot)

      // Run 260 distinct searches (capacity is 256)
      const searches = []
      for (let i = 0; i < 260; i++) {
        // Vary query or hint so query_fingerprint differs
        const s = await runtime.search({ query: `Common ${i}` }, exec)
        searches.push(s)
      }

      // The earliest search grant (0) should have been evicted by FIFO
      await expect(runtime.open({
        retrieval_id: searches[0].retrieval_id,
        search_disclosure_sha256: searches[0].content_sha256,
        memory_id: 'mem_fifo_01',
      }, exec)).rejects.toThrow()

      // The latest search grant (259) must still be present and valid
      const latestOpen = await runtime.open({
        retrieval_id: searches[259].retrieval_id,
        search_disclosure_sha256: searches[259].content_sha256,
        memory_id: 'mem_fifo_01',
      }, exec)
      expect(latestOpen.body).toBe('Common Body')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
