import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import {
  computeFactHash,
  type ShortTermMemoryFact,
  type LongTermMemoryFact,
} from '../src/memory-fact.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'

describe('MVP-02C: Fact Store Operations & Expiration Matrix (Tests 11-26)', () => {
  const sessionScopeId1 = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
  const sessionScopeId2 = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'

  function makeShortTerm(projectScopeId: string, id: string, overrides: Partial<ShortTermMemoryFact> = {}): ShortTermMemoryFact {
    const f: ShortTermMemoryFact = {
      schema_version: 1,
      tier: 'short_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      session_scope_id: sessionScopeId1,
      title: 'Short term title',
      summary: 'Short term summary',
      body: 'Short term body text',
      tags: ['test'],
      created_at: '2026-08-24T12:00:00.000Z',
      expires_at: '2026-08-31T12:00:00.000Z',
      content_sha256: '',
      ...overrides,
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  function makeLongTerm(projectScopeId: string, id: string, overrides: Partial<LongTermMemoryFact> = {}): LongTermMemoryFact {
    const f: LongTermMemoryFact = {
      schema_version: 1,
      tier: 'long_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      title: 'Long term title',
      summary: 'Long term summary',
      body: 'Long term body text',
      tags: ['test'],
      created_at: '2026-08-24T12:00:00.000Z',
      source_short_term_refs: [],
      content_sha256: '',
      ...overrides,
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  it('11. short and long Put/Get/List work seamlessly', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-11-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const st = makeShortTerm(projectScopeId, 'mem_st_1')
      const lt = makeLongTerm(projectScopeId, 'mem_lt_1')

      const resSt = await store.putShortTerm(sessionScopeId1, st)
      expect(resSt.status).toBe('created')

      const resLt = await store.putLongTerm(lt)
      expect(resLt.status).toBe('created')

      const getSt = await store.getShortTerm(sessionScopeId1, 'mem_st_1')
      expect(getSt).toEqual(st)

      const getLt = await store.getLongTerm('mem_lt_1')
      expect(getLt).toEqual(lt)

      const listSt = await store.listShortTerm(sessionScopeId1, '2026-08-25T00:00:00.000Z')
      expect(listSt).toEqual([st])

      const listLt = await store.listLongTerm()
      expect(listLt).toEqual([lt])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('12. Second Put of identical Fact returns noop without updating file mtime or bytes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-12-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const st = makeShortTerm(projectScopeId, 'mem_noop')
      const res1 = await store.putShortTerm(sessionScopeId1, st)
      expect(res1.status).toBe('created')

      const filePath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId1, 'mem_noop.json')
      const stat1 = await stat(filePath)

      const res2 = await store.putShortTerm(sessionScopeId1, st)
      expect(res2.status).toBe('noop')

      const stat2 = await stat(filePath)
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs)
      expect(stat2.size).toBe(stat1.size)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('13. Same identity with different content produces conflict without modifying original bytes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-13-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const stOriginal = makeShortTerm(projectScopeId, 'mem_conflict', { summary: 'Original summary' })
      await store.putShortTerm(sessionScopeId1, stOriginal)

      const stModified = makeShortTerm(projectScopeId, 'mem_conflict', { summary: 'Different summary' })
      await expect(store.putShortTerm(sessionScopeId1, stModified)).rejects.toThrowError(MemoryStoreError)

      const fetched = await store.getShortTerm(sessionScopeId1, 'mem_conflict')
      expect(fetched.summary).toBe('Original summary')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('14. Project Scope mismatch (wrong project_scope_id for project_root) is rejected with zero writes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-14-'))
    try {
      const realRoot = await realpath(tempDir)
      const forgedProjectScopeId = 'sha256_0000000000000000000000000000000000000000000000000000000000000000'
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: forgedProjectScopeId })
      const fact = makeShortTerm(forgedProjectScopeId, 'mem_mismatch_proj')

      await expect(store.putShortTerm(sessionScopeId1, fact)).rejects.toThrowError(MemoryStoreError)
      await expect(store.getShortTerm(sessionScopeId1, 'mem_mismatch_proj')).rejects.toThrowError(MemoryStoreError)

      // Zero writes
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(realRoot, '.dsh-mnemosyne'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('15. Session Scope mismatch (call sessionScopeId vs fact session_scope_id) is rejected with zero writes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-15-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      // Fact says session 1, but call passes session 2
      const factSession1 = makeShortTerm(projectScopeId, 'mem_mismatch_sess', { session_scope_id: sessionScopeId1 })
      await expect(store.putShortTerm(sessionScopeId2, factSession1)).rejects.toThrowError(MemoryStoreError)

      // Put to session 1
      await store.putShortTerm(sessionScopeId1, factSession1)

      // Querying session 2 for session 1's fact throws not found
      await expect(store.getShortTerm(sessionScopeId2, 'mem_mismatch_sess')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('15a. LongTerm fact with cross-project source ref is rejected with zero writes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-15a-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const foreignProjectScopeId = 'sha256_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })

      const longTermForeignRef = makeLongTerm(projectScopeId, 'mem_foreign_ref', {
        source_short_term_refs: [
          {
            project_scope_id: foreignProjectScopeId,
            session_scope_id: sessionScopeId1,
            memory_id: 'mem_ref_1',
            content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
          },
        ],
      })

      await expect(store.putLongTerm(longTermForeignRef)).rejects.toThrowError(MemoryStoreError)

      const { existsSync } = await import('node:fs')
      expect(existsSync(join(realRoot, '.dsh-mnemosyne'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('16. Two Project Stores are completely isolated', async () => {
    const tempDirA = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-16a-'))
    const tempDirB = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-16b-'))
    try {
      const realRootA = await realpath(tempDirA)
      const realRootB = await realpath(tempDirB)
      const projectScopeIdA = computeProjectScopeId(realRootA)
      const projectScopeIdB = computeProjectScopeId(realRootB)

      const storeA = openMemoryFactStore({ project_root: realRootA, project_scope_id: projectScopeIdA })
      const storeB = openMemoryFactStore({ project_root: realRootB, project_scope_id: projectScopeIdB })

      const factA = makeShortTerm(projectScopeIdA, 'mem_iso_proj', { project_scope_id: projectScopeIdA })
      const factB = makeShortTerm(projectScopeIdB, 'mem_iso_proj', { project_scope_id: projectScopeIdB, summary: 'Store B summary' })

      await storeA.putShortTerm(sessionScopeId1, factA)
      await storeB.putShortTerm(sessionScopeId1, factB)

      expect((await storeA.getShortTerm(sessionScopeId1, 'mem_iso_proj')).summary).toBe('Short term summary')
      expect((await storeB.getShortTerm(sessionScopeId1, 'mem_iso_proj')).summary).toBe('Store B summary')
    } finally {
      await rm(tempDirA, { recursive: true, force: true })
      await rm(tempDirB, { recursive: true, force: true })
    }
  })

  it('17. Two Sessions in the same Project are completely isolated', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-17-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const factS1 = makeShortTerm(projectScopeId, 'mem_same_id', { session_scope_id: sessionScopeId1, summary: 'S1' })
      const factS2 = makeShortTerm(projectScopeId, 'mem_same_id', { session_scope_id: sessionScopeId2, summary: 'S2' })

      await store.putShortTerm(sessionScopeId1, factS1)
      await store.putShortTerm(sessionScopeId2, factS2)

      expect((await store.getShortTerm(sessionScopeId1, 'mem_same_id')).summary).toBe('S1')
      expect((await store.getShortTerm(sessionScopeId2, 'mem_same_id')).summary).toBe('S2')

      const listS1 = await store.listShortTerm(sessionScopeId1, '2026-08-25T00:00:00.000Z')
      const listS2 = await store.listShortTerm(sessionScopeId2, '2026-08-25T00:00:00.000Z')
      expect(listS1.length).toBe(1)
      expect(listS2.length).toBe(1)
      expect(listS1[0].summary).toBe('S1')
      expect(listS2[0].summary).toBe('S2')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('18. short and long tier with identical memory_id do not collide', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-18-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const st = makeShortTerm(projectScopeId, 'mem_shared_id', { title: 'Short Tier' })
      const lt = makeLongTerm(projectScopeId, 'mem_shared_id', { title: 'Long Tier' })

      await store.putShortTerm(sessionScopeId1, st)
      await store.putLongTerm(lt)

      expect((await store.getShortTerm(sessionScopeId1, 'mem_shared_id')).title).toBe('Short Tier')
      expect((await store.getLongTerm('mem_shared_id')).title).toBe('Long Tier')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('19. Store re-opening reads identical facts byte-for-byte; wrong scope rejected on re-open', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-19-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store1 = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeShortTerm(projectScopeId, 'mem_reopen')
      await store1.putShortTerm(sessionScopeId1, fact)

      // Re-open fresh instance with valid project scope
      const store2 = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const retrieved = await store2.getShortTerm(sessionScopeId1, 'mem_reopen')
      expect(retrieved).toEqual(fact)

      // Re-open with wrong project scope
      const storeWrong = openMemoryFactStore({
        project_root: realRoot,
        project_scope_id: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
      })
      await expect(storeWrong.getShortTerm(sessionScopeId1, 'mem_reopen')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('20. Returned fact mutation by caller does not affect subsequent store reads', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-20-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeShortTerm(projectScopeId, 'mem_mutate')
      await store.putShortTerm(sessionScopeId1, fact)

      const fetched1 = await store.getShortTerm(sessionScopeId1, 'mem_mutate')
      ;(fetched1 as unknown as Record<string, unknown>).title = 'MUTATED TITLE'

      const fetched2 = await store.getShortTerm(sessionScopeId1, 'mem_mutate')
      expect(fetched2.title).toBe('Short term title')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('20a. When store does not exist, get/list perform zero writes, get returns not-found, list returns empty', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-20a-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await expect(store.getShortTerm(sessionScopeId1, 'mem_nonexistent')).rejects.toThrowError(MemoryStoreError)
      await expect(store.getLongTerm('mem_nonexistent')).rejects.toThrowError(MemoryStoreError)

      const listSt = await store.listShortTerm(sessionScopeId1, '2026-08-25T00:00:00.000Z')
      expect(listSt).toEqual([])

      const listLt = await store.listLongTerm()
      expect(listLt).toEqual([])

      // Zero files written
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(realRoot, '.dsh-mnemosyne'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  // 11.3 过期与确定性
  describe('11.3 过期与确定性', () => {
    it('21. now < expires_at appears in default list', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-21-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        const fact = makeShortTerm(projectScopeId, 'mem_exp_21', {
          created_at: '2026-08-24T12:00:00.000Z',
          expires_at: '2026-08-31T12:00:00.000Z',
        })
        await store.putShortTerm(sessionScopeId1, fact)

        const list = await store.listShortTerm(sessionScopeId1, '2026-08-25T00:00:00.000Z')
        expect(list.length).toBe(1)
        expect(list[0].memory_id).toBe('mem_exp_21')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('22. now == expires_at and now > expires_at are excluded from default list', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-22-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        const fact = makeShortTerm(projectScopeId, 'mem_exp_22', {
          created_at: '2026-08-24T12:00:00.000Z',
          expires_at: '2026-08-31T12:00:00.000Z',
        })
        await store.putShortTerm(sessionScopeId1, fact)

        const listExact = await store.listShortTerm(sessionScopeId1, '2026-08-31T12:00:00.000Z')
        expect(listExact).toEqual([])

        const listAfter = await store.listShortTerm(sessionScopeId1, '2026-09-01T00:00:00.000Z')
        expect(listAfter).toEqual([])
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('23. includeExpired=true returns expired facts', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-23-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        const fact = makeShortTerm(projectScopeId, 'mem_exp_23', {
          created_at: '2026-08-24T12:00:00.000Z',
          expires_at: '2026-08-31T12:00:00.000Z',
        })
        await store.putShortTerm(sessionScopeId1, fact)

        const list = await store.listShortTerm(sessionScopeId1, '2026-09-01T00:00:00.000Z', { includeExpired: true })
        expect(list.length).toBe(1)
        expect(list[0].memory_id).toBe('mem_exp_23')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('24. Invalid or missing now timestamp is rejected', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-24-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        await expect(store.listShortTerm(sessionScopeId1, '' as never)).rejects.toThrowError(MemoryStoreError)
        await expect(store.listShortTerm(sessionScopeId1, 'invalid-date' as never)).rejects.toThrowError(MemoryStoreError)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('25. Result is completely independent of system wall-clock time', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-25-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        const fact = makeShortTerm(projectScopeId, 'mem_exp_25', {
          created_at: '2020-01-01T00:00:00.000Z',
          expires_at: '2020-01-10T00:00:00.000Z',
        })
        await store.putShortTerm(sessionScopeId1, fact)

        // Historical query
        const listOld = await store.listShortTerm(sessionScopeId1, '2020-01-05T00:00:00.000Z')
        expect(listOld.length).toBe(1)

        const listExpired = await store.listShortTerm(sessionScopeId1, '2020-01-15T00:00:00.000Z')
        expect(listExpired.length).toBe(0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('26. Lists are deterministically sorted by memory_id code point order', async () => {
      const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-store-26-'))
      try {
        const realRoot = await realpath(tempDir)
        const projectScopeId = computeProjectScopeId(realRoot)
        const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
        await store.putShortTerm(sessionScopeId1, makeShortTerm(projectScopeId, 'mem_z'))
        await store.putShortTerm(sessionScopeId1, makeShortTerm(projectScopeId, 'mem_a'))
        await store.putShortTerm(sessionScopeId1, makeShortTerm(projectScopeId, 'mem_m'))

        const list = await store.listShortTerm(sessionScopeId1, '2026-08-25T00:00:00.000Z')
        expect(list.map((f) => f.memory_id)).toEqual(['mem_a', 'mem_m', 'mem_z'])
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})
