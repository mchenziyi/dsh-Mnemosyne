import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStoreError } from '../src/memory-store-error.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { createOKFCompiler } from '../src/okf-compiler.js'

describe('MVP-03E: Generation Security, Permissions & Lock Matrix (Tests 44-51, 54-55)', () => {
  const evaluationAt = '2026-08-25T12:00:00.000Z'

  it('44. New directories are created with 0700, new files with 0600', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-44-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const { stat } = await import('node:fs/promises')
      const genDirStat = await stat(join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id))
      expect(genDirStat.mode & 0o777).toBe(0o700)

      const manifestStat = await stat(join(realRoot, '.dsh-mnemosyne', 'manifests', `${res.manifest_id}.json`))
      expect(manifestStat.mode & 0o777).toBe(0o600)

      const currentStat = await stat(join(realRoot, '.dsh-mnemosyne', 'CURRENT'))
      expect(currentStat.mode & 0o777).toBe(0o600)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('45. Any symlink in manifests/generations/locks/tmp hierarchy is rejected with memory_compile_symlink_rejected', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-45-'))
    const externalDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-45-ext-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const storeDir = join(realRoot, '.dsh-mnemosyne')
      await mkdir(storeDir, { mode: 0o700 })

      // Create a symlink for generations dir
      await symlink(externalDir, join(storeDir, 'generations'))

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_symlink_rejected' }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('46. Deep symlink pointing to external directory produces zero external writes', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-46-'))
    const externalDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-46-ext-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const storeDir = join(realRoot, '.dsh-mnemosyne')
      await mkdir(storeDir, { mode: 0o700 })

      // Symlink manifests dir to external directory
      await symlink(externalDir, join(storeDir, 'manifests'))

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)

      const { readdir } = await import('node:fs/promises')
      expect(await readdir(externalDir)).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('47. Overly permissive directory or file permissions are rejected without auto-chmod', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-47-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const storeDir = join(realRoot, '.dsh-mnemosyne')
      await mkdir(storeDir, { mode: 0o755 })
      await chmod(storeDir, 0o755)

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_insecure_permissions' }))

      const { stat } = await import('node:fs/promises')
      const s = await stat(storeDir)
      expect(s.mode & 0o777).toBe(0o755)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('48. Corrupted or unknown files in Generation directory are rejected by verifyGeneration', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-48-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)

      // Add rogue file in generation directory
      await writeFile(join(genDir, 'rogue_file.txt'), 'intruder', { mode: 0o600 })

      await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_compile_generation_incomplete' })
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('49. Compiler Lock with active PID returns memory_compile_busy', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-49-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      const lockContent = JSON.stringify({
        schema_version: 1,
        pid: process.pid, // current running process is definitely alive
        token: 'lock_token_active_01',
      })
      await writeFile(lockPath, lockContent, { mode: 0o600 })

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_busy' }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('50. Compiler Lock with dead PID is safely reclaimed after inode verification', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-50-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      // Choose a PID that is dead (e.g. 9999999)
      const lockContent = JSON.stringify({
        schema_version: 1,
        pid: 9999999,
        token: 'lock_token_dead_01',
      })
      await writeFile(lockPath, lockContent, { mode: 0o600 })

      const compiler = createOKFCompiler()
      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      expect(res.status).toBe('created')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('51. Unparseable or unconfirmed Lock owner fails closed with memory_compile_busy and does not steal lock', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-51-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      // Malformed lock file
      await writeFile(lockPath, 'not-valid-json', { mode: 0o600 })

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_busy' }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })


  it('54. Error path releases own lock and cleans staging directory', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-54-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = (await import('../src/memory-store.js')).openMemoryFactStore({
        project_root: realRoot,
        project_scope_id: projectScopeId,
      })

      const fact = {
        schema_version: 1 as const,
        tier: 'long_term' as const,
        memory_id: 'mem_fail_lock',
        project_scope_id: projectScopeId,
        title: 'Fail title',
        summary: 'Fail summary',
        body: 'Fail body',
        tags: ['component-a', 'component-b'], // multiple components causes compile error
        created_at: '2026-08-25T10:00:00.000Z',
        source_short_term_refs: [],
        content_sha256: '',
      }
      fact.content_sha256 = (await import('../src/memory-fact.js')).computeFactHash(fact)
      await store.putLongTerm(fact)

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)

      // Lock file must be deleted
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(realRoot, '.dsh-mnemosyne', 'locks', 'compiler.lock'))).toBe(false)

      // Tmp directory must have no leftovers
      const { readdir } = await import('node:fs/promises')
      const tmpDir = join(realRoot, '.dsh-mnemosyne', 'tmp')
      if (existsSync(tmpDir)) {
        expect(await readdir(tmpDir)).toEqual([])
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('55. Error messages never echo project root absolute path or fact body text', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-55-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      try {
        await compiler.compile({
          project_root: '/non_existent/secret_path/project',
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
        expect.unreachable('should fail on invalid project root')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MemoryStoreError)
        const msg = (err as Error).message
        expect(msg).not.toContain('/non_existent/secret_path')
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('61. Lock release does NOT delete lock file if it was replaced with different inode/token', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-61-'))
    try {
      const realRoot = await realpath(tempDir)
      const { acquireCompilerLock } = await import('../src/generation-store.js')
      const releaseFirst = await acquireCompilerLock(realRoot)

      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      const lockPath = join(locksDir, 'compiler.lock')
      const newLockTempPath = join(locksDir, 'compiler.lock.replacement.tmp')
      const newLockContent = JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token: 'new_different_token_999',
      })
      // Write to new file and rename to ensure inode really changes
      await writeFile(newLockTempPath, newLockContent, { mode: 0o600 })
      const { rename } = await import('node:fs/promises')
      await rename(newLockTempPath, lockPath)

      // First owner attempts release
      await releaseFirst()

      // The new lock MUST still exist on disk and not have been deleted
      const { existsSync } = await import('node:fs')
      expect(existsSync(lockPath)).toBe(true)
      const afterText = await readFile(lockPath, 'utf8')
      expect(JSON.parse(afterText).token).toBe('new_different_token_999')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('81. Lock file with unknown fields fails closed with memory_compile_busy', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-81-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      // Malformed lock file with unknown field
      await writeFile(lockPath, JSON.stringify({
        schema_version: 1,
        pid: 9999999, // dead pid
        token: 'token_val',
        rogue_field: 'injected',
      }), { mode: 0o600 })

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_busy' }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('82. Lock file exceeding 4096 bytes fails closed with memory_compile_busy', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-82-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      const hugePadding = 'a'.repeat(5000)
      await writeFile(lockPath, hugePadding, { mode: 0o600 })

      const compiler = createOKFCompiler()
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_busy' }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('83. Lock file with non-0600 permissions fails closed with memory_compile_busy or insecure_permissions', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-83-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })

      const lockPath = join(locksDir, 'compiler.lock')
      await writeFile(lockPath, JSON.stringify({ schema_version: 1, pid: 9999999, token: 'token' }), { mode: 0o644 })

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

  it('63. Generation verification strictly rejects rogue empty directory', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-63-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)

      // Add a rogue empty directory
      await mkdir(join(genDir, 'wiki', 'rogue_empty_dir'), { mode: 0o700 })

      await expect(compiler.verifyGeneration(realRoot, res.generation_id)).rejects.toThrowError(
        expect.objectContaining({ code: 'memory_compile_generation_incomplete' })
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('64. Corrupted existing generation.json causes compile to fail closed without overwrite', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-64-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)
      // Corrupt generation.json
      await writeFile(join(genDir, 'generation.json'), '{"corrupted": true}', { mode: 0o600 })

      // Delete CURRENT so compile won't hit oldCurrent noop
      await unlink(join(realRoot, '.dsh-mnemosyne', 'CURRENT'))

      // Re-compile must fail closed with decode/identity error and NOT overwrite
      await expect(
        compiler.compile({
          project_root: realRoot,
          project_scope_id: projectScopeId,
          evaluation_at: evaluationAt,
          compiler_version: 'dsh-mnemosyne-okf/1',
        })
      ).rejects.toThrowError(MemoryStoreError)

      // generation.json must still have the corrupted text, not overwritten
      const currentGenJson = await readFile(join(genDir, 'generation.json'), 'utf8')
      expect(currentGenJson).toBe('{"corrupted": true}')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('62. Lock release with same PID but different token does NOT delete lock', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-62-'))
    try {
      const realRoot = await realpath(tempDir)
      const { acquireCompilerLock } = await import('../src/generation-store.js')
      const releaseFirst = await acquireCompilerLock(realRoot)

      const lockPath = join(realRoot, '.dsh-mnemosyne', 'locks', 'compiler.lock')
      // Simulate lock recreated with same PID but different token
      const modifiedLockContent = JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token: 'token_same_pid_diff_token_888',
      })
      await writeFile(lockPath, modifiedLockContent, { mode: 0o600 })

      await releaseFirst()

      const { existsSync } = await import('node:fs')
      expect(existsSync(lockPath)).toBe(true)
      const afterText = await readFile(lockPath, 'utf8')
      expect(JSON.parse(afterText).token).toBe('token_same_pid_diff_token_888')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('65. Existing generation with 0755 permissions causes compile to fail closed', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-65-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const genDir = join(realRoot, '.dsh-mnemosyne', 'generations', res.generation_id)
      await chmod(genDir, 0o755)

      // Delete CURRENT so compile executes precheck/verification
      await unlink(join(realRoot, '.dsh-mnemosyne', 'CURRENT'))

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

  it('85. Lock file growth before read fails closed and does not delete or steal lock', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-85-'))
    const { __setOKFCompilerTestHooks } = await import('../src/okf-compiler.js')
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)

      const locksDir = join(realRoot, '.dsh-mnemosyne', 'locks')
      await mkdir(locksDir, { recursive: true, mode: 0o700 })
      const lockPath = join(locksDir, 'compiler.lock')

      // Create valid lock file for a dead PID
      await writeFile(
        lockPath,
        JSON.stringify({ schema_version: 1, pid: 9999999, token: 'valid_token_123' }),
        { mode: 0o600 }
      )

      __setOKFCompilerTestHooks({ simulateLockGrowthBeforeRead: true })
      const compiler = createOKFCompiler()

      try {
        await expect(
          compiler.compile({
            project_root: realRoot,
            project_scope_id: projectScopeId,
            evaluation_at: evaluationAt,
            compiler_version: 'dsh-mnemosyne-okf/1',
          })
        ).rejects.toThrowError(expect.objectContaining({ code: 'memory_compile_busy' }))

        // Lock file must NOT have been unlinked or stolen
        const { existsSync } = await import('node:fs')
        expect(existsSync(lockPath)).toBe(true)
      } finally {
        __setOKFCompilerTestHooks(null)
      }
    } finally {
      __setOKFCompilerTestHooks(null)
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('85. verifyAndLoadGenerationWorld defaults to computeProjectScopeId and rejects cross-project generation copy', async () => {
    const tempDirA = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-85a-'))
    const tempDirB = await mkdtemp(join(await realpath(tmpdir()), 'dsh-gsec-85b-'))
    try {
      const realRootA = await realpath(tempDirA)
      const realRootB = await realpath(tempDirB)
      const projectScopeIdA = computeProjectScopeId(realRootA)
      const compiler = createOKFCompiler()

      const res = await compiler.compile({
        project_root: realRootA,
        project_scope_id: projectScopeIdA,
        evaluation_at: evaluationAt,
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Copy generation from root A to root B
      const { cp } = await import('node:fs/promises')
      const { verifyAndLoadGenerationWorld } = await import('../src/generation-store.js')
      await cp(join(realRootA, '.dsh-mnemosyne'), join(realRootB, '.dsh-mnemosyne'), { recursive: true })

      // Calling verifyAndLoadGenerationWorld on root B without expectedScope MUST fail closed
      await expect(
        verifyAndLoadGenerationWorld(realRootB, res.generation_id)
      ).rejects.toThrowError(MemoryStoreError)
    } finally {
      await rm(tempDirA, { recursive: true, force: true })
      await rm(tempDirB, { recursive: true, force: true })
    }
  })
})
