import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { canonicalHash, compareCodePoints } from './protocol/canonical.js'
import { MemoryStoreError } from './memory-store-error.js'
import { openMemoryFactStore } from './memory-store.js'
import type { LongTermMemoryFact, ShortTermMemoryFact } from './memory-fact.js'
import {
  deriveComponentSlug,
  renderComponentPage,
  renderMemoryPage,
  renderRootPage,
  renderSessionPage,
} from './okf-render.js'
import {
  checkPathHierarchy,
  ensureDirectoryChain,
  validateProjectRoot,
  validateScopeId,
} from './memory-store-path.js'
import { computeProjectScopeId } from './runtime-scope.js'
import {
  buildExpectedIndex,
  canonicalizeCurrentPointer,
  canonicalizeGenerationMetadata,
  canonicalizeIndex,
  canonicalizeManifest,
  validateCurrentPointer,
  validateGenerationId,
  validateGenerationMetadata,
  validateIndex,
  validateManifest,
  validateManifestId,
  type OKFCurrentPointer,
  type OKFGenerationMetadata,
  type OKFIndex,
  type OKFInputManifest,
  type OKFOutputFileRef,
} from './okf-schema.js'

export interface GenerationLayout {
  projectRoot: string
  storeRoot: string
  manifestsRoot: string
  generationsRoot: string
  locksRoot: string
  tmpRoot: string
  currentPath: string
}

export function getGenerationLayout(projectRoot: string): GenerationLayout {
  const storeRoot = join(projectRoot, '.dsh-mnemosyne')
  return {
    projectRoot,
    storeRoot,
    manifestsRoot: join(storeRoot, 'manifests'),
    generationsRoot: join(storeRoot, 'generations'),
    locksRoot: join(storeRoot, 'locks'),
    tmpRoot: join(storeRoot, 'tmp'),
    currentPath: join(storeRoot, 'CURRENT'),
  }
}

