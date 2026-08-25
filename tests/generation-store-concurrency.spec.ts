import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { createOKFCompiler } from '../src/okf-compiler.js'

const execFileAsync = promisify(execFile)

describe('MVP-03E: Concurrency Matrix (Tests 52-53)', () => {
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  const evaluationAt = '2026-08-25T12:00:00.000Z'
  const workerPath = new URL('./helpers/generation-worker.mjs', import.meta.url).pathname

  it('52. 16 concurrent Promises with identical input compile safely into one Generation, with others returning noop/busy and retrying to noop', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gconc-52-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const fact52 = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        memory_id: 'mem_conc_st_52',
        project_scope_id: projectScopeId,
        session_scope_id: sessionScopeId,
        title: 'Concurrent short fact',
        summary: 'Testing promise concurrency',
        body: 'Body of concurrent short fact',
        tags: ['conc'],
        created_at: '2026-08-25T10:00:00.000Z',
        expires_at: '2026-08-30T10:00:00.000Z',
        content_sha256: '',
      }
      fact52.content_sha256 = (await import('../src/memory-fact.js')).computeFactHash(fact52)
      await store.putShortTerm(sessionScopeId, fact52)

      const compiler = createOKFCompiler()
      const req = {
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1' as const,
      }

      const promises = Array.from({ length: 16 }, () =>
        compiler
          .compile(req)
          .then((res) => ({ status: res.status, generation_id: res.generation_id, error: null }))
          .catch((err: MemoryStoreError) => ({ status: 'error', generation_id: null, error: err.code }))
      )

      const results = await Promise.all(promises)
      const createdCount = results.filter((r) => r.status === 'created').length
      expect(createdCount).toBe(1)

      // Retry for all busy/error results
      for (const r of results) {
        if (r.status === 'error' || r.status === 'noop') {
          const retryRes = await compiler.compile(req)
          expect(retryRes.status).toBe('noop')
        }
      }

      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).not.toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('53. 4 independent Node child processes racing identical compilation results in exactly one valid CURRENT and no corrupted state', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gconc-53-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const fact53 = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        memory_id: 'mem_proc_st_53',
        project_scope_id: projectScopeId,
        session_scope_id: sessionScopeId,
        title: 'Concurrent child process fact',
        summary: 'Testing process concurrency',
        body: 'Body of process concurrent short fact',
        tags: ['proc-conc'],
        created_at: '2026-08-25T10:00:00.000Z',
        expires_at: '2026-08-30T10:00:00.000Z',
        content_sha256: '',
      }
      fact53.content_sha256 = (await import('../src/memory-fact.js')).computeFactHash(fact53)
      await store.putShortTerm(sessionScopeId, fact53)

      const procCount = 4
      const promises = Array.from({ length: procCount }, () =>
        execFileAsync(process.execPath, ['--experimental-strip-types', workerPath, realRoot, projectScopeId, evaluationAt])
      )

      const results = await Promise.all(promises)
      const parsed = results.map((r) => JSON.parse(r.stdout))

      const createdCount = parsed.filter((r) => r.status === 'created').length
      expect(createdCount).toBe(1)

      const compiler = createOKFCompiler()
      const current = await compiler.readCurrent(realRoot, projectScopeId)
      expect(current).not.toBeNull()

      const gen = await compiler.verifyGeneration(realRoot, current!.generation_id)
      expect(gen.status).toBe('complete')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
