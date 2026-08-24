import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, unlink, link } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalBytes, ProtocolValidationError, sha256 } from '../src/protocol/canonical.js'
import { verifyPersistenceRoot } from '../src/m05d2/persistence.js'
import {
  createRealCanaryApprovalReceipt,
  validateRealCanaryApprovalReceipt,
  type RealCanaryApprovalReceipt,
} from '../src/m05d2/approval.js'
import {
  validateRealCanaryAuthorizationRequest,
  type RealCanaryAuthorizationRequest,
} from '../src/m05f/authorization.js'
import { assertRfc3339Utc } from '../src/m05f/provider-audit.js'

const MAX_JSON_FILE_SIZE = 1024 * 1024 // 1MB

export class ApprovalCliError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode)
  }
}

interface ParsedArgs {
  authPath: string
  persistenceRoot: string
  decision: 'approved' | 'rejected'
  subjectId: string
  now: string
  outputPath: string
  isJson: boolean
}

const ALLOWED_FLAGS = new Set([
  '--authorization',
  '--persistence-root',
  '--decision',
  '--subject-id',
  '--now',
  '--output',
  '--json',
])

function parseCliArgs(argv: string[]): ParsedArgs {
  const flagsMap = new Map<string, string>()
  let isJson = false
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]
    if (!arg.startsWith('--') || !ALLOWED_FLAGS.has(arg)) {
      throw new ApprovalCliError('unknown_argument')
    }
    if (arg === '--json') {
      if (isJson) {
        throw new ApprovalCliError('duplicate_argument')
      }
      isJson = true
      i++
      continue
    }
    if (flagsMap.has(arg)) {
      throw new ApprovalCliError('duplicate_argument')
    }
    if (i + 1 >= argv.length) {
      throw new ApprovalCliError('missing_argument_value')
    }
    const val = argv[i + 1]
    if (val.startsWith('--')) {
      throw new ApprovalCliError('missing_argument_value')
    }
    flagsMap.set(arg, val)
    i += 2
  }

  const authPath = flagsMap.get('--authorization')
  const persistenceRoot = flagsMap.get('--persistence-root')
  const decisionRaw = flagsMap.get('--decision')
  const subjectId = flagsMap.get('--subject-id')
  const now = flagsMap.get('--now')
  const outputPath = flagsMap.get('--output')

  if (
    !authPath ||
    !persistenceRoot ||
    !decisionRaw ||
    !subjectId ||
    !now ||
    !outputPath
  ) {
    throw new ApprovalCliError('missing_required_argument')
  }

  if (decisionRaw !== 'approved' && decisionRaw !== 'rejected') {
    throw new ApprovalCliError('invalid_decision')
  }
  const decision: 'approved' | 'rejected' = decisionRaw

  const pathsToCheck = [authPath, persistenceRoot, outputPath]
  for (const p of pathsToCheck) {
    if (!isAbsolute(p) || p.split(sep).includes('..') || normalize(p).split(sep).includes('..')) {
      throw new ApprovalCliError('relative_path_rejected')
    }
  }

  try {
    assertRfc3339Utc(now)
  } catch {
    throw new ApprovalCliError('invalid_now_timestamp')
  }

  if (!/^[a-z0-9_-]{1,64}$/i.test(subjectId)) {
    throw new ApprovalCliError('invalid_subject_id')
  }

  return {
    authPath,
    persistenceRoot,
    decision,
    subjectId,
    now,
    outputPath,
    isJson,
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let fh
  try {
    fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err: any) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK' || err.code === 'EISDIR')) {
      throw new ApprovalCliError('invalid_file_type')
    }
    throw new ApprovalCliError('file_read_error')
  }

  let content: string
  try {
    let stat
    try {
      stat = await fh.stat()
    } catch {
      throw new ApprovalCliError('file_read_error')
    }

    if (!stat.isFile()) {
      throw new ApprovalCliError('invalid_file_type')
    }

    if (stat.size > MAX_JSON_FILE_SIZE) {
      throw new ApprovalCliError('oversized_file')
    }

    try {
      content = await fh.readFile({ encoding: 'utf8' })
    } catch {
      throw new ApprovalCliError('file_read_error')
    }
  } finally {
    await fh.close().catch(() => {})
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ApprovalCliError('malformed_json')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApprovalCliError('invalid_json_object')
  }

  return parsed
}