export async function syncDirectory(dirPath: string): Promise<void> {
  let handle
  try {
    handle = await open(dirPath, constants.O_RDONLY)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL')) {
      return
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  try {
    await handle.sync()
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (process.platform === 'win32' && (code === 'EINVAL' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EPERM')) {
      return
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  } finally {
    await handle.close()
  }
}

const MAX_READ_BYTES = 1048576 // 1 MiB max for compiler JSON/Markdown files
const MAX_LOCK_BYTES = 4096
const LOCK_TOKEN_REGEX = /^[a-zA-Z0-9_-]{1,128}$/
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface VerifiedCompilerLock {
  schema_version: 1
  pid: number
  token: string
  dev: number
  ino: number
}

export async function readStrictFile(
  projectRoot: string,
  filePath: string
): Promise<{ text: string; buffer: Buffer; sha256: string; byteLength: number }> {
  await checkPathHierarchy(projectRoot, filePath)

  let beforeStat
  try {
    beforeStat = await lstat(filePath)
  } catch (err: unknown) {
    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'ENOENT') {
      throw new MemoryStoreError('memory_compile_not_found')
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  if (beforeStat.isSymbolicLink()) {
    throw new MemoryStoreError('memory_compile_symlink_rejected')
  }
  if (!beforeStat.isFile()) {
    throw new MemoryStoreError('memory_compile_path_unsafe')
  }
  if (beforeStat.size > MAX_READ_BYTES) {
    throw new MemoryStoreError('memory_compile_decode_failed')
  }
  if ((beforeStat.mode & 0o777) !== 0o600) {
    throw new MemoryStoreError('memory_compile_insecure_permissions')
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let fileHandle
  try {
    fileHandle = await open(filePath, openFlags)
  } catch (err: unknown) {
    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'ENOENT') {
      throw new MemoryStoreError('memory_compile_not_found')
    }
    if (nodeErr.code === 'ELOOP' || nodeErr.code === 'EMLINK') {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  try {
    const handleStat = await fileHandle.stat()
    if (handleStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    if (!handleStat.isFile()) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }
    if (handleStat.dev !== beforeStat.dev || handleStat.ino !== beforeStat.ino) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }

    const buffer = await fileHandle.readFile()

    const afterStat = await lstat(filePath)
    if (afterStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    if (!afterStat.isFile()) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }
    if (
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.dev !== handleStat.dev ||
      afterStat.ino !== handleStat.ino
    ) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }
    if ((afterStat.mode & 0o777) !== 0o600) {
      throw new MemoryStoreError('memory_compile_insecure_permissions')
    }
    if (afterStat.size > MAX_READ_BYTES || buffer.length !== afterStat.size || buffer.length !== handleStat.size) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }

    let text: string
    try {
      text = utf8Decoder.decode(buffer)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_compile_decode_failed', err)
    }

    // Raw buffer SHA-256
    const sha256 = `sha256_${createHash('sha256').update(buffer).digest('hex')}`
    return {
      text,
      buffer,
      sha256,
      byteLength: buffer.length,
    }
  } finally {
    await fileHandle.close()
  }
}

export async function readVerifiedCompilerLock(
  projectRoot: string,
  lockPath: string
): Promise<VerifiedCompilerLock> {
  await checkPathHierarchy(projectRoot, lockPath)

  let beforeStat
  try {
    beforeStat = await lstat(lockPath)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      throw new MemoryStoreError('memory_compile_not_found')
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  if (beforeStat.isSymbolicLink()) {
    throw new MemoryStoreError('memory_compile_symlink_rejected')
  }
  if (!beforeStat.isFile()) {
    throw new MemoryStoreError('memory_compile_path_unsafe')
  }
  if ((beforeStat.mode & 0o777) !== 0o600) {
    throw new MemoryStoreError('memory_compile_insecure_permissions')
  }
  if (beforeStat.size > MAX_LOCK_BYTES) {
    throw new MemoryStoreError('memory_compile_decode_failed')
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await open(lockPath, openFlags)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      throw new MemoryStoreError('memory_compile_not_found')
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  try {
    const handleStat = await handle.stat()
    if (handleStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    if (!handleStat.isFile()) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }
    if ((handleStat.mode & 0o777) !== 0o600) {
      throw new MemoryStoreError('memory_compile_insecure_permissions')
    }
    if (
      handleStat.dev !== beforeStat.dev ||
      handleStat.ino !== beforeStat.ino ||
      handleStat.mode !== beforeStat.mode ||
      handleStat.size !== beforeStat.size
    ) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }

    const readBuffer = Buffer.alloc(MAX_LOCK_BYTES + 1)
    let totalBytes = 0

    if (internalStoreHooks?.simulateLockGrowthBeforeRead) {
      await writeFile(lockPath, 'a'.repeat(10000), { mode: 0o600, flag: 'a' })
    }

    while (totalBytes < readBuffer.length) {
      const bytesToRead = readBuffer.length - totalBytes
      const readResult = await handle.read(readBuffer, totalBytes, bytesToRead, totalBytes)
      if (readResult.bytesRead === 0) {
        break
      }
      totalBytes += readResult.bytesRead
      if (totalBytes > MAX_LOCK_BYTES) {
        throw new MemoryStoreError('memory_compile_decode_failed')
      }
    }

    if (totalBytes > MAX_LOCK_BYTES) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }

    const buffer = readBuffer.subarray(0, totalBytes)

    const afterStat = await lstat(lockPath)
    if (afterStat.isSymbolicLink()) {
      throw new MemoryStoreError('memory_compile_symlink_rejected')
    }
    if (!afterStat.isFile()) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }
    if ((afterStat.mode & 0o777) !== 0o600) {
      throw new MemoryStoreError('memory_compile_insecure_permissions')
    }
    if (
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.dev !== handleStat.dev ||
      afterStat.ino !== handleStat.ino ||
      afterStat.mode !== handleStat.mode ||
      afterStat.size !== totalBytes ||
      handleStat.size !== totalBytes
    ) {
      throw new MemoryStoreError('memory_compile_path_unsafe')
    }

    let text: string
    try {
      text = utf8Decoder.decode(buffer)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_compile_decode_failed', err)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_compile_decode_failed', err)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }
    const keys = Object.keys(parsed).sort()
    if (keys.length !== 3 || keys[0] !== 'pid' || keys[1] !== 'schema_version' || keys[2] !== 'token') {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }

    const obj = parsed as Record<string, unknown>
    if (obj.schema_version !== 1) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }
    if (
      typeof obj.pid !== 'number' ||
      !Number.isInteger(obj.pid) ||
      obj.pid <= 0 ||
      obj.pid > 2147483647
    ) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }
    if (
      typeof obj.token !== 'string' ||
      !LOCK_TOKEN_REGEX.test(obj.token)
    ) {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }

    return {
      schema_version: 1,
      pid: obj.pid,
      token: obj.token,
      dev: handleStat.dev,
      ino: handleStat.ino,
    }
  } finally {
    await handle.close()
  }
}

