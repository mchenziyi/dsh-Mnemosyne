import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compareCodePoints } from './protocol/canonical.js'
import {
  assertUtcTimestamp,
  canonicalizeLongTermMemoryFact,
  canonicalizeShortTermMemoryFact,
  validateLongTermMemoryFact,
  validateShortTermMemoryFact,
  type LongTermMemoryFact,
  type MemoryFact,
  type ShortTermMemoryFact,
} from './memory-fact.js'
import { MemoryStoreError } from './memory-store-error.js'
import {
  checkPathHierarchy,
  ensureDirectoryChain,
  getLongTermPath,
  getShortTermPath,
  getStoreLayout,
  validateMemoryId,
  validateProjectRoot,
  validateScopeId,
} from './memory-store-path.js'
import { computeProjectScopeId } from './runtime-scope.js'

export type WriteStatus = 'created' | 'noop'

export interface WriteResult {
  status: WriteStatus
  tier: 'short_term' | 'long_term'
  memory_id: string
  content_sha256: string
}

export interface ProjectStoreScope {
  project_root: string
  project_scope_id: string
}

export interface ListShortTermOptions {
  includeExpired?: boolean
}

export interface MemoryFactStore {
  putShortTerm(sessionScopeId: string, fact: ShortTermMemoryFact): Promise<WriteResult>
  getShortTerm(sessionScopeId: string, memoryId: string): Promise<ShortTermMemoryFact>
  listShortTerm(sessionScopeId: string, now: string, options?: ListShortTermOptions): Promise<ShortTermMemoryFact[]>
  listShortTermSessionScopes(): Promise<string[]>
  putLongTerm(fact: LongTermMemoryFact): Promise<WriteResult>
  getLongTerm(memoryId: string): Promise<LongTermMemoryFact>
  listLongTerm(): Promise<LongTermMemoryFact[]>
}

export interface MemoryStoreTestHooks {
  simulateLinkFailure?: boolean
  simulateTempFileFsyncFailure?: boolean
  simulateTargetParentFsyncFailure?: boolean
  simulateReadbackFailure?: boolean
}

let testHooks: MemoryStoreTestHooks | null = null

export function __setMemoryStoreTestHooks(hooks: MemoryStoreTestHooks | null): void {
  testHooks = hooks
}

const MAX_FACT_FILE_BYTES = 65536
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

