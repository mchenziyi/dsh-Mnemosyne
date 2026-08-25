import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { computeFactHash, type ShortTermMemoryFact } from '../src/memory-fact.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'

const execFileAsync = promisify(execFile)

describe('MVP-02D: Concurrency Matrix (Tests 39-42)', () => {
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  const workerPath = new URL('./helpers/concurrency-worker.mjs', import.meta.url).pathname

  function makeFact(projectScopeId: string, id: string, summary = 'Concurrent test summary'): ShortTermMemoryFact {
    const f: ShortTermMemoryFact = {
      schema_version: 1,
      tier: 'short_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      session_scope_id: sessionScopeId,
      title: 'Concurrency finding',
      summary,
      body: 'Verified that Promise and multi-process atomic publication holds.',
      tags: ['concurrency'],
      created_at: '2026-08-24T12:00:00.000Z',
      expires_at: '2026-08-31T12:00:00.000Z',
      content_sha256: '',
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  it('39. 16 concurrent Promises writing identical content: exactly 1 created, 15 noop', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-conc-39-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeFact(projectScopeId, 'mem_conc_39')

      const promises = Array.from({ length: 16 }, () => store.putShortTerm(sessionScopeId, fact))
      const results = await Promise.all(promises)

      const createdCount = results.filter((r) => r.status === 'created').length
      const noopCount = results.filter((r) => r.status === 'noop').length

      expect(createdCount).toBe(1)
      expect(noopCount).toBe(15)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('40. 16 concurrent Promises writing conflicting content: exactly 1 created, 15 conflict', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-conc-40-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const promises = Array.from({ length: 16 }, (_, index) => {
        const fact = makeFact(projectScopeId, 'mem_conc_40', `Conflicting summary variant ${index}`)
        return store
          .putShortTerm(sessionScopeId, fact)
          .then((r) => ({ outcome: 'success' as const, status: r.status }))
          .catch((err: unknown) => ({ outcome: 'conflict' as const, code: (err as MemoryStoreError).code }))
      })

      const results = await Promise.all(promises)
      const successCount = results.filter((r) => r.outcome === 'success' && r.status === 'created').length
      const conflictCount = results.filter((r) => r.outcome === 'conflict' && r.code === 'memory_store_identity_conflict').length

      expect(successCount).toBe(1)
      expect(conflictCount).toBe(15)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('41. Multiple independent Node child processes racing identical content: exactly 1 winner, N-1 noop', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-conc-41-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const fact = makeFact(projectScopeId, 'mem_proc_41')
      const factJson = JSON.stringify(fact)

      const procCount = 4
      const promises = Array.from({ length: procCount }, () =>
        execFileAsync(process.execPath, ['--experimental-strip-types', workerPath, realRoot, projectScopeId, sessionScopeId, factJson])
      )

      const results = await Promise.all(promises)
      const parsed = results.map((r) => JSON.parse(r.stdout))

      const createdCount = parsed.filter((r) => r.status === 'created').length
      const noopCount = parsed.filter((r) => r.status === 'noop').length

      expect(createdCount).toBe(1)
      expect(noopCount).toBe(procCount - 1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('42. Multiple independent Node child processes racing conflicting content: exactly 1 winner, N-1 conflict', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-conc-42-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const procCount = 4
      const promises = Array.from({ length: procCount }, (_, index) => {
        const fact = makeFact(projectScopeId, 'mem_proc_42', `Process conflict variant ${index}`)
        const factJson = JSON.stringify(fact)
        return execFileAsync(process.execPath, ['--experimental-strip-types', workerPath, realRoot, projectScopeId, sessionScopeId, factJson])
      })

      const results = await Promise.all(promises)
      const parsed = results.map((r) => JSON.parse(r.stdout))

      const createdCount = parsed.filter((r) => r.status === 'created').length
      const conflictCount = parsed.filter((r) => r.error === 'memory_store_identity_conflict').length

      expect(createdCount).toBe(1)
      expect(conflictCount).toBe(procCount - 1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