export interface ApprovalInternalTestHooks {
  beforePublishLink?: () => Promise<void> | void
  afterPublishLink?: () => Promise<void> | void
}

let activeTestHooks: ApprovalInternalTestHooks | null = null

export function __setApprovalTestHooksForTest(hooks: ApprovalInternalTestHooks | null): void {
  activeTestHooks = hooks
}

interface DirectoryIdentity {
  dev: number
  ino: number
}

async function getDirectoryIdentity(dirPath: string): Promise<DirectoryIdentity> {
  try {
    const stat = await lstat(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ApprovalCliError('output_path_invalid')
    }
    return { dev: stat.dev, ino: stat.ino }
  } catch (err) {
    if (err instanceof ApprovalCliError) throw err
    throw new ApprovalCliError('output_path_invalid')
  }
}

async function validateOutputDirAncestors(dirPath: string): Promise<void> {
  const normalized = normalize(resolve(dirPath))
  const segments = normalized.split(sep).filter(Boolean)
  let curr = normalized.startsWith(sep) ? sep : ''

  for (let i = 0; i < segments.length; i++) {
    curr = join(curr, segments[i])
    try {
      const stat = await lstat(curr)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ApprovalCliError('output_path_invalid')
      }
    } catch (err) {
      if (err instanceof ApprovalCliError) throw err
      throw new ApprovalCliError('output_path_invalid')
    }
  }
}

async function writeApprovalFileNoOverwrite(
  outputPath: string,
  approval: RealCanaryApprovalReceipt
): Promise<void> {
  const normOutput = normalize(resolve(outputPath))
  const outputDir = dirname(normOutput)

  // 1. Component-by-component lstat rejecting any ancestor symlink / non-directory
  await validateOutputDirAncestors(outputDir)

  // 2. Check target file does not already exist
  try {
    const targetStat = await lstat(normOutput)
    if (targetStat) {
      throw new ApprovalCliError('output_file_exists')
    }
  } catch (err: any) {
    if (err instanceof ApprovalCliError) throw err
    if (err?.code !== 'ENOENT') {
      throw new ApprovalCliError('output_path_invalid')
    }
  }

  // Pre-publish directory identity
  const preDirIdentity = await getDirectoryIdentity(outputDir)

  const content = canonicalBytes(approval)
  const nonce = randomUUID()
  const tempFile = join(outputDir, `.tmp_approval_${nonce}`)
  let tempCreated = false
  let published = false
  let handle: import('node:fs/promises').FileHandle | null = null

  try {
    handle = await open(tempFile, 'wx', 0o600).catch(() => {
      throw new ApprovalCliError('output_path_invalid')
    })
    tempCreated = true

    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null

    // Pre-publish check of temp file
    const tempStat = await lstat(tempFile)
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || (tempStat.mode & 0o777) !== 0o600) {
      throw new ApprovalCliError('output_path_invalid')
    }

    await activeTestHooks?.beforePublishLink?.()

    // Pre-publish re-verification of directory identity
    const currDir = await getDirectoryIdentity(outputDir)
    if (currDir.dev !== preDirIdentity.dev || currDir.ino !== preDirIdentity.ino) {
      throw new ApprovalCliError('output_path_invalid')
    }

    // Publish atomically via POSIX link (fails if target already exists)
    try {
      await link(tempFile, normOutput)
      published = true
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        throw new ApprovalCliError('output_file_exists')
      }
      throw new ApprovalCliError('output_path_invalid')
    }

    await unlink(tempFile).catch(() => {})
    tempCreated = false

    await activeTestHooks?.afterPublishLink?.()

    // Fsync parent directory
    const dirHandle = await open(outputDir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }

    // Post-publish directory dev/ino verification
    const postDir = await getDirectoryIdentity(outputDir)
    if (postDir.dev !== preDirIdentity.dev || postDir.ino !== preDirIdentity.ino) {
      throw new ApprovalCliError('output_path_invalid')
    }

    // Post-publish readback using O_NOFOLLOW
    const targetHandle = await open(normOutput, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await targetHandle.stat()
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new ApprovalCliError('output_path_invalid')
      }
      const readback = await targetHandle.readFile({ encoding: 'utf8' })
      if (readback !== content) {
        throw new ApprovalCliError('output_path_invalid')
      }
    } finally {
      await targetHandle.close()
    }
  } catch (err) {
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
    // If published is true, normOutput is intentionally NOT unlinked or deleted! (CTO Review 8.2)
    if (err instanceof ApprovalCliError) throw err
    throw new ApprovalCliError('output_path_invalid')
  }
}