export interface InternalStoreHooks {
  simulateLockWriteFailure?: boolean
  simulateLockSyncFailure?: boolean
  simulateLockCloseFailure?: boolean
  simulateLockGrowthBeforeRead?: boolean
  simulateManifestTempWriteFailure?: boolean
  simulateManifestTempSyncFailure?: boolean
  simulateManifestTempCloseFailure?: boolean
  simulateCurrentTempWriteFailure?: boolean
  simulateCurrentTempSyncFailure?: boolean
  simulateCurrentTempCloseFailure?: boolean
}

let internalStoreHooks: InternalStoreHooks | null = null

export function __setInternalStoreHooks(hooks: InternalStoreHooks | null): void {
  internalStoreHooks = hooks
}

export async function acquireCompilerLock(projectRoot: string): Promise<() => Promise<void>> {
  const layout = getGenerationLayout(projectRoot)
  await ensureDirectoryChain(projectRoot, layout.locksRoot)

  const lockPath = join(layout.locksRoot, 'compiler.lock')
  const token = randomUUID()
  const lockPayload = {
    schema_version: 1,
    pid: process.pid,
    token,
  }
  const lockContent = JSON.stringify(lockPayload)

  let lockDev: number | null = null
  let lockIno: number | null = null

  async function tryCreateLock(): Promise<boolean> {
    let handle
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === 'EEXIST') {
        return false
      }
      throw new MemoryStoreError('memory_compile_io_failed', err)
    }

    let firstError: unknown = null
    try {
      if (internalStoreHooks?.simulateLockWriteFailure) {
        throw new Error('simulated lock write failure')
      }
      await handle.writeFile(lockContent, 'utf8')
      if (internalStoreHooks?.simulateLockSyncFailure) {
        throw new Error('simulated lock sync failure')
      }
      await handle.sync()
      const st = await handle.stat()
      lockDev = st.dev
      lockIno = st.ino
    } catch (err: unknown) {
      firstError = err
    } finally {
      if (handle) {
        try {
          await handle.close()
          if (internalStoreHooks?.simulateLockCloseFailure) {
            throw new Error('simulated lock close failure')
          }
        } catch (closeErr: unknown) {
          if (!firstError) firstError = closeErr
        }
      }
    }

    if (firstError) {
      try {
        await unlink(lockPath)
      } catch {}
      throw new MemoryStoreError('memory_compile_io_failed', firstError)
    }

    return true
  }

  const created = await tryCreateLock()
  if (!created) {
    // Lock file already exists. Strictly inspect owner lock.
    let verifiedLock: VerifiedCompilerLock
    try {
      verifiedLock = await readVerifiedCompilerLock(projectRoot, lockPath)
    } catch (err: unknown) {
      if (err instanceof MemoryStoreError && err.code === 'memory_compile_insecure_permissions') {
        throw err
      }
      throw new MemoryStoreError('memory_compile_busy')
    }

    let isAlive = false
    try {
      process.kill(verifiedLock.pid, 0)
      isAlive = true
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === 'EPERM') {
        isAlive = true
      } else if (code === 'ESRCH') {
        isAlive = false
      } else {
        isAlive = true
      }
    }

    if (isAlive) {
      throw new MemoryStoreError('memory_compile_busy')
    }

    // PID is dead. Re-verify lock file inode before unlinking.
    try {
      const lockStatAfter = await lstat(lockPath)
      if (lockStatAfter.dev === verifiedLock.dev && lockStatAfter.ino === verifiedLock.ino) {
        await unlink(lockPath)
      } else {
        throw new MemoryStoreError('memory_compile_busy')
      }
    } catch {
      throw new MemoryStoreError('memory_compile_busy')
    }

    // Retry lock creation once
    const retryCreated = await tryCreateLock()
    if (!retryCreated) {
      throw new MemoryStoreError('memory_compile_busy')
    }
  }

  const myDev = lockDev!
  const myIno = lockIno!
  const myToken = token

  return async () => {
    try {
      const verified = await readVerifiedCompilerLock(projectRoot, lockPath)
      if (
        verified.dev === myDev &&
        verified.ino === myIno &&
        verified.pid === process.pid &&
        verified.token === myToken
      ) {
        // Right before unlink, confirm path dev and ino STILL match owner inode
        const finalStat = await lstat(lockPath)
        if (finalStat.dev === myDev && finalStat.ino === myIno) {
          await unlink(lockPath)
        }
      }
    } catch {
      // Lock was replaced, deleted, permissions changed, or cannot be confirmed as ours -> do NOT unlink
    }
  }
}

