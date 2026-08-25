import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { openMemoryFactStore, __setMemoryStoreTestHooks } from '../src/memory-store.js'
import {
  canonicalizeShortTermMemoryFact,
  computeFactHash,
  type ShortTermMemoryFact,
} from '../src/memory-fact.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'

describe('MVP-02B: File Security & Permissions Matrix (Tests 27-38)', () => {
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

  function makeSampleFact(projectScopeId: string, id: string): ShortTermMemoryFact {
    const f: ShortTermMemoryFact = {
      schema_version: 1,
      tier: 'short_term',
      memory_id: id,
      project_scope_id: projectScopeId,
      session_scope_id: sessionScopeId,
      title: 'Security test finding',
      summary: 'Permissions and symlink validation',
      body: 'Verified that insecure permissions and symlinks are rejected.',
      tags: ['security'],
      created_at: '2026-08-24T12:00:00.000Z',
      expires_at: '2026-08-31T12:00:00.000Z',
      content_sha256: '',
    }
    f.content_sha256 = computeFactHash(f)
    return f
  }

  it('27. New directories created with 0700, new Fact files created with 0600', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-27-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_27')
      const res = await store.putShortTerm(sessionScopeId, fact)
      expect(res.status).toBe('created')

      // Check stat mode
      const { stat } = await import('node:fs/promises')
      const storeDirStat = await stat(join(realRoot, '.dsh-mnemosyne'))
      expect(storeDirStat.mode & 0o777).toBe(0o700)

      const fileStat = await stat(join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_27.json'))
      expect(fileStat.mode & 0o777).toBe(0o600)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('28. Existing store/tier/session directory with overly permissive mode is rejected without auto-chmod', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-28-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const storeDir = join(realRoot, '.dsh-mnemosyne')
      await mkdir(storeDir, { mode: 0o755 })
      await chmod(storeDir, 0o755)

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_28')
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)

      // Ensure mode was not silently changed
      const { stat } = await import('node:fs/promises')
      const s = await stat(storeDir)
      expect(s.mode & 0o777).toBe(0o755)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('29. Existing fact file with overly permissive mode is rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-29-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_29')
      await store.putShortTerm(sessionScopeId, fact)

      const filePath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_29.json')
      await chmod(filePath, 0o644)

      await expect(store.getShortTerm(sessionScopeId, 'mem_sec_29')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('30. Project root or any store ancestor/target being a symlink is rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-30-'))
    const symlinkRoot = join(tempDir, 'symlinked-project-root')
    const realTarget = join(tempDir, 'real-target')
    try {
      await mkdir(realTarget, { mode: 0o700 })
      await symlink(realTarget, symlinkRoot)

      const projectScopeId = computeProjectScopeId(realTarget)
      const store = openMemoryFactStore({ project_root: symlinkRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_30')
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      await expect(store.getShortTerm(sessionScopeId, 'mem_sec_30')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('30a. Fact file replaced with symlink to identical content external file is rejected with memory_store_symlink_rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-30a-'))
    const externalDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-30a-ext-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sym_identical')
      const canonical = canonicalizeShortTermMemoryFact(fact)

      // External file with identical valid content
      const externalFile = join(externalDir, 'external_fact.json')
      await writeFile(externalFile, canonical, { mode: 0o600 })

      // Create session dir in store and symlink to external file
      const sessionDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId)
      await mkdir(sessionDir, { recursive: true, mode: 0o700 })
      const symlinkTarget = join(sessionDir, 'mem_sym_identical.json')
      await symlink(externalFile, symlinkTarget)

      // Both get and list must reject symlink with memory_store_symlink_rejected (not hash error)
      try {
        await store.getShortTerm(sessionScopeId, 'mem_sym_identical')
        expect.unreachable('should reject symlink file')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MemoryStoreError)
        expect((err as MemoryStoreError).code).toBe('memory_store_symlink_rejected')
      }

      try {
        await store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')
        expect.unreachable('list should fail closed on symlink')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MemoryStoreError)
        expect((err as MemoryStoreError).code).toBe('memory_store_symlink_rejected')
      }

      // External file must remain completely unmodified
      expect(await readFile(externalFile, 'utf8')).toBe(canonical)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('31. Deep symlink pointing to external directory produces zero external writes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-31-'))
    const externalDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-external-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const factsDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term')
      await mkdir(factsDir, { recursive: true, mode: 0o700 })
      await symlink(externalDir, join(factsDir, sessionScopeId))

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_31')
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)

      expect(await readdir(externalDir)).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('32. Non-directory component in store path hierarchy is rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-32-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const blockerFile = join(realRoot, '.dsh-mnemosyne')
      await writeFile(blockerFile, 'not-a-directory', { mode: 0o600 })

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_32')
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('33. Path traversal, NUL, and separator characters in memory_id are rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-33-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await expect(store.getShortTerm(sessionScopeId, '../escaped' as never)).rejects.toThrowError(MemoryStoreError)
      await expect(store.getShortTerm(sessionScopeId, 'mem_test\0null' as never)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('34. Corrupted JSON, truncated bytes, or non-canonical bytes fail closed without overwriting', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-34-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_34')
      await store.putShortTerm(sessionScopeId, fact)

      const filePath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_34.json')
      await writeFile(filePath, '{"corrupt_json": true', { mode: 0o600 })

      await expect(store.getShortTerm(sessionScopeId, 'mem_sec_34')).rejects.toThrowError(MemoryStoreError)

      // A new put with valid content should fail closed and not overwrite the corrupt target
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)

      expect(await readFile(filePath, 'utf8')).toBe('{"corrupt_json": true')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('34a. Non-canonical formats on disk (trailing newline, trailing whitespace, pretty JSON, reversed keys, extra whitespace, invalid UTF-8) are rejected with memory_store_noncanonical or memory_store_decode_failed in get and list, and put refuses to overwrite', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-34a-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_noncanon')
      const sessionDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId)
      await mkdir(sessionDir, { recursive: true, mode: 0o700 })

      const targetPath = join(sessionDir, 'mem_noncanon.json')
      const canonical = canonicalizeShortTermMemoryFact(fact)

      // Case 1: Trailing newline
      await writeFile(targetPath, canonical + '\n', { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      expect(await readFile(targetPath, 'utf8')).toBe(canonical + '\n')

      // Case 2: Trailing whitespace
      await writeFile(targetPath, canonical + ' ', { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      expect(await readFile(targetPath, 'utf8')).toBe(canonical + ' ')

      // Case 3: Pretty JSON (with indentation)
      const pretty = JSON.stringify(fact, null, 2)
      await writeFile(targetPath, pretty, { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      expect(await readFile(targetPath, 'utf8')).toBe(pretty)

      // Case 4: Keys in reversed order
      const reversedObject: Record<string, unknown> = {}
      for (const k of Object.keys(fact).reverse()) {
        reversedObject[k] = (fact as unknown as Record<string, unknown>)[k]
      }
      const reversedJson = JSON.stringify(reversedObject)
      await writeFile(targetPath, reversedJson, { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      expect(await readFile(targetPath, 'utf8')).toBe(reversedJson)

      // Case 5: Spaces after separators
      const spacedJson = JSON.stringify(fact, null, 1)
      await writeFile(targetPath, spacedJson, { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_noncanonical' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      expect(await readFile(targetPath, 'utf8')).toBe(spacedJson)

      // Case 6: Invalid UTF-8 bytes
      await writeFile(targetPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 })
      await expect(store.getShortTerm(sessionScopeId, 'mem_noncanon')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_decode_failed' })
      )
      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_store_decode_failed' })
      )
      await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('35. Files exceeding 64 KiB (65536 bytes) are rejected on read', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-35-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const sessionDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId)
      await mkdir(sessionDir, { recursive: true, mode: 0o700 })

      const oversizedFile = join(sessionDir, 'mem_oversized.json')
      await writeFile(oversizedFile, ' '.repeat(65537), { mode: 0o600 })

      await expect(store.getShortTerm(sessionScopeId, 'mem_oversized')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('36. Unknown files, directories, or symlinks mixed into fact listing fail closed', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-36-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_36')
      await store.putShortTerm(sessionScopeId, fact)

      const sessionDir = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId)
      await writeFile(join(sessionDir, 'unknown_intruder.txt'), 'rogue', { mode: 0o600 })

      await expect(store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('37. Failed publication (injected link failure) cleans temp, leaves no visible fact file, zero external write', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37-'))
    const externalSentinelDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37-sentinel-'))
    try {
      const realRoot = await realpath(tempDir)
      const sentinelFile = join(externalSentinelDir, 'sentinel.txt')
      await writeFile(sentinelFile, 'sentinel_bytes_12345', { mode: 0o600 })

      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_37')
      const targetPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_37.json')

      // Inject link failure
      __setMemoryStoreTestHooks({ simulateLinkFailure: true })
      try {
        await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      } finally {
        __setMemoryStoreTestHooks(null)
      }

      const { existsSync } = await import('node:fs')
      expect(existsSync(targetPath)).toBe(false)

      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      const tmpEntries = await readdir(tmpDir)
      expect(tmpEntries).toEqual([])

      // External sentinel directory must be byte-for-byte untouched
      expect(await readdir(externalSentinelDir)).toEqual(['sentinel.txt'])
      expect(await readFile(sentinelFile, 'utf8')).toBe('sentinel_bytes_12345')
    } finally {
      __setMemoryStoreTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalSentinelDir, { recursive: true, force: true })
    }
  })

  it('37a. Read-back verification failure on publish fails loud with target intact and tmp clean', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37a-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_37a')
      const targetPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_37a.json')

      __setMemoryStoreTestHooks({ simulateReadbackFailure: true })
      try {
        await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(MemoryStoreError)
      } finally {
        __setMemoryStoreTestHooks(null)
      }

      // Target file exists and has correct canonical content
      expect(await readFile(targetPath, 'utf8')).toBe(canonicalizeShortTermMemoryFact(fact))

      // Temp directory has zero leftover files
      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      expect(await readdir(tmpDir)).toEqual([])

      // Clear seam and retry: must return noop without creating second fact or mutating bytes
      const res = await store.putShortTerm(sessionScopeId, fact)
      expect(res.status).toBe('noop')
      expect(res.memory_id).toBe('mem_sec_37a')
      expect(await readFile(targetPath, 'utf8')).toBe(canonicalizeShortTermMemoryFact(fact))
    } finally {
      __setMemoryStoreTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('37b. Target parent directory fsync failure fails loud, cleans temp, leaves target intact, retry returns noop', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37b-'))
    const externalSentinelDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37b-sentinel-'))
    try {
      const realRoot = await realpath(tempDir)
      const sentinelFile = join(externalSentinelDir, 'sentinel.txt')
      await writeFile(sentinelFile, 'sentinel_37b_content', { mode: 0o600 })

      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_37b')
      const targetPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_37b.json')

      __setMemoryStoreTestHooks({ simulateTargetParentFsyncFailure: true })
      try {
        await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(
          expect.objectContaining({ code: 'memory_store_io_failed' })
        )
      } finally {
        __setMemoryStoreTestHooks(null)
      }

      // Target was already linked on disk
      expect(await readFile(targetPath, 'utf8')).toBe(canonicalizeShortTermMemoryFact(fact))

      // Temp file was cleaned up
      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      expect(await readdir(tmpDir)).toEqual([])

      // External sentinel directory is untouched
      expect(await readdir(externalSentinelDir)).toEqual(['sentinel.txt'])
      expect(await readFile(sentinelFile, 'utf8')).toBe('sentinel_37b_content')

      // Clear seam and retry: must return noop
      const retryRes = await store.putShortTerm(sessionScopeId, fact)
      expect(retryRes.status).toBe('noop')
      expect(retryRes.memory_id).toBe('mem_sec_37b')
      expect(await readFile(targetPath, 'utf8')).toBe(canonicalizeShortTermMemoryFact(fact))
    } finally {
      __setMemoryStoreTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalSentinelDir, { recursive: true, force: true })
    }
  })

  it('37c. Pre-link temp fsync failure cleans temp and leaves target absent, retry creates fact', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37c-'))
    const externalSentinelDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-37c-sentinel-'))
    try {
      const realRoot = await realpath(tempDir)
      const sentinelFile = join(externalSentinelDir, 'sentinel.txt')
      await writeFile(sentinelFile, 'sentinel_37c_content', { mode: 0o600 })

      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_37c')
      const targetPath = join(realRoot, '.dsh-mnemosyne', 'facts', 'short-term', sessionScopeId, 'mem_sec_37c.json')

      // Inject temp file fsync failure before link
      __setMemoryStoreTestHooks({ simulateTempFileFsyncFailure: true })
      try {
        await expect(store.putShortTerm(sessionScopeId, fact)).rejects.toThrowError(
          expect.objectContaining({ code: 'memory_store_io_failed' })
        )
      } finally {
        __setMemoryStoreTestHooks(null)
      }

      // Target must NOT exist
      const { existsSync } = await import('node:fs')
      expect(existsSync(targetPath)).toBe(false)

      // Temp directory must be clean (no residue)
      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      expect(await readdir(tmpDir)).toEqual([])

      // External sentinel directory must be untouched
      expect(await readdir(externalSentinelDir)).toEqual(['sentinel.txt'])
      expect(await readFile(sentinelFile, 'utf8')).toBe('sentinel_37c_content')

      // Clear seam and retry: must succeed with created
      const retryRes = await store.putShortTerm(sessionScopeId, fact)
      expect(retryRes.status).toBe('created')
      expect(retryRes.memory_id).toBe('mem_sec_37c')
      expect(await readFile(targetPath, 'utf8')).toBe(canonicalizeShortTermMemoryFact(fact))
    } finally {
      __setMemoryStoreTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalSentinelDir, { recursive: true, force: true })
    }
  })

  it('38. Temporary files in .dsh-mnemosyne/tmp do not enter list results', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sec-38-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      const fact = makeSampleFact(projectScopeId, 'mem_sec_38')
      await store.putShortTerm(sessionScopeId, fact)

      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      await writeFile(join(tmpDir, 'orphaned.tmp'), 'junk', { mode: 0o600 })

      const list = await store.listShortTerm(sessionScopeId, '2026-08-25T00:00:00.000Z')
      expect(list.length).toBe(1)
      expect(list[0].memory_id).toBe('mem_sec_38')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