async function syncDirectory(dirPath: string): Promise<void> {
  let handle
  try {
    handle = await open(dirPath, constants.O_RDONLY)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL')) {
      return
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  try {
    await handle.sync()
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (process.platform === 'win32' && (code === 'EINVAL' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EPERM')) {
      return
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  } finally {
    await handle.close()
  }
}

async function readFactFile<T extends MemoryFact>(
  projectRoot: string,
  filePath: string,
  tier: 'short_term' | 'long_term',
  expectedProjectScope: string,
  expectedSessionScope?: string
): Promise<T> {
  await checkPathHierarchy(projectRoot, filePath)

  let beforeStat
  try {
    beforeStat = await lstat(filePath)
  } catch (err: unknown) {
    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'ENOENT') {
      throw new MemoryStoreError('memory_store_not_found')
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  if (beforeStat.isSymbolicLink()) {
    throw new MemoryStoreError('memory_store_symlink_rejected')
  }
  if (!beforeStat.isFile()) {
    throw new MemoryStoreError('memory_store_path_unsafe')
  }
  if (beforeStat.size > MAX_FACT_FILE_BYTES) {
    throw new MemoryStoreError('memory_store_file_too_large')
  }
  if ((beforeStat.mode & 0o777) !== 0o600) {
    throw new MemoryStoreError('memory_store_insecure_permissions')
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let fileHandle
  try {
    fileHandle = await open(filePath, openFlags)
  } catch (err: unknown) {
    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'ENOENT') {
      throw new MemoryStoreError('memory_store_not_found')
    }
    if (nodeErr.code === 'ELOOP' || nodeErr.code === 'EMLINK') {
      throw new MemoryStoreError('memory_store_symlink_rejected')
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  try {
    const handleStat = await fileHandle.stat()
    if (handleStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_store_symlink_rejected')
    }
    if (!handleStat.isFile()) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if (handleStat.dev !== beforeStat.dev || handleStat.ino !== beforeStat.ino) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if (handleStat.size > MAX_FACT_FILE_BYTES) {
      throw new MemoryStoreError('memory_store_file_too_large')
    }

    const buffer = await fileHandle.readFile()

    const afterStat = await lstat(filePath)
    if (afterStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_store_symlink_rejected')
    }
    if (!afterStat.isFile()) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if (
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.dev !== handleStat.dev ||
      afterStat.ino !== handleStat.ino
    ) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if ((afterStat.mode & 0o777) !== 0o600) {
      throw new MemoryStoreError('memory_store_insecure_permissions')
    }
    if (afterStat.size > MAX_FACT_FILE_BYTES) {
      throw new MemoryStoreError('memory_store_file_too_large')
    }
    if (buffer.length !== afterStat.size || buffer.length !== handleStat.size || buffer.length > MAX_FACT_FILE_BYTES) {
      throw new MemoryStoreError('memory_store_file_too_large')
    }

    let text: string
    try {
      text = utf8Decoder.decode(buffer)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_store_decode_failed', err)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_store_decode_failed', err)
    }

    if (tier === 'short_term') {
      const fact = validateShortTermMemoryFact(parsed)
      if (fact.project_scope_id !== expectedProjectScope) {
        throw new MemoryStoreError('memory_store_scope_mismatch')
      }
      if (expectedSessionScope && fact.session_scope_id !== expectedSessionScope) {
        throw new MemoryStoreError('memory_store_scope_mismatch')
      }
      const canonical = canonicalizeShortTermMemoryFact(fact)
      if (text !== canonical) {
        throw new MemoryStoreError('memory_store_noncanonical')
      }
      return structuredClone(fact) as T
    } else {
      const fact = validateLongTermMemoryFact(parsed)
      if (fact.project_scope_id !== expectedProjectScope) {
        throw new MemoryStoreError('memory_store_scope_mismatch')
      }
      const canonical = canonicalizeLongTermMemoryFact(fact)
      if (text !== canonical) {
        throw new MemoryStoreError('memory_store_noncanonical')
      }
      return structuredClone(fact) as T
    }
  } finally {
    await fileHandle.close()
  }
}

async function atomicWriteFact(
  projectRoot: string,
  targetPath: string,
  fact: MemoryFact,
  tier: 'short_term' | 'long_term',
  expectedProjectScope: string,
  expectedSessionScope?: string
): Promise<WriteResult> {
  if (fact.project_scope_id !== expectedProjectScope) {
    throw new MemoryStoreError('memory_store_scope_mismatch')
  }
  if (tier === 'short_term' && (fact as ShortTermMemoryFact).session_scope_id !== expectedSessionScope) {
    throw new MemoryStoreError('memory_store_scope_mismatch')
  }

  // Pre-check if target file exists
  try {
    const existing = await readFactFile(projectRoot, targetPath, tier, expectedProjectScope, expectedSessionScope)
    if (existing.content_sha256 === fact.content_sha256) {
      return {
        status: 'noop',
        tier,
        memory_id: fact.memory_id,
        content_sha256: fact.content_sha256,
      }
    }
    throw new MemoryStoreError('memory_store_identity_conflict')
  } catch (err: unknown) {
    if (err instanceof MemoryStoreError) {
      if (err.code !== 'memory_store_not_found') {
        throw err
      }
    } else {
      throw new MemoryStoreError('memory_store_io_failed', err)
    }
  }

  const layout = getStoreLayout(projectRoot)
  await ensureDirectoryChain(projectRoot, dirname(targetPath))
  await ensureDirectoryChain(projectRoot, layout.tmpRoot)

  const tempFileName = `tmp_${randomUUID()}.tmp`
  const tempPath = join(layout.tmpRoot, tempFileName)

  let tempHandle
  try {
    tempHandle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  try {
    const canonical =
      tier === 'short_term'
        ? canonicalizeShortTermMemoryFact(fact as ShortTermMemoryFact)
        : canonicalizeLongTermMemoryFact(fact as LongTermMemoryFact)

    await tempHandle.writeFile(canonical, 'utf8')

    if (testHooks?.simulateTempFileFsyncFailure) {
      throw new Error('simulated temp file fsync failure')
    }

    await tempHandle.sync()
    await tempHandle.close()
    tempHandle = null

    if (testHooks?.simulateLinkFailure) {
      throw new Error('simulated link failure')
    }

    await link(tempPath, targetPath)
  } catch (err: unknown) {
    if (tempHandle) {
      try {
        await tempHandle.close()
      } catch {}
    }
    try {
      await unlink(tempPath)
    } catch {}

    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'EEXIST') {
      const winner = await readFactFile(projectRoot, targetPath, tier, expectedProjectScope, expectedSessionScope)
      if (winner.content_sha256 === fact.content_sha256) {
        return {
          status: 'noop',
          tier,
          memory_id: fact.memory_id,
          content_sha256: fact.content_sha256,
        }
      }
      throw new MemoryStoreError('memory_store_identity_conflict')
    }

    if (err instanceof MemoryStoreError) {
      throw err
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  // Target link is now established. Subsequent failures fail loud without removing published target.
  try {
    if (testHooks?.simulateTargetParentFsyncFailure) {
      throw new MemoryStoreError('memory_store_io_failed', new Error('simulated target parent fsync failure'))
    }

    // Fsync parent directory of target
    await syncDirectory(dirname(targetPath))

    // Unlink temp file
    await unlink(tempPath)

    // Fsync tmp directory
    await syncDirectory(layout.tmpRoot)

    await checkPathHierarchy(projectRoot, targetPath)

    if (testHooks?.simulateReadbackFailure) {
      throw new MemoryStoreError('memory_store_io_failed', new Error('simulated readback failure'))
    }

    const readBack = await readFactFile<MemoryFact>(projectRoot, targetPath, tier, expectedProjectScope, expectedSessionScope)
    if (readBack.content_sha256 !== fact.content_sha256 || readBack.memory_id !== fact.memory_id) {
      throw new MemoryStoreError('memory_store_hash_mismatch')
    }
  } catch (err: unknown) {
    // Best-effort cleanup of temp file
    try {
      await unlink(tempPath)
    } catch {}

    if (err instanceof MemoryStoreError) {
      throw err
    }
    throw new MemoryStoreError('memory_store_io_failed', err)
  }

  return {
    status: 'created',
    tier,
    memory_id: fact.memory_id,
    content_sha256: fact.content_sha256,
  }
}

export function openMemoryFactStore(scope: ProjectStoreScope): MemoryFactStore {
  if (!scope || typeof scope !== 'object') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const projectScopeId = validateScopeId(scope.project_scope_id)
  const projectRoot = scope.project_root

  async function getValidProjectRoot(): Promise<string> {
    const root = await validateProjectRoot(projectRoot)
    const expectedProjectScopeId = computeProjectScopeId(root)
    if (projectScopeId !== expectedProjectScopeId) {
      throw new MemoryStoreError('memory_store_scope_mismatch')
    }
    return root
  }

  return {
    async putShortTerm(sessionScopeId: string, fact: ShortTermMemoryFact): Promise<WriteResult> {
      const root = await getValidProjectRoot()
      const validSessionId = validateScopeId(sessionScopeId)
      const validated = validateShortTermMemoryFact(fact)
      if (validated.session_scope_id !== validSessionId) {
        throw new MemoryStoreError('memory_store_scope_mismatch')
      }
      const targetPath = getShortTermPath(root, validSessionId, validated.memory_id)
      return atomicWriteFact(root, targetPath, validated, 'short_term', projectScopeId, validSessionId)
    },

    async getShortTerm(sessionScopeId: string, memoryId: string): Promise<ShortTermMemoryFact> {
      const root = await getValidProjectRoot()
      const validSessionId = validateScopeId(sessionScopeId)
      const validMemoryId = validateMemoryId(memoryId)
      const targetPath = getShortTermPath(root, validSessionId, validMemoryId)
      return readFactFile<ShortTermMemoryFact>(root, targetPath, 'short_term', projectScopeId, validSessionId)
    },

    async listShortTerm(sessionScopeId: string, now: string, options?: ListShortTermOptions): Promise<ShortTermMemoryFact[]> {
      const root = await getValidProjectRoot()
      const validSessionId = validateScopeId(sessionScopeId)
      assertUtcTimestamp(now)

      const targetDir = join(root, '.dsh-mnemosyne', 'facts', 'short-term', validSessionId)

      let entries
      try {
        await checkPathHierarchy(root, targetDir)
        entries = await readdir(targetDir, { withFileTypes: true })
      } catch (err: unknown) {
        const nodeErr = err as { code?: string }
        if (nodeErr.code === 'ENOENT') {
          return []
        }
        if (err instanceof MemoryStoreError) {
          if (err.code === 'memory_store_not_found') return []
          throw err
        }
        throw new MemoryStoreError('memory_store_io_failed', err)
      }

      const results: ShortTermMemoryFact[] = []
      const nowMillis = Date.parse(now)

      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new MemoryStoreError('memory_store_symlink_rejected')
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          throw new MemoryStoreError('memory_store_decode_failed')
        }
        const memoryId = entry.name.slice(0, -5)
        validateMemoryId(memoryId)

        const filePath = join(targetDir, entry.name)
        const fact = await readFactFile<ShortTermMemoryFact>(root, filePath, 'short_term', projectScopeId, validSessionId)

        if (!options?.includeExpired) {
          const expiresMillis = Date.parse(fact.expires_at)
          if (nowMillis >= expiresMillis) {
            continue
          }
        }
        results.push(fact)
      }

      return results.sort((a, b) => compareCodePoints(a.memory_id, b.memory_id))
    },

    async listShortTermSessionScopes(): Promise<string[]> {
      const root = await getValidProjectRoot()
      const shortTermRoot = join(root, '.dsh-mnemosyne', 'facts', 'short-term')

      let entries
      try {
        await checkPathHierarchy(root, shortTermRoot)
        entries = await readdir(shortTermRoot, { withFileTypes: true })
      } catch (err: unknown) {
        const nodeErr = err as { code?: string }
        if (nodeErr.code === 'ENOENT') {
          return []
        }
        if (err instanceof MemoryStoreError) {
          if (err.code === 'memory_store_not_found') return []
          throw err
        }
        throw new MemoryStoreError('memory_store_io_failed', err)
      }

      const results: string[] = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new MemoryStoreError('memory_store_symlink_rejected')
        }
        if (!entry.isDirectory()) {
          throw new MemoryStoreError('memory_store_path_unsafe')
        }
        const sessionId = entry.name
        validateScopeId(sessionId)

        const dirPath = join(shortTermRoot, sessionId)
        await checkPathHierarchy(root, dirPath)
        results.push(sessionId)
      }

      return results.sort(compareCodePoints)
    },

    async putLongTerm(fact: LongTermMemoryFact): Promise<WriteResult> {
      const root = await getValidProjectRoot()
      const validated = validateLongTermMemoryFact(fact)
      for (const ref of validated.source_short_term_refs) {
        if (ref.project_scope_id !== projectScopeId) {
          throw new MemoryStoreError('memory_store_scope_mismatch')
        }
      }
      const targetPath = getLongTermPath(root, validated.memory_id)
      return atomicWriteFact(root, targetPath, validated, 'long_term', projectScopeId)
    },

    async getLongTerm(memoryId: string): Promise<LongTermMemoryFact> {
      const root = await getValidProjectRoot()
      const validMemoryId = validateMemoryId(memoryId)
      const targetPath = getLongTermPath(root, validMemoryId)
      return readFactFile<LongTermMemoryFact>(root, targetPath, 'long_term', projectScopeId)
    },

    async listLongTerm(): Promise<LongTermMemoryFact[]> {
      const root = await getValidProjectRoot()
      const targetDir = join(root, '.dsh-mnemosyne', 'facts', 'long-term')

      let entries
      try {
        await checkPathHierarchy(root, targetDir)
        entries = await readdir(targetDir, { withFileTypes: true })
      } catch (err: unknown) {
        const nodeErr = err as { code?: string }
        if (nodeErr.code === 'ENOENT') {
          return []
        }
        if (err instanceof MemoryStoreError) {
          if (err.code === 'memory_store_not_found') return []
          throw err
        }
        throw new MemoryStoreError('memory_store_io_failed', err)
      }

      const results: LongTermMemoryFact[] = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new MemoryStoreError('memory_store_symlink_rejected')
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          throw new MemoryStoreError('memory_store_decode_failed')
        }
        const memoryId = entry.name.slice(0, -5)
        validateMemoryId(memoryId)

        const filePath = join(targetDir, entry.name)
        const fact = await readFactFile<LongTermMemoryFact>(root, filePath, 'long_term', projectScopeId)
        results.push(fact)
      }

      return results.sort((a, b) => compareCodePoints(a.memory_id, b.memory_id))
    },
  }
}
