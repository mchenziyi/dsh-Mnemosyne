import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import {
  runRealCanaryD2,
  validateExecutionWorld,
  type RealCanarySummary,
} from '../src/m05d2/runner.js'
import { verifyPersistenceRoot } from '../src/m05d2/persistence.js'
import {
  validateRealCanaryApprovalReceipt,
  type RealCanaryApprovalReceipt,
} from '../src/m05d2/approval.js'
import {
  validateRealCanaryAuthorizationRequest,
  validateRealCanaryPlan,
  type RealCanaryAuthorizationRequest,
  type RealCanaryPlan,
} from '../src/m05f/authorization.js'
import {
  assertRfc3339Utc,
  validateProviderCompatibilityAudit,
  type ProviderCompatibilityAudit,
} from '../src/m05f/provider-audit.js'
import type { CredentialSeamInstaller } from '../src/m05d2/provider-factory.js'

const MAX_JSON_FILE_SIZE = 1024 * 1024 // 1MB

export class ExecutionCliError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode)
  }
}

interface ParsedArgs {
  auditPath: string
  planPath: string
  authPath: string
  approvalPath: string
  persistenceRoot: string
  workspaceRoot: string
  isolationRoot: string
  credentialStore: string
  now: string
  confirmApprovalSha256: string
  isExecute: boolean
  isJson: boolean
}

const ALLOWED_FLAGS = new Set([
  '--audit',
  '--plan',
  '--authorization',
  '--approval',
  '--persistence-root',
  '--workspace-root',
  '--isolation-root',
  '--credential-store',
  '--now',
  '--confirm-approval-sha256',
  '--execute',
  '--json',
])

function parseCliArgs(argv: string[]): ParsedArgs {
  const flagsMap = new Map<string, string>()
  let isExecute = false
  let isJson = false
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]
    if (!arg.startsWith('--') || !ALLOWED_FLAGS.has(arg)) {
      throw new ExecutionCliError('unknown_argument')
    }
    if (arg === '--execute') {
      if (isExecute) {
        throw new ExecutionCliError('duplicate_argument')
      }
      isExecute = true
      i++
      continue
    }
    if (arg === '--json') {
      if (isJson) {
        throw new ExecutionCliError('duplicate_argument')
      }
      isJson = true
      i++
      continue
    }
    if (flagsMap.has(arg)) {
      throw new ExecutionCliError('duplicate_argument')
    }
    if (i + 1 >= argv.length) {
      throw new ExecutionCliError('missing_argument_value')
    }
    const val = argv[i + 1]
    if (val.startsWith('--')) {
      throw new ExecutionCliError('missing_argument_value')
    }
    flagsMap.set(arg, val)
    i += 2
  }

  const auditPath = flagsMap.get('--audit')
  const planPath = flagsMap.get('--plan')
  const authPath = flagsMap.get('--authorization')
  const approvalPath = flagsMap.get('--approval')
  const persistenceRoot = flagsMap.get('--persistence-root')
  const workspaceRoot = flagsMap.get('--workspace-root')
  const isolationRoot = flagsMap.get('--isolation-root')
  const credentialStore = flagsMap.get('--credential-store')
  const now = flagsMap.get('--now')
  const confirmApprovalSha256 = flagsMap.get('--confirm-approval-sha256')

  if (
    !auditPath ||
    !planPath ||
    !authPath ||
    !approvalPath ||
    !persistenceRoot ||
    !workspaceRoot ||
    !isolationRoot ||
    !credentialStore ||
    !now ||
    !confirmApprovalSha256
  ) {
    throw new ExecutionCliError('missing_required_argument')
  }

  if (!isExecute) {
    throw new ExecutionCliError('execution_not_confirmed')
  }

  const pathsToCheck = [
    auditPath,
    planPath,
    authPath,
    approvalPath,
    persistenceRoot,
    workspaceRoot,
    isolationRoot,
    credentialStore,
  ]
  for (const p of pathsToCheck) {
    if (!isAbsolute(p) || p.split(sep).includes('..') || normalize(p).split(sep).includes('..')) {
      throw new ExecutionCliError('relative_path_rejected')
    }
  }

  try {
    assertRfc3339Utc(now)
  } catch {
    throw new ExecutionCliError('invalid_now_timestamp')
  }

  return {
    auditPath,
    planPath,
    authPath,
    approvalPath,
    persistenceRoot,
    workspaceRoot,
    isolationRoot,
    credentialStore,
    now,
    confirmApprovalSha256,
    isExecute,
    isJson,
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let fh
  try {
    fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err: any) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK' || err.code === 'EISDIR')) {
      throw new ExecutionCliError('invalid_file_type')
    }
    throw new ExecutionCliError('file_read_error')
  }

  let content: string
  try {
    let stat
    try {
      stat = await fh.stat()
    } catch {
      throw new ExecutionCliError('file_read_error')
    }

    if (!stat.isFile()) {
      throw new ExecutionCliError('invalid_file_type')
    }

    if (stat.size > MAX_JSON_FILE_SIZE) {
      throw new ExecutionCliError('oversized_file')
    }

    try {
      content = await fh.readFile({ encoding: 'utf8' })
    } catch {
      throw new ExecutionCliError('file_read_error')
    }
  } finally {
    await fh.close().catch(() => {})
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ExecutionCliError('malformed_json')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExecutionCliError('invalid_json_object')
  }

  return parsed
}

