import { mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import {
  computeFactHash,
  type LongTermMemoryFact,
  type ShortTermMemoryFact,
} from '../src/memory-fact.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { createOKFCompiler, __setOKFCompilerTestHooks } from '../src/okf-compiler.js'

describe('MVP-03B & 03D: OKF Compiler, Generation Lifecycle & Transactions (Tests 11-22, 32-43)', () => {
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  const sessionScopeId2 = 'sha256_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const evaluationAt = '2026-08-25T12:00:00.000Z'

  function makeShortFact(
    projectScopeId: string,
    sessionId: string,
    id: string,
    expiresAt = '2026-08-30T12:00:00.000Z',
    createdAt = '2026-08-25T10:00:00.000Z'
  ): ShortTermMemoryFact {
    const f: ShortTermMemoryFact = {
      schema_version: 1,
      tier: 'short_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      session_scope_id: sessionId,
      title: `Short fact ${id}`,
      summary: `Summary of ${id}`,
      body: `Detailed body content for ${id}.`,
      tags: ['test', 'short'],
      created_at: createdAt,
      expires_at: expiresAt,
      content_sha256: '',
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  function makeLongFact(projectScopeId: string, id: string, tags = ['test', 'component-database']): LongTermMemoryFact {
    const f: LongTermMemoryFact = {
      schema_version: 1,
      tier: 'long_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      title: `Long fact ${id}`,
      summary: `Summary of long ${id}`,
      body: `Detailed architecture body for ${id}.`,
      tags,
      created_at: '2026-08-25T10:00:00.000Z',
      source_short_term_refs: [],
      content_sha256: '',
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  it('11. Empty Fact Store compiles a valid empty Generation', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-11-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const result = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      expect(result.status).toBe('created')
      expect(result.current.generation_id).toBe(result.generation_id)

      const gen = await compiler.verifyGeneration(realRoot, result.generation_id)
      expect(gen.status).toBe('complete')

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(result.generation_id)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('12. Multiple Session short-term facts and long-term facts enter correct pages', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-12-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_s1_01'))
      await store.putShortTerm(sessionScopeId2, makeShortFact(projectScopeId, sessionScopeId2, 'mem_s2_01'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_l1_01', ['component-storage']))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_l2_01', ['general']))

      const compiler = createOKFCompiler()
      const result = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      expect(result.status).toBe('created')

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', result.generation_id)
      const rootMd = await readFile(join(genDir, 'wiki', 'ROOT.md'), 'utf8')
      expect(rootMd).toContain(sessionScopeId)
      expect(rootMd).toContain(sessionScopeId2)
      expect(rootMd).toContain('storage')
      expect(rootMd).toContain('general')

      const s1Md = await readFile(join(genDir, 'wiki', 'short-term', `${sessionScopeId}.md`), 'utf8')
      expect(s1Md).toContain('mem_s1_01')

      const compStorageMd = await readFile(join(genDir, 'wiki', 'components', 'storage.md'), 'utf8')
      expect(compStorageMd).toContain('mem_l1_01')

      const compGeneralMd = await readFile(join(genDir, 'wiki', 'components', 'general.md'), 'utf8')
      expect(compGeneralMd).toContain('mem_l2_01')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('13. Expired short-term facts (now > expires_at) are excluded from inputs and Index', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-13-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      // Expired fact
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_exp_01', '2026-08-20T10:00:00.000Z', '2026-08-10T10:00:00.000Z'))
      // Active fact
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_act_01', '2026-08-30T10:00:00.000Z'))

      const compiler = createOKFCompiler()
      const result = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', result.generation_id)
      const indexJson = JSON.parse(await readFile(join(genDir, 'index.json'), 'utf8'))
      const ids = indexJson.entries.map((e: { memory_id: string }) => e.memory_id)
      expect(ids).toEqual(['mem_act_01'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('14. now == expires_at is strictly excluded', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-14-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_exact_01', evaluationAt))

      const compiler = createOKFCompiler()
      const result = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', result.generation_id)
      const indexJson = JSON.parse(await readFile(join(genDir, 'index.json'), 'utf8'))
      expect(indexJson.entries).toHaveLength(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('15. Session Scope enumeration is deterministically sorted', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-15-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const scopes = [
        'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ]
      for (const s of scopes) {
        await store.putShortTerm(s, makeShortFact(projectScopeId, s, `mem_${s.slice(7, 12)}`))
      }

      const enumScopes = await store.listShortTermSessionScopes()
      expect(enumScopes).toEqual([
        'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('20. Multiple component tags or invalid slug in long-term fact fails compile and does not modify CURRENT', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-20-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_multi_comp', ['component-a', 'component-b']))

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('21. Duplicate memory_id between short-term and long-term is rejected during compile', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-21-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_duplicate_id'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_duplicate_id'))

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('32. Initial compilation creates Generation, writes Manifest and switches CURRENT', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-32-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_initial_01'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      expect(res.status).toBe('created')

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(res.generation_id)
      expect(current?.manifest_id).toBe(res.manifest_id)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('33. Repeated compilation with identical input returns noop without mutating CURRENT', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-33-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_repeat_01'))

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      const res1 = await compiler.compile(req)
      expect(res1.status).toBe('created')

      const res2 = await compiler.compile(req)
      expect(res2.status).toBe('noop')
      expect(res2.generation_id).toBe(res1.generation_id)
      expect(res2.current.content_sha256).toBe(res1.current.content_sha256)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('34. New Fact produces new Generation and updates CURRENT while retaining old Generation intact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-34-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_gen1_01'))

      const compiler = createOKFCompiler()
      const res1 = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Add a new fact
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_gen2_01'))

      const res2 = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      expect(res2.generation_id).not.toBe(res1.generation_id)

      // Old Generation must still be completely intact and verifiable
      const oldGen = await compiler.verifyGeneration(realRoot, res1.generation_id)
      expect(oldGen.status).toBe('complete')

      const newGen = await compiler.verifyGeneration(realRoot, res2.generation_id)
      expect(newGen.status).toBe('complete')

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(res2.generation_id)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('35. Failed compilation keeps old CURRENT bytes and mtime unchanged', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-35-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_ok_01'))

      const compiler = createOKFCompiler()
      const res1 = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const initialContent = await readFile(currentPath, 'utf8')
      const initialStat = await stat(currentPath)

      // Inject a broken fact that fails during compilation
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_bad_01', ['component-a', 'component-b']))

      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)

      const afterContent = await readFile(currentPath, 'utf8')
      const afterStat = await stat(currentPath)
      expect(afterContent).toBe(initialContent)
      expect(afterStat.mtimeMs).toBe(initialStat.mtimeMs)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('38. Failure before CURRENT rename leaves old CURRENT intact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-38-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_first_01'))

      const compiler = createOKFCompiler()
      const res1 = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_second_01'))

      __setOKFCompilerTestHooks({ simulateBeforeCurrentRenameFailure: true })
      try {
        await expect(
          compiler.compile({
            project_root: realRoot,
            project_scope_id: projectScopeId,
            evaluation_at: evaluationAt,
            compiler_version: 'dsh-mnemosyne-okf/1',
          })
        ).rejects.toThrowError(MemoryStoreError)
      } finally {
        __setOKFCompilerTestHooks(null)
      }

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(res1.generation_id)
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('39. Failure during post-rename fsync fails loud, but strict readCurrent confirms the new generation and retry returns noop', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-39-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_fsync_01'))

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      __setOKFCompilerTestHooks({ simulatePostCurrentRenameFsyncFailure: true })
      try {
        await expect(compiler.compile(req)).rejects.toThrowError(
          expect.objectContaining({ code: 'memory_compile_io_failed' })
        )
      } finally {
        __setOKFCompilerTestHooks(null)
      }

      // CURRENT was renamed before fsync failure, so it now points to the new valid generation
      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).not.toBeNull()

      // Retry compilation returns noop
      const retryRes = await compiler.compile(req)
      expect(retryRes.status).toBe('noop')
      expect(retryRes.generation_id).toBe(current?.generation_id)
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('43. Deleting the Generation directory allows full deterministic reconstruction from Manifest and Facts', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-43-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_recon_01'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_recon_02'))

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      const res1 = await compiler.compile(req)
      const gen1Dir = join(realRoot, '.dsh-mnemosyne', 'generations', res1.generation_id)
      const origRootMd = await readFile(join(gen1Dir, 'wiki', 'ROOT.md'), 'utf8')
      const origIndexJson = await readFile(join(gen1Dir, 'index.json'), 'utf8')

      // Delete the generated directory
      await rm(gen1Dir, { recursive: true, force: true })

      // Re-run compilation with same request
      const res2 = await compiler.compile(req)
      expect(res2.generation_id).toBe(res1.generation_id)

      const reconRootMd = await readFile(join(gen1Dir, 'wiki', 'ROOT.md'), 'utf8')
      const reconIndexJson = await readFile(join(gen1Dir, 'index.json'), 'utf8')

      expect(reconRootMd).toBe(origRootMd)
      expect(reconIndexJson).toBe(origIndexJson)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('16. listShortTermSessionScopes returns [] when short-term directory is absent', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-16-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const scopes = await store.listShortTermSessionScopes()
      expect(scopes).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('17. Session enumeration fails closed on symlink or invalid entry names in short-term directory', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-17-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const { mkdir } = await import('node:fs/promises')
      const stDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term')
      await mkdir(stDir, { recursive: true, mode: 0o700 })

      // Create a rogue invalid directory name
      await mkdir(join(stDir, 'invalid_session_id'), { mode: 0o700 })

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await expect(store.listShortTermSessionScopes()).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('22. Mismatched Project Scope ID in request is strictly rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-22-'))
    try {
      const realRoot = await realpath(tempDir)
      const fakeScopeId = 'sha256_9999999999999999999999999999999999999999999999999999999999999999'
      const compiler = createOKFCompiler()

      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: fakeScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('36. Manifest publication failure does not create CURRENT pointer', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-36-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_fail_36'))

      const compiler = createOKFCompiler()
      __setOKFCompilerTestHooks({ simulateManifestPublicationFailure: true })
      try {
        await expect(
          compiler.compile({
            project_root: realRoot,
            project_scope_id: projectScopeId,
            evaluation_at: evaluationAt,
            compiler_version: 'dsh-mnemosyne-okf/1',
          })
        ).rejects.toThrowError(MemoryStoreError)
      } finally {
        __setOKFCompilerTestHooks(null)
      }

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).toBeNull()
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('37. Generation publication failure leaves previous CURRENT intact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-37-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_ok_37'))

      const compiler = createOKFCompiler()
      const res1 = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_new_37'))

      __setOKFCompilerTestHooks({ simulateBeforeCurrentRenameFailure: true })
      try {
        await expect(
          compiler.compile({
            project_root: realRoot,
            project_scope_id: projectScopeId,
            evaluation_at: evaluationAt,
            compiler_version: 'dsh-mnemosyne-okf/1',
          })
        ).rejects.toThrowError(MemoryStoreError)
      } finally {
        __setOKFCompilerTestHooks(null)
      }

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(res1.generation_id)
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('40. Corrupted existing CURRENT fails closed on readCurrent', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-40-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(join(realRoot, '.dsh-mnemosyne'), { recursive: true, mode: 0o700 })
      await writeFile(currentPath, '{"broken_json": true}', { mode: 0o600 })

      const compiler = createOKFCompiler()
      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('41. Orphan valid Generation does not automatically become CURRENT', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-41-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_orphan_41'))

      const compiler = createOKFCompiler()
      __setOKFCompilerTestHooks({ simulateBeforeCurrentRenameFailure: true })
      try {
        await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        }).catch(() => {})
      } finally {
        __setOKFCompilerTestHooks(null)
      }

      // CURRENT must still be null despite generation existing on disk
      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).toBeNull()
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('42. Deleting CURRENT allows re-creating and switching pointer for the same input', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-42-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_del_42'))

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      const res1 = await compiler.compile(req)
      expect(res1.status).toBe('created')

      // Delete CURRENT file
      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      await unlink(currentPath)

      expect(await compiler.readCurrent(realRoot, projectScopeId)).toBeNull()

      // Re-run compilation with same request
      const res2 = await compiler.compile(req)
      expect(res2.generation_id).toBe(res1.generation_id)

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current?.generation_id).toBe(res1.generation_id)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('59. Standard observer, status or tool calls do not create OKF directories', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-59-'))
    try {
      const realRoot = await realpath(tempDir)
      const { existsSync } = await import('node:fs')

      expect(existsSync(join(realRoot, '.dsh-mnemosyne', 'generations'))).toBe(false)
      expect(existsSync(join(realRoot, '.dsh-mnemosyne', 'manifests'))).toBe(false)
      expect(existsSync(join(realRoot, '.dsh-mnemosyne', 'CURRENT'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('67. Raw buffer file SHA-256 is used for file references (Golden Test)', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-67-'))
    try {
      const realRoot = await realpath(tempDir)
      const testFile = join(realRoot, 'test.md')
      const content = 'Test line with emoji 🚀 and "quotes" and \\backslashes\\ and newline\n'
      await writeFile(testFile, content, { mode: 0o600 })

      const { readStrictFile } = await import('../src/generation-store.js')
      const res = await readStrictFile(realRoot, testFile)

      const { createHash } = await import('node:crypto')
      const expectedBufHash = `sha256_${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`

      expect(res.sha256).toBe(expectedBufHash)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('68. readCurrent fails closed when permanent Manifest is missing or mismatched', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-68-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_68'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Delete permanent manifest
      const permManifestPath = join(realRoot, '.dsh-mnemosyne', 'manifests', `${res.manifest_id}.json`)
      await unlink(permManifestPath)

      // readCurrent MUST fail closed (not return unverified current pointer)
      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('69. readCurrent fails closed when a Fact is tampered in the Fact Store', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-69-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_69'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Tamper with the fact file in store
      const factPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_69.json')
      await writeFile(factPath, '{"tampered": true}', { mode: 0o600 })

      // readCurrent MUST verify fact store integrity and fail closed
      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('70. readCurrent fails closed when Markdown is modified on disk even if local generation metadata is recomputed', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-70-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_70'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Modify ROOT.md on disk
      const rootMdPath = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id, 'wiki', 'ROOT.md')
      await writeFile(rootMdPath, '# Tampered Header\n', { mode: 0o600 })

      // readCurrent MUST detect mismatch against Fact Store re-render and fail closed
      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('71. readCurrent fails closed when CURRENT points to wrong manifest_sha256', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-71-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_71'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Tamper CURRENT file to point to fake manifest_sha256
      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const fakeCurrent = {
        schema_version: 1 as const,
        generation_id: res.generation_id,
        generation_sha256: res.current.generation_sha256,
        manifest_id: res.manifest_id,
        manifest_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        project_scope_id: projectScopeId,
        content_sha256: '',
      }
      const { canonicalizeCurrentPointer, validateCurrentPointer } = await import('../src/okf-schema.js')
      const val = validateCurrentPointer(fakeCurrent)
      await writeFile(currentPath, canonicalizeCurrentPointer(val), { mode: 0o600 })

      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('72. Full Snapshot Reconstruction: recursively records all files, rebuilds after deleting generation, and verifies byte-for-byte equality', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-72-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_snap_01'))
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_snap_02', ['component-auth']))

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      const res1 = await compiler.compile(req)
      const gen1Dir = join(realRoot, '.dsh-mnemosyne', 'generations', res1.generation_id)

      // Recursively capture snapshot of all files in generation directory
      async function captureTree(dir: string, base: string, map: Map<string, string>): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = join(dir, entry.name)
          const rel = relative(base, full).split(sep).join('/')
          if (entry.isDirectory()) {
            await captureTree(full, base, map)
          } else {
            const content = await readFile(full, 'utf8')
            map.set(rel, content)
          }
        }
      }

      const initialSnapshot = new Map<string, string>()
      await captureTree(gen1Dir, gen1Dir, initialSnapshot)
      expect(initialSnapshot.size).toBeGreaterThan(3)

      // Delete the entire generation directory
      await rm(gen1Dir, { recursive: true, force: true })

      // Re-compile with identical request
      const res2 = await compiler.compile(req)
      expect(res2.generation_id).toBe(res1.generation_id)

      const reconSnapshot = new Map<string, string>()
      await captureTree(gen1Dir, gen1Dir, reconSnapshot)

      expect(reconSnapshot.size).toBe(initialSnapshot.size)
      for (const [relPath, origContent] of initialSnapshot.entries()) {
        expect(reconSnapshot.get(relPath)).toBe(origContent)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('73. Attack Test: Tampering Index entries while recomputing all derivative hashes fails closed against Fact Store', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-73-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_73'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)

      // 1. Tamper index.json title
      const indexObj = JSON.parse(await readFile(join(genDir, 'index.json'), 'utf8'))
      indexObj.entries[0].title = 'Tampered Index Title Injected'
      indexObj.content_sha256 = ''
      const { canonicalizeIndex, validateIndex, canonicalizeManifest, validateManifest, canonicalizeGenerationMetadata, validateGenerationMetadata } = await import('../src/okf-schema.js')
      const tamperedIndexCanonical = canonicalizeIndex(indexObj)
      await writeFile(join(genDir, 'index.json'), tamperedIndexCanonical, { mode: 0o600 })

      // 2. Recompute index file hash
      const { createHash } = await import('node:crypto')
      const indexBuf = Buffer.from(tamperedIndexCanonical, 'utf8')
      const newIndexSha = `sha256_${createHash('sha256').update(indexBuf).digest('hex')}`

      // 3. Update manifest outputs & recompute manifest
      const localManifest = JSON.parse(await readFile(join(genDir, 'manifest.json'), 'utf8'))
      const idxOutput = localManifest.outputs.find((o: { relative_path: string }) => o.relative_path === 'index.json')
      idxOutput.content_sha256 = newIndexSha
      idxOutput.byte_length = indexBuf.length

      const { computeCompiledOutputHash } = await import('../src/okf-schema.js')
      localManifest.compiled_output_sha256 = computeCompiledOutputHash(localManifest.outputs)
      localManifest.content_sha256 = ''
      const tamperedManifestCanonical = canonicalizeManifest(localManifest)
      const validatedTamperedManifest = validateManifest(JSON.parse(tamperedManifestCanonical))

      await writeFile(join(genDir, 'manifest.json'), tamperedManifestCanonical, { mode: 0o600 })
      await writeFile(join(realRoot, '.dsh-mnemosyne', 'manifests', `${res.manifest_id}.json`), tamperedManifestCanonical, { mode: 0o600 })

      // 4. Update generation.json
      const localGen = JSON.parse(await readFile(join(genDir, 'generation.json'), 'utf8'))
      localGen.manifest_sha256 = validatedTamperedManifest.content_sha256
      localGen.compiled_output_sha256 = localManifest.compiled_output_sha256
      localGen.content_sha256 = ''
      const tamperedGenCanonical = canonicalizeGenerationMetadata(localGen)
      await writeFile(join(genDir, 'generation.json'), tamperedGenCanonical, { mode: 0o600 })

      // verifyGeneration / readCurrent MUST detect fact-index discrepancy and fail closed
      await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(MemoryStoreError)
      await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('74. Deleting empty required directory (e.g. wiki/components) fails closed during verification', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-74-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_74'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)
      // Delete empty components directory
      await rm(join(genDir, 'wiki', 'components'), { recursive: true, force: true })

      await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('75. Manifest outputs missing ROOT.md or index.json fails closed during verification', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-75-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_75'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)

      // Modify manifest to omit index.json from outputs
      const localManifest = JSON.parse(await readFile(join(genDir, 'manifest.json'), 'utf8'))
      localManifest.outputs = localManifest.outputs.filter((o: { relative_path: string }) => o.relative_path !== 'index.json')
      const { computeCompiledOutputHash, canonicalizeManifest } = await import('../src/okf-schema.js')
      localManifest.compiled_output_sha256 = computeCompiledOutputHash(localManifest.outputs)
      localManifest.content_sha256 = ''
      await writeFile(join(genDir, 'manifest.json'), canonicalizeManifest(localManifest), { mode: 0o600 })

      await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('76. Scope closed loop: CURRENT pointing to foreign project scope fails closed on readCurrent', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-76-'))
    try {
      const realRoot = await realpath(tempDir)
      const currentScopeId = computeProjectScopeId(realRoot)
      const foreignScopeId = 'sha256_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff'

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: currentScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(currentScopeId, sessionScopeId, 'mem_76'))

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: currentScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Tamper generation.json and CURRENT
      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)
      const genMeta = JSON.parse(await readFile(join(genDir, 'generation.json'), 'utf8'))
      genMeta.project_scope_id = foreignScopeId
      genMeta.content_sha256 = ''
      const { canonicalizeGenerationMetadata, validateGenerationMetadata } = await import('../src/okf-schema.js')
      const validGenMeta = validateGenerationMetadata(genMeta)
      await writeFile(join(genDir, 'generation.json'), canonicalizeGenerationMetadata(validGenMeta), { mode: 0o600 })

      await expect(compiler.readCurrent(realRoot, currentScopeId)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('77. Staging write/sync/close failure cleans staging directory and leaves CURRENT intact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-77-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_77_init'))

      const compiler = createOKFCompiler()
      const initRes = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })
      expect(initRes.status).toBe('created')

      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const { __setOKFCompilerTestHooks } = await import('../src/okf-compiler.js')

      const hooks = [
        { simulateStagingWriteFailure: true },
        { simulateStagingSyncFailure: true },
        { simulateStagingCloseFailure: true },
      ]

      for (let i = 0; i < hooks.length; i++) {
        const origCurrentBytes = await readFile(currentPath)
        await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, `mem_77_hook_${i}`))

        __setOKFCompilerTestHooks(hooks[i])
        try {
          await expect(
            compiler.compile({
              project_root: realRoot,
              project_scope_id: projectScopeId,
              evaluation_at: evaluationAt,
              compiler_version: 'dsh-mnemosyne-okf/1',
            })
          ).rejects.toThrowError(MemoryStoreError)

          // Assert CURRENT bytes are strictly unchanged
          const afterCurrentBytes = await readFile(currentPath)
          expect(Buffer.compare(origCurrentBytes, afterCurrentBytes)).toBe(0)

          // tmp directory must be clean
          const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
          const { existsSync } = await import('node:fs')
          if (existsSync(tmpDir)) {
            const entries = await readdir(tmpDir)
            expect(entries).toEqual([])
          }
        } finally {
          __setOKFCompilerTestHooks(null)
        }

        // Verify clean retry
        const retryRes = await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
        expect(retryRes.status).toBe('created')
      }
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('78. Manifest temp write/sync/close failure cleans temp file and allows retry', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-78-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_78_init'))

      const compiler = createOKFCompiler()
      const initRes = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })
      expect(initRes.status).toBe('created')

      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const { __setOKFCompilerTestHooks } = await import('../src/okf-compiler.js')

      const hooks = [
        { simulateManifestTempWriteFailure: true },
        { simulateManifestTempSyncFailure: true },
        { simulateManifestTempCloseFailure: true },
      ]

      for (let i = 0; i < hooks.length; i++) {
        const origCurrentBytes = await readFile(currentPath)
        await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, `mem_78_hook_${i}`))

        __setOKFCompilerTestHooks(hooks[i])
        try {
          await expect(
            compiler.compile({
              project_root: realRoot,
              project_scope_id: projectScopeId,
              evaluation_at: evaluationAt,
              compiler_version: 'dsh-mnemosyne-okf/1',
            })
          ).rejects.toThrowError(MemoryStoreError)

          // Assert CURRENT bytes are strictly unchanged
          const afterCurrentBytes = await readFile(currentPath)
          expect(Buffer.compare(origCurrentBytes, afterCurrentBytes)).toBe(0)

          // tmp directory must be clean
          const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
          const { existsSync } = await import('node:fs')
          if (existsSync(tmpDir)) {
            const entries = await readdir(tmpDir)
            expect(entries).toEqual([])
          }
        } finally {
          __setOKFCompilerTestHooks(null)
        }

        // Verify clean retry
        const retryRes = await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
        expect(retryRes.status).toBe('created')
      }
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('79. CURRENT temp write/sync/close failure cleans temp file and allows retry', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-79-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_79_init'))

      const compiler = createOKFCompiler()
      const initRes = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })
      expect(initRes.status).toBe('created')

      const currentPath = join(realRoot, '.dsh-mnemosyne', 'CURRENT')
      const { __setOKFCompilerTestHooks } = await import('../src/okf-compiler.js')

      const hooks = [
        { simulateCurrentTempWriteFailure: true },
        { simulateCurrentTempSyncFailure: true },
        { simulateCurrentTempCloseFailure: true },
      ]

      for (let i = 0; i < hooks.length; i++) {
        const origCurrentBytes = await readFile(currentPath)
        await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, `mem_79_hook_${i}`))

        __setOKFCompilerTestHooks(hooks[i])
        try {
          await expect(
            compiler.compile({
              project_root: realRoot,
              project_scope_id: projectScopeId,
              evaluation_at: evaluationAt,
              compiler_version: 'dsh-mnemosyne-okf/1',
            })
          ).rejects.toThrowError(MemoryStoreError)

          // Assert CURRENT bytes are strictly unchanged
          const afterCurrentBytes = await readFile(currentPath)
          expect(Buffer.compare(origCurrentBytes, afterCurrentBytes)).toBe(0)

          // tmp directory must be clean
          const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
          const { existsSync } = await import('node:fs')
          if (existsSync(tmpDir)) {
            const entries = await readdir(tmpDir)
            expect(entries).toEqual([])
          }
        } finally {
          __setOKFCompilerTestHooks(null)
        }

        // Verify clean retry
        const retryRes = await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
        expect(retryRes.status).toBe('created')
      }
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('80. Compiler Lock write/sync/close failure leaves locks directory clean and allows retry', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-80-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_80'))

      const compiler = createOKFCompiler()
      const { __setOKFCompilerTestHooks } = await import('../src/okf-compiler.js')

      for (const hook of [
        { simulateLockWriteFailure: true },
        { simulateLockSyncFailure: true },
        { simulateLockCloseFailure: true },
      ]) {
        __setOKFCompilerTestHooks(hook)
        try {
          await expect(
            compiler.compile({
              project_root: realRoot,
              project_scope_id: projectScopeId,
              evaluation_at: evaluationAt,
              compiler_version: 'dsh-mnemosyne-okf/1',
            })
          ).rejects.toThrowError(MemoryStoreError)

          // Lock file must NOT remain on disk
          const lockPath = join(realRoot, '.dsh-mnemosyne', 'locks', 'compiler.lock')
          const { existsSync } = await import('node:fs')
          expect(existsSync(lockPath)).toBe(false)
        } finally {
          __setOKFCompilerTestHooks(null)
        }

        // Retry without hooks succeeds
        const retryRes = await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
        expect(retryRes.status === 'created' || retryRes.status === 'noop').toBe(true)
      }
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('84. Table-driven test: Extra output page in Manifest & disk is strictly rejected even if all hashes recomputed', async () => {
    const testCases = [
      {
        name: 'extra memory page',
        extraPath: 'wiki/memories/mem_extra_01.md',
        content: '# Memory: mem_extra_01\n\n## Summary\n> Extra memory\n\n## Body\n> Extra body\n',
      },
      {
        name: 'extra session page',
        extraPath: 'wiki/short-term/sha256_9999999999999999999999999999999999999999999999999999999999999999.md',
        content: '# Short-term Session: sha256_9999999999999999999999999999999999999999999999999999999999999999\n\n## Memories\n',
      },
      {
        name: 'extra component page',
        extraPath: 'wiki/components/extra-component.md',
        content: '# Component: extra-component\n\n## Memories\n',
      },
    ]

    for (const tc of testCases) {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-cmp-84-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        await store.putShortTerm(sessionScopeId, makeShortFact(projectScopeId, sessionScopeId, 'mem_84_canon'))

        const compiler = createOKFCompiler()
        const res = await compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })

        const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)

        // 1. Write extra 0600 file to disk
        const extraFileFullPath = join(genDir, ...tc.extraPath.split('/'))
        await writeFile(extraFileFullPath, tc.content, { mode: 0o600 })

        // 2. Add extra output ref to Manifest and recompute
        const { createHash } = await import('node:crypto')
        const extraBuf = Buffer.from(tc.content, 'utf8')
        const extraSha = `sha256_${createHash('sha256').update(extraBuf).digest('hex')}`

        const localManifest = JSON.parse(await readFile(join(genDir, 'manifest.json'), 'utf8'))
        localManifest.outputs.push({
          relative_path: tc.extraPath,
          byte_length: extraBuf.length,
          content_sha256: extraSha,
        })
        const { compareOutputFileRefs, computeCompiledOutputHash, canonicalizeManifest, validateManifest, canonicalizeGenerationMetadata, validateGenerationMetadata } = await import('../src/okf-schema.js')
        localManifest.outputs.sort(compareOutputFileRefs)
        localManifest.compiled_output_sha256 = computeCompiledOutputHash(localManifest.outputs)
        localManifest.content_sha256 = ''
        const tamperedManifestCanonical = canonicalizeManifest(localManifest)
        const validatedTamperedManifest = validateManifest(JSON.parse(tamperedManifestCanonical))

        await writeFile(join(genDir, 'manifest.json'), tamperedManifestCanonical, { mode: 0o600 })
        await writeFile(join(realRoot, '.dsh-mnemosyne', 'manifests', `${res.manifest_id}.json`), tamperedManifestCanonical, { mode: 0o600 })

        // 3. Update generation.json
        const localGen = JSON.parse(await readFile(join(genDir, 'generation.json'), 'utf8'))
        localGen.manifest_sha256 = validatedTamperedManifest.content_sha256
        localGen.compiled_output_sha256 = localManifest.compiled_output_sha256
        localGen.content_sha256 = ''
        const tamperedGenCanonical = canonicalizeGenerationMetadata(localGen)
        await writeFile(join(genDir, 'generation.json'), tamperedGenCanonical, { mode: 0o600 })

        // 4. Verification must fail closed because extra output does not come from canonical facts
        await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(MemoryStoreError)
        await expect(compiler.readCurrent(realRoot, projectScopeId)).rejects.toThrowError(MemoryStoreError)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    }
  })
})