export async function publishManifest(projectRoot: string, manifest: OKFInputManifest): Promise<'created' | 'noop'> {
  const layout = getGenerationLayout(projectRoot)
  await ensureDirectoryChain(projectRoot, layout.manifestsRoot)
  await ensureDirectoryChain(projectRoot, layout.tmpRoot)

  const manifestPath = join(layout.manifestsRoot, `${manifest.manifest_id}.json`)
  const canonical = canonicalizeManifest(manifest)

  try {
    const existingFile = await readStrictFile(projectRoot, manifestPath)
    let parsed: unknown
    try {
      parsed = JSON.parse(existingFile.text)
    } catch {
      throw new MemoryStoreError('memory_compile_decode_failed')
    }
    const validatedExisting = validateManifest(parsed)
    if (validatedExisting.content_sha256 === manifest.content_sha256) {
      return 'noop'
    }
    throw new MemoryStoreError('memory_compile_identity_conflict')
  } catch (err: unknown) {
    if (err instanceof MemoryStoreError) {
      if (err.code !== 'memory_compile_not_found') {
        throw err
      }
    } else {
      throw new MemoryStoreError('memory_compile_io_failed', err)
    }
  }

  const tempManifestPath = join(layout.tmpRoot, `tmp_manifest_${randomUUID()}.tmp`)
  let handle
  let firstError: unknown = null
  try {
    handle = await open(tempManifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    if (internalStoreHooks?.simulateManifestTempWriteFailure) {
      throw new Error('simulated manifest temp write failure')
    }
    await handle.writeFile(canonical, 'utf8')
    if (internalStoreHooks?.simulateManifestTempSyncFailure) {
      throw new Error('simulated manifest temp sync failure')
    }
    await handle.sync()
  } catch (err: unknown) {
    firstError = err
  } finally {
    if (handle) {
      try {
        await handle.close()
        if (internalStoreHooks?.simulateManifestTempCloseFailure) {
          throw new Error('simulated manifest temp close failure')
        }
      } catch (closeErr: unknown) {
        if (!firstError) firstError = closeErr
      }
    }
  }

  if (firstError) {
    try {
      await unlink(tempManifestPath)
    } catch {}
    throw new MemoryStoreError('memory_compile_io_failed', firstError)
  }

  try {
    await link(tempManifestPath, manifestPath)
  } catch (err: unknown) {
    try {
      await unlink(tempManifestPath)
    } catch {}
    const code = (err as { code?: string }).code
    if (code === 'EEXIST') {
      const winnerFile = await readStrictFile(projectRoot, manifestPath)
      let parsedWinner: unknown
      try {
        parsedWinner = JSON.parse(winnerFile.text)
      } catch {
        throw new MemoryStoreError('memory_compile_decode_failed')
      }
      const validatedWinner = validateManifest(parsedWinner)
      if (validatedWinner.content_sha256 === manifest.content_sha256) {
        return 'noop'
      }
      throw new MemoryStoreError('memory_compile_identity_conflict')
    }
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  try {
    await syncDirectory(layout.manifestsRoot)
    await unlink(tempManifestPath)
    await syncDirectory(layout.tmpRoot)
  } catch (err: unknown) {
    try {
      await unlink(tempManifestPath)
    } catch {}
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  return 'created'
}

export async function publishCurrent(projectRoot: string, current: OKFCurrentPointer): Promise<void> {
  const layout = getGenerationLayout(projectRoot)
  await ensureDirectoryChain(projectRoot, layout.storeRoot)
  await ensureDirectoryChain(projectRoot, layout.tmpRoot)

  const canonical = canonicalizeCurrentPointer(current)
  const tempPath = join(layout.tmpRoot, `tmp_current_${randomUUID()}.tmp`)

  let handle
  let firstError: unknown = null
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    if (internalStoreHooks?.simulateCurrentTempWriteFailure) {
      throw new Error('simulated current temp write failure')
    }
    await handle.writeFile(canonical, 'utf8')
    if (internalStoreHooks?.simulateCurrentTempSyncFailure) {
      throw new Error('simulated current temp sync failure')
    }
    await handle.sync()
  } catch (err: unknown) {
    firstError = err
  } finally {
    if (handle) {
      try {
        await handle.close()
        if (internalStoreHooks?.simulateCurrentTempCloseFailure) {
          throw new Error('simulated current temp close failure')
        }
      } catch (closeErr: unknown) {
        if (!firstError) firstError = closeErr
      }
    }
  }

  if (firstError) {
    try {
      await unlink(tempPath)
    } catch {}
    throw new MemoryStoreError('memory_compile_io_failed', firstError)
  }

  try {
    await rename(tempPath, layout.currentPath)
  } catch (err: unknown) {
    try {
      await unlink(tempPath)
    } catch {}
    throw new MemoryStoreError('memory_compile_io_failed', err)
  }

  await syncDirectory(layout.storeRoot)
}

export async function readRawCurrentPointerUnverified(
  projectRoot: string,
  expectedProjectScopeId: string
): Promise<OKFCurrentPointer | null> {
  const layout = getGenerationLayout(projectRoot)
  let fileResult
  try {
    fileResult = await readStrictFile(projectRoot, layout.currentPath)
  } catch (err: unknown) {
    if (err instanceof MemoryStoreError && err.code === 'memory_compile_not_found') {
      return null
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fileResult.text)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_compile_decode_failed', err)
  }

  const current = validateCurrentPointer(parsed)
  if (current.project_scope_id !== expectedProjectScopeId) {
    throw new MemoryStoreError('memory_compile_current_invalid')
  }

  const canonical = canonicalizeCurrentPointer(current)
  if (fileResult.text !== canonical) {
    throw new MemoryStoreError('memory_compile_noncanonical')
  }

  return current
}

export async function readCurrentPointer(
  projectRoot: string,
  expectedProjectScopeId: string
): Promise<OKFCurrentPointer | null> {
  const rawCurrent = await readRawCurrentPointerUnverified(projectRoot, expectedProjectScopeId)
  if (!rawCurrent) {
    return null
  }

  const genMeta = await verifyPublishedGenerationWorld(projectRoot, rawCurrent.generation_id, expectedProjectScopeId)
  if (
    rawCurrent.project_scope_id !== genMeta.project_scope_id ||
    rawCurrent.generation_sha256 !== genMeta.content_sha256 ||
    rawCurrent.manifest_id !== genMeta.manifest_id ||
    rawCurrent.manifest_sha256 !== genMeta.manifest_sha256
  ) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  return rawCurrent
}

export async function verifyPublishedGenerationWorld(
  projectRoot: string,
  generationId: string,
  expectedProjectScopeId?: string
): Promise<OKFGenerationMetadata> {
  validateGenerationId(generationId)
  const layout = getGenerationLayout(projectRoot)
  const genDir = join(layout.generationsRoot, generationId)

  await checkPathHierarchy(projectRoot, genDir)

  // 1. Read generation.json
  const genJsonPath = join(genDir, 'generation.json')
  const genResult = await readStrictFile(projectRoot, genJsonPath)
  let parsedGen: unknown
  try {
    parsedGen = JSON.parse(genResult.text)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_compile_decode_failed', err)
  }
  const genMeta = validateGenerationMetadata(parsedGen)
  if (genMeta.generation_id !== generationId) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }
  if (genResult.text !== canonicalizeGenerationMetadata(genMeta)) {
    throw new MemoryStoreError('memory_compile_noncanonical')
  }

  const expectedScope = expectedProjectScopeId ?? computeProjectScopeId(projectRoot)
  if (genMeta.project_scope_id !== expectedScope) {
    throw new MemoryStoreError('memory_compile_current_invalid')
  }

  // 2. Read generation-local manifest.json
  const localManifestJsonPath = join(genDir, 'manifest.json')
  const localManifestResult = await readStrictFile(projectRoot, localManifestJsonPath)
  let parsedLocalManifest: unknown
  try {
    parsedLocalManifest = JSON.parse(localManifestResult.text)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_compile_decode_failed', err)
  }
  const localManifest = validateManifest(parsedLocalManifest)
  if (localManifest.manifest_id !== genMeta.manifest_id || localManifest.content_sha256 !== genMeta.manifest_sha256) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }
  if (localManifestResult.text !== canonicalizeManifest(localManifest)) {
    throw new MemoryStoreError('memory_compile_noncanonical')
  }

  // 3. Read permanent manifests/<manifest-id>.json
  const permManifestPath = join(layout.manifestsRoot, `${genMeta.manifest_id}.json`)
  const permManifestResult = await readStrictFile(projectRoot, permManifestPath)
  let parsedPermManifest: unknown
  try {
    parsedPermManifest = JSON.parse(permManifestResult.text)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_compile_decode_failed', err)
  }
  const permManifest = validateManifest(parsedPermManifest)
  if (permManifestResult.text !== canonicalizeManifest(permManifest)) {
    throw new MemoryStoreError('memory_compile_noncanonical')
  }
  if (
    permManifest.content_sha256 !== localManifest.content_sha256 ||
    permManifestResult.text !== localManifestResult.text
  ) {
    throw new MemoryStoreError('memory_compile_identity_conflict')
  }

  // Cross-check metadata invariants
  if (
    localManifest.generation_id !== generationId ||
    localManifest.project_scope_id !== genMeta.project_scope_id ||
    localManifest.compiler_version !== genMeta.compiler_version ||
    localManifest.evaluation_at !== genMeta.evaluation_at ||
    localManifest.compiled_output_sha256 !== genMeta.compiled_output_sha256
  ) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  // 4. Cross-verify against Fact Store & build expected Index & Pages
  const store = openMemoryFactStore({
    project_root: projectRoot,
    project_scope_id: genMeta.project_scope_id,
  })

  const shortFacts: ShortTermMemoryFact[] = []
  const longFacts: LongTermMemoryFact[] = []

  for (const inRef of localManifest.inputs) {
    if (inRef.tier === 'short_term') {
      const fact = await store.getShortTerm(inRef.session_scope_id!, inRef.memory_id)
      if (!fact || fact.content_sha256 !== inRef.content_sha256 || fact.project_scope_id !== genMeta.project_scope_id) {
        throw new MemoryStoreError('memory_compile_generation_incomplete')
      }
      shortFacts.push(fact)
    } else {
      const fact = await store.getLongTerm(inRef.memory_id)
      if (!fact || fact.content_sha256 !== inRef.content_sha256 || fact.project_scope_id !== genMeta.project_scope_id) {
        throw new MemoryStoreError('memory_compile_generation_incomplete')
      }
      longFacts.push(fact)
    }
  }

  // Build expected Index from canonical facts
  const expectedIndex = buildExpectedIndex({
    generation_id: generationId,
    project_scope_id: genMeta.project_scope_id,
    compiler_version: genMeta.compiler_version,
    evaluation_at: genMeta.evaluation_at,
    shortFacts,
    longFacts,
  })
  const expectedIndexCanonical = canonicalizeIndex(expectedIndex)

  // 5. Read index.json and compare against expectedIndex byte-for-byte
  const indexJsonPath = join(genDir, 'index.json')
  const indexResult = await readStrictFile(projectRoot, indexJsonPath)
  if (indexResult.text !== expectedIndexCanonical) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  let parsedIndex: unknown
  try {
    parsedIndex = JSON.parse(indexResult.text)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_compile_decode_failed', err)
  }
  const index = validateIndex(parsedIndex)
  if (
    index.generation_id !== generationId ||
    index.project_scope_id !== genMeta.project_scope_id ||
    index.compiler_version !== genMeta.compiler_version ||
    index.evaluation_at !== genMeta.evaluation_at ||
    index.content_sha256 !== expectedIndex.content_sha256
  ) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  // 6. Group facts and derive exact expected output paths
  const sessionGroups = new Map<string, ShortTermMemoryFact[]>()
  for (const f of shortFacts) {
    if (!sessionGroups.has(f.session_scope_id)) {
      sessionGroups.set(f.session_scope_id, [])
    }
    sessionGroups.get(f.session_scope_id)!.push(f)
  }

  const componentGroups = new Map<string, LongTermMemoryFact[]>()
  for (const f of longFacts) {
    const slug = deriveComponentSlug(f.tags)
    if (!componentGroups.has(slug)) {
      componentGroups.set(slug, [])
    }
    componentGroups.get(slug)!.push(f)
  }

  const expectedOutputPaths: string[] = [
    'index.json',
    'wiki/ROOT.md',
    ...Array.from(sessionGroups.keys()).map((s) => `wiki/short-term/${s}.md`),
    ...Array.from(componentGroups.keys()).map((c) => `wiki/components/${c}.md`),
    ...shortFacts.map((f) => `wiki/memories/${f.memory_id}.md`),
    ...longFacts.map((f) => `wiki/memories/${f.memory_id}.md`),
  ]
  expectedOutputPaths.sort(compareCodePoints)

  // Manifest.outputs relative_path set must equal expectedOutputPaths exactly
  if (localManifest.outputs.length !== expectedOutputPaths.length) {
    throw new MemoryStoreError('memory_compile_generation_incomplete')
  }
  for (let i = 0; i < expectedOutputPaths.length; i++) {
    if (localManifest.outputs[i].relative_path !== expectedOutputPaths[i]) {
      throw new MemoryStoreError('memory_compile_generation_incomplete')
    }
  }

  const manifestOutputs = new Map<string, OKFOutputFileRef>()
  for (const out of localManifest.outputs) {
    manifestOutputs.set(out.relative_path, out)
  }

  // Allowed files MUST be constructed strictly from expectedOutputPaths (plus generation.json, manifest.json)
  const allowedFiles = new Set<string>(['generation.json', 'manifest.json', ...expectedOutputPaths])

  // Strict directory and file verification
  // Exactly 4 subdirectories must exist: wiki, wiki/short-term, wiki/components, wiki/memories
  const requiredDirs = ['wiki', 'wiki/short-term', 'wiki/components', 'wiki/memories']
  for (const rDir of requiredDirs) {
    const dirFull = join(genDir, ...rDir.split('/'))
    let dirStat
    try {
      dirStat = await lstat(dirFull)
    } catch {
      throw new MemoryStoreError('memory_compile_generation_incomplete')
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new MemoryStoreError('memory_compile_generation_incomplete')
    }
    if ((dirStat.mode & 0o777) !== 0o700) {
      throw new MemoryStoreError('memory_compile_insecure_permissions')
    }
  }

  const allowedDirs = new Set<string>(requiredDirs)

  const visitedDirs = new Set<string>()
  const visitedFiles = new Set<string>()

  async function checkTree(dir: string, base: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(base, full).split(sep).join('/')
      const st = await lstat(full)
      if (st.isSymbolicLink()) {
        throw new MemoryStoreError('memory_compile_symlink_rejected')
      }
      if (entry.isDirectory()) {
        if (!allowedDirs.has(rel)) {
          throw new MemoryStoreError('memory_compile_generation_incomplete')
        }
        if ((st.mode & 0o777) !== 0o700) {
          throw new MemoryStoreError('memory_compile_insecure_permissions')
        }
        visitedDirs.add(rel)
        await checkTree(full, base)
      } else if (entry.isFile()) {
        if (!allowedFiles.has(rel)) {
          throw new MemoryStoreError('memory_compile_generation_incomplete')
        }
        if ((st.mode & 0o777) !== 0o600) {
          throw new MemoryStoreError('memory_compile_insecure_permissions')
        }
        visitedFiles.add(rel)
      } else {
        throw new MemoryStoreError('memory_compile_path_unsafe')
      }
    }
  }

  await checkTree(genDir, genDir)

  // Verify all 4 required dirs are present in the generation directory tree
  for (const rDir of requiredDirs) {
    if (!visitedDirs.has(rDir)) {
      throw new MemoryStoreError('memory_compile_generation_incomplete')
    }
  }

  // Verify all output files in manifest match exact bytes and raw buffer SHA-256
  for (const out of localManifest.outputs) {
    const filePath = join(genDir, ...out.relative_path.split('/'))
    const fileResult = await readStrictFile(projectRoot, filePath)
    if (fileResult.byteLength !== out.byte_length || fileResult.sha256 !== out.content_sha256) {
      throw new MemoryStoreError('memory_compile_generation_incomplete')
    }
  }



  // Verify ROOT.md
  const expectedRootMd = renderRootPage({
    generation_id: generationId,
    evaluation_at: genMeta.evaluation_at,
    short_term_count: shortFacts.length,
    long_term_count: longFacts.length,
    sessions: Array.from(sessionGroups.keys()).sort(compareCodePoints),
    components: Array.from(componentGroups.keys()).sort(compareCodePoints),
    memories_count: shortFacts.length + longFacts.length,
  })
  const actualRoot = await readStrictFile(projectRoot, join(genDir, 'wiki', 'ROOT.md'))
  if (actualRoot.text !== expectedRootMd) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  // Verify Session pages
  for (const [sessId, facts] of sessionGroups.entries()) {
    const expectedSessionMd = renderSessionPage({
      session_scope_id: sessId,
      evaluation_at: genMeta.evaluation_at,
      facts,
    })
    const actualSession = await readStrictFile(projectRoot, join(genDir, 'wiki', 'short-term', `${sessId}.md`))
    if (actualSession.text !== expectedSessionMd) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  // Verify Component pages
  for (const [compSlug, facts] of componentGroups.entries()) {
    const expectedCompMd = renderComponentPage({
      component: compSlug,
      evaluation_at: genMeta.evaluation_at,
      facts,
    })
    const actualComp = await readStrictFile(projectRoot, join(genDir, 'wiki', 'components', `${compSlug}.md`))
    if (actualComp.text !== expectedCompMd) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  // Verify Memory pages
  for (const f of shortFacts) {
    const expectedMemMd = renderMemoryPage({
      fact: f,
      component: null,
      evaluation_at: genMeta.evaluation_at,
    })
    const actualMem = await readStrictFile(projectRoot, join(genDir, 'wiki', 'memories', `${f.memory_id}.md`))
    if (actualMem.text !== expectedMemMd) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }
  for (const f of longFacts) {
    const slug = deriveComponentSlug(f.tags)
    const expectedMemMd = renderMemoryPage({
      fact: f,
      component: slug,
      evaluation_at: genMeta.evaluation_at,
    })
    const actualMem = await readStrictFile(projectRoot, join(genDir, 'wiki', 'memories', `${f.memory_id}.md`))
    if (actualMem.text !== expectedMemMd) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  return genMeta
}

export const verifyGenerationDirectory: (projectRoot: string, generationId: string) => Promise<OKFGenerationMetadata> =
  verifyPublishedGenerationWorld