async function validateCredentialStorePath(
  credentialStore: string,
  workspaceRoot: string
): Promise<string> {
  const normCred = normalize(resolve(credentialStore))
  const credFilename = basename(normCred)
  if (credFilename !== '.credentials.yaml') {
    throw new ExecutionCliError('credential_store_invalid')
  }

  const credDir = dirname(normCred)
  const normWs = normalize(resolve(workspaceRoot))
  const normCwd = normalize(resolve(process.cwd()))

  // Must not be inside workspace or repository
  if (
    credDir === normWs ||
    credDir.startsWith(normWs + sep) ||
    credDir === normCwd ||
    credDir.startsWith(normCwd + sep)
  ) {
    throw new ExecutionCliError('credential_store_invalid')
  }

  // Validate directory hierarchy
  const segments = credDir.split(sep).filter(Boolean)
  let curr = credDir.startsWith(sep) ? sep : ''
  for (let i = 0; i < segments.length; i++) {
    curr = join(curr, segments[i])
    try {
      const stat = await lstat(curr)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ExecutionCliError('credential_store_invalid')
      }
      if ((stat.mode & 0o022) !== 0) {
        throw new ExecutionCliError('credential_store_invalid')
      }
      if (i === segments.length - 1) {
        if ((stat.mode & 0o777) !== 0o700) {
          throw new ExecutionCliError('credential_store_invalid')
        }
      }
    } catch {
      throw new ExecutionCliError('credential_store_invalid')
    }
  }

  // Validate file itself (regular file, not symlink, 0600 mode)
  try {
    const fileStat = await lstat(normCred)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new ExecutionCliError('credential_store_invalid')
    }
    if ((fileStat.mode & 0o777) !== 0o600) {
      throw new ExecutionCliError('credential_store_invalid')
    }
  } catch {
    throw new ExecutionCliError('credential_store_invalid')
  }

  return normCred
}