export async function createRealCanaryApprovalCli(options: {
  authorization: RealCanaryAuthorizationRequest
  persistence_root: string
  decision: 'approved' | 'rejected'
  subject_id: string
  now: string
  output_path: string
}): Promise<RealCanaryApprovalReceipt> {
  const normPersistence = normalize(resolve(options.persistence_root))
  const executionRootSha256 = sha256(normPersistence)

  try {
    await verifyPersistenceRoot(normPersistence, executionRootSha256)
  } catch {
    throw new ApprovalCliError('persistence_root_invalid')
  }

  let approval: RealCanaryApprovalReceipt
  try {
    approval = createRealCanaryApprovalReceipt({
      authorization: options.authorization,
      decision: options.decision,
      decided_at: options.now,
      subject_id: options.subject_id,
      execution_root_sha256: executionRootSha256,
    })
  } catch {
    throw new ApprovalCliError('approval_creation_failed')
  }

  await writeApprovalFileNoOverwrite(options.output_path, approval)
  return approval
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let isJson = false
  try {
    isJson = argv.includes('--json')
    const parsed = parseCliArgs(argv)
    isJson = parsed.isJson

    const rawAuth = await readJsonFile(parsed.authPath)
    let authorization: RealCanaryAuthorizationRequest
    try {
      authorization = validateRealCanaryAuthorizationRequest(rawAuth)
    } catch {
      throw new ApprovalCliError('invalid_authorization_object')
    }

    const approval = await createRealCanaryApprovalCli({
      authorization,
      persistence_root: parsed.persistenceRoot,
      decision: parsed.decision,
      subject_id: parsed.subjectId,
      now: parsed.now,
      output_path: parsed.outputPath,
    })

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            status: 'created',
            approval_id: approval.approval_id,
            approval_sha256: approval.approval_sha256,
            authorization_sha256: approval.authorization_sha256,
            decision: approval.decision,
            subject_id: approval.subject_id,
            execution_root_sha256: approval.execution_root_sha256,
          },
          null,
          2
        )
      )
    } else {
      console.log('=== DSH Mnemosyne M0.5D-D2 Create Approval ===')
      console.log('Status: created')
      console.log(`Approval ID: ${approval.approval_id}`)
      console.log(`Approval SHA-256: ${approval.approval_sha256}`)
      console.log(`Authorization SHA-256: ${approval.authorization_sha256}`)
      console.log(`Decision: ${approval.decision}`)
      console.log(`Subject ID: ${approval.subject_id}`)
      console.log(`Execution Root SHA-256: ${approval.execution_root_sha256}`)
    }

    return 0
  } catch (err: unknown) {
    const reasonCode = err instanceof ApprovalCliError ? err.reasonCode : 'approval_failed'
    if (isJson) {
      console.error(JSON.stringify({ status: 'error', reason_code: reasonCode }))
    } else {
      console.error(`=== DSH Mnemosyne M0.5D-D2 Create Approval Error ===\nReason: ${reasonCode}`)
    }
    return 1
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) {
        process.exit(code)
      }
    })
    .catch(() => {
      process.exit(1)
    })
}
