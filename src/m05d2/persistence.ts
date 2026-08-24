import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, lstat, unlink, link } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { canonicalBytes, ProtocolValidationError, sha256 } from '../protocol/canonical.js'
import { validateRealCanaryExecutionClaim, type RealCanaryExecutionClaim } from './approval.js'
import { validateRealCanaryReceipt, validateRealCanarySummary, type RealCanaryReceipt, type RealCanarySummary } from './runner.js'

export interface PersistenceInternalTestHooks {
  beforeTempFileFsync?: () => Promise<void> | void
  beforePublishLink?: () => Promise<void> | void
  afterPublishLink?: () => Promise<void> | void
  beforeDirFsync?: () => Promise<void> | void
  afterDirFsync?: () => Promise<void> | void
  simulateFileFsyncFailure?: boolean
  simulateDirFsyncFailure?: boolean
  simulateReadbackMismatch?: boolean
}

let activeTestHooks: PersistenceInternalTestHooks | null = null

export function __setPersistenceTestHooksForTest(hooks: PersistenceInternalTestHooks | null): void {
  activeTestHooks = hooks
}

interface DirectoryIdentity {
  dev: number
  ino: number
  mode: number
}

async function getDirectoryIdentity(dirPath: string): Promise<DirectoryIdentity> {
  try {
    const stat = await lstat(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      throw new ProtocolValidationError()
    }
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode }
  } catch {
    throw new ProtocolValidationError()
  }
}

export async function verifyPersistenceRoot(rootPath: string, expectedHash: string): Promise<string> {
  if (
    typeof rootPath !== 'string' ||
    !isAbsolute(rootPath) ||
    rootPath.split(sep).includes('..') ||
    normalize(rootPath).split(sep).includes('..')
  ) {
    throw new ProtocolValidationError()
  }

  const normalized = normalize(resolve(rootPath))
  const segments = normalized.split(sep).filter(Boolean)
  let curr = normalized.startsWith(sep) ? sep : ''

  for (let i = 0; i < segments.length; i++) {
    curr = join(curr, segments[i])
    try {
      const stat = await lstat(curr)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProtocolValidationError()
      }
      // Ancestors must not have group/other write permissions
      if ((stat.mode & 0o022) !== 0) {
        throw new ProtocolValidationError()
      }
      // The persistence root itself must be strictly 0700 (reject 0755)
      if (i === segments.length - 1) {
        if ((stat.mode & 0o777) !== 0o700) {
          throw new ProtocolValidationError()
        }
      }
    } catch {
      throw new ProtocolValidationError()
    }
  }

  const actualHash = sha256(normalized)
  if (actualHash !== expectedHash) {
    throw new ProtocolValidationError()
  }

  return normalized
}

async function ensureSubdirectory(parentDir: string, subName: string): Promise<string> {
  if (
    typeof subName !== 'string' ||
    !/^[a-z0-9_-]{1,64}$/i.test(subName) ||
    subName.includes('/') ||
    subName.includes('\\') ||
    subName.includes('..')
  ) {
    throw new ProtocolValidationError()
  }
  const subPath = join(parentDir, subName)
  try {
    const stat = await lstat(subPath)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      throw new ProtocolValidationError()
    }
  } catch (err) {
    if (err instanceof ProtocolValidationError) throw err
    try {
      await mkdir(subPath, { mode: 0o700 })
    } catch {
      try {
        const stat = await lstat(subPath)
        if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
          throw new ProtocolValidationError()
        }
      } catch {
        throw new ProtocolValidationError()
      }
    }
  }
  return subPath
}