export async function executeRealCanaryCli(options: {
  audit: ProviderCompatibilityAudit
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
  approval: RealCanaryApprovalReceipt
  now: string
  persistence_root: string
  workspace_root: string
  isolation_root: string
  credential_store: string
  confirm_approval_sha256: string
  is_execute: boolean
}): Promise<RealCanarySummary> {
  if (!options.is_execute) {
    throw new ExecutionCliError('execution_not_confirmed')
  }

  if (options.confirm_approval_sha256 !== options.approval.approval_sha256) {
    throw new ExecutionCliError('confirm_approval_sha256_mismatch')
  }

  const normCredStore = await validateCredentialStorePath(
    options.credential_store,
    options.workspace_root
  )

  try {
    await verifyPersistenceRoot(options.persistence_root, options.approval.execution_root_sha256)
  } catch {
    throw new ExecutionCliError('persistence_root_invalid')
  }

  // Isolation root must not exist beforehand
  try {
    const isoStat = await lstat(options.isolation_root)
    if (isoStat) {
      throw new ExecutionCliError('isolation_root_exists')
    }
  } catch (err: any) {
    if (err instanceof ExecutionCliError) throw err
    if (err?.code !== 'ENOENT') {
      throw new ExecutionCliError('isolation_root_exists')
    }
  }

  try {
    await validateExecutionWorld({
      audit: options.audit,
      plan: options.plan,
      authorization: options.authorization,
      approval: options.approval,
      now: options.now,
      persistence_root: options.persistence_root,
      workspace_root: options.workspace_root,
    })
  } catch {
    throw new ExecutionCliError('execution_world_mismatch')
  }

  const credentialProvider: CredentialSeamInstaller = async (ctx: Context) => {
    await ctx.plugin(LocalCredentialProvider, {
      path: normCredStore,
      watch: false,
    })
  }

  return await runRealCanaryD2({
    audit: options.audit,
    plan: options.plan,
    authorization: options.authorization,
    approval: options.approval,
    now: options.now,
    persistence_root: options.persistence_root,
    isolation_root: options.isolation_root,
    workspace_root: options.workspace_root,
    credentialProvider,
    requiredCredentialSource: 'file',
  })
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let isJson = false
  try {
    isJson = argv.includes('--json')
    const parsed = parseCliArgs(argv)
    isJson = parsed.isJson

    const rawAudit = await readJsonFile(parsed.auditPath)
    let audit: ProviderCompatibilityAudit
    try {
      audit = validateProviderCompatibilityAudit(rawAudit)
    } catch {
      throw new ExecutionCliError('invalid_audit_object')
    }

    const rawPlan = await readJsonFile(parsed.planPath)
    let plan: RealCanaryPlan
    try {
      plan = validateRealCanaryPlan(rawPlan)
    } catch {
      throw new ExecutionCliError('invalid_plan_object')
    }

    const rawAuth = await readJsonFile(parsed.authPath)
    let authorization: RealCanaryAuthorizationRequest
    try {
      authorization = validateRealCanaryAuthorizationRequest(rawAuth)
    } catch {
      throw new ExecutionCliError('invalid_authorization_object')
    }

    const rawApproval = await readJsonFile(parsed.approvalPath)
    let approval: RealCanaryApprovalReceipt
    try {
      approval = validateRealCanaryApprovalReceipt(rawApproval)
    } catch {
      throw new ExecutionCliError('invalid_approval_object')
    }

    const summary = await executeRealCanaryCli({
      audit,
      plan,
      authorization,
      approval,
      now: parsed.now,
      persistence_root: parsed.persistenceRoot,
      workspace_root: parsed.workspaceRoot,
      isolation_root: parsed.isolationRoot,
      credential_store: parsed.credentialStore,
      confirm_approval_sha256: parsed.confirmApprovalSha256,
      is_execute: parsed.isExecute,
    })

    if (isJson) {
      const failureCategories = [
        ...new Set((summary.failure_diagnostics ?? []).map((d) => d.category)),
      ].sort()
      console.log(
        JSON.stringify(
          {
            status: summary.status,
            authorization_sha256: summary.authorization_sha256,
            approval_sha256: summary.approval_sha256,
            summary_sha256: summary.summary_sha256,
            receipts_count: summary.receipts.length,
            ledger: summary.ledger,
            reason_code: summary.reason_code,
            failure_categories: failureCategories,
            cleanup_clean: summary.cleanup_clean,
          },
          null,
          2
        )
      )
    } else {
      console.log('=== DSH Mnemosyne M0.5D-D2 Real Canary Execution ===')
      console.log(`Status: ${summary.status}`)
      console.log(`Authorization SHA-256: ${summary.authorization_sha256}`)
      console.log(`Approval SHA-256: ${summary.approval_sha256}`)
      console.log(`Summary SHA-256: ${summary.summary_sha256}`)
      console.log(`Receipts Count: ${summary.receipts.length}`)
      console.log(`Reason Code: ${summary.reason_code ?? 'none'}`)
      console.log(`Cleanup Clean: ${summary.cleanup_clean}`)
    }

    return summary.status === 'real_provider_plumbing_pass' ? 0 : 1
  } catch (err: unknown) {
    const reasonCode = err instanceof ExecutionCliError ? err.reasonCode : 'execution_failed'
    if (isJson) {
      console.error(JSON.stringify({ status: 'error', reason_code: reasonCode }))
    } else {
      console.error(`=== DSH Mnemosyne M0.5D-D2 Real Canary Execution Error ===\nReason: ${reasonCode}`)
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