async function safeWriteFileNoOverwrite(
  rootDir: string,
  dirPath: string,
  fileName: string,
  content: string
): Promise<void> {
  if (
    typeof fileName !== 'string' ||
    !/^[a-z0-9_. -]{1,128}$/i.test(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..')
  ) {
    throw new ProtocolValidationError()
  }
  const targetPath = join(dirPath, fileName)

  // Target file must not already exist
  try {
    const targetStat = await lstat(targetPath)
    if (targetStat) {
      throw new ProtocolValidationError()
    }
  } catch (err) {
    if (err instanceof ProtocolValidationError) throw err
  }

  // Pre-publish directory identities
  const preRootIdentity = await getDirectoryIdentity(rootDir)
  const preDirIdentity = dirPath === rootDir ? preRootIdentity : await getDirectoryIdentity(dirPath)

  const nonce = randomUUID()
  const tempFile = join(dirPath, `.tmp_${nonce}`)
  let tempCreated = false
  let published = false
  let handle: import('node:fs/promises').FileHandle | null = null

  try {
    handle = await open(tempFile, 'wx', 0o600).catch(() => {
      throw new ProtocolValidationError()
    })
    tempCreated = true

    await activeTestHooks?.beforeTempFileFsync?.()
    if (activeTestHooks?.simulateFileFsyncFailure) {
      throw new ProtocolValidationError()
    }

    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null

    // Verify temp file status before publish
    const tempStat = await lstat(tempFile)
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || (tempStat.mode & 0o777) !== 0o600) {
      throw new ProtocolValidationError()
    }

    await activeTestHooks?.beforePublishLink?.()

    // Pre-publish re-verification of directory identities
    const currRoot = await getDirectoryIdentity(rootDir)
    if (currRoot.dev !== preRootIdentity.dev || currRoot.ino !== preRootIdentity.ino) {
      throw new ProtocolValidationError()
    }
    const currDir = dirPath === rootDir ? currRoot : await getDirectoryIdentity(dirPath)
    if (currDir.dev !== preDirIdentity.dev || currDir.ino !== preDirIdentity.ino) {
      throw new ProtocolValidationError()
    }

    // Atomic publish via link (POSIX link fails with EEXIST if target exists)
    await link(tempFile, targetPath)
    published = true

    await unlink(tempFile).catch(() => {})
    tempCreated = false

    await activeTestHooks?.afterPublishLink?.()

    // Directory fsync
    await activeTestHooks?.beforeDirFsync?.()
    if (activeTestHooks?.simulateDirFsyncFailure) {
      throw new ProtocolValidationError()
    }

    const dirHandle = await open(dirPath, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }

    if (dirPath !== rootDir) {
      const rootHandle = await open(rootDir, 'r')
      try {
        await rootHandle.sync()
      } finally {
        await rootHandle.close()
      }
    }

    await activeTestHooks?.afterDirFsync?.()

    // Post-publish directory dev/ino verification
    const postRoot = await getDirectoryIdentity(rootDir)
    if (postRoot.dev !== preRootIdentity.dev || postRoot.ino !== preRootIdentity.ino) {
      throw new ProtocolValidationError()
    }
    const postDir = dirPath === rootDir ? postRoot : await getDirectoryIdentity(dirPath)
    if (postDir.dev !== preDirIdentity.dev || postDir.ino !== preDirIdentity.ino) {
      throw new ProtocolValidationError()
    }

    // Post-publish readback using O_NOFOLLOW
    const targetHandle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const targetStat = await targetHandle.stat()
      if (!targetStat.isFile() || (targetStat.mode & 0o777) !== 0o600) {
        throw new ProtocolValidationError()
      }
      const readback = await targetHandle.readFile({ encoding: 'utf8' })
      if (activeTestHooks?.simulateReadbackMismatch || readback !== content) {
        throw new ProtocolValidationError()
      }
    } finally {
      await targetHandle.close()
    }
  } catch {
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
    if (tempCreated) {
      try {
        await unlink(tempFile)
      } catch {}
    }
    // If published is true, targetPath is intentionally NOT unlinked or rolled back (Requirement 6)
    throw new ProtocolValidationError()
  }
}

export async function persistExecutionClaim(
  persistenceRoot: string,
  claim: RealCanaryExecutionClaim
): Promise<void> {
  validateRealCanaryExecutionClaim(claim)
  if (!/^execution_[a-z0-9]{32}$/.test(claim.execution_id)) {
    throw new ProtocolValidationError()
  }

  const normalizedRoot = await verifyPersistenceRoot(persistenceRoot, claim.execution_root_sha256)
  const claimsDir = await ensureSubdirectory(normalizedRoot, 'claims')
  await safeWriteFileNoOverwrite(normalizedRoot, claimsDir, `${claim.execution_id}.json`, canonicalBytes(claim))
}

export async function persistReceipt(
  persistenceRoot: string,
  expectedRootHash: string,
  receipt: RealCanaryReceipt
): Promise<void> {
  validateRealCanaryReceipt(receipt)
  if (!/^run_[a-z0-9]{16}$/.test(receipt.run_id)) {
    throw new ProtocolValidationError()
  }

  const normalizedRoot = await verifyPersistenceRoot(persistenceRoot, expectedRootHash)
  const receiptsDir = await ensureSubdirectory(normalizedRoot, 'receipts')
  await safeWriteFileNoOverwrite(normalizedRoot, receiptsDir, `${receipt.run_id}.json`, canonicalBytes(receipt))
}

export async function persistSummary(
  persistenceRoot: string,
  expectedRootHash: string,
  summary: RealCanarySummary
): Promise<void> {
  validateRealCanarySummary(summary)
  const normalizedRoot = await verifyPersistenceRoot(persistenceRoot, expectedRootHash)
  await safeWriteFileNoOverwrite(normalizedRoot, normalizedRoot, 'summary.json', canonicalBytes(summary))
}
