import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validateExecutionWorld,
  type ReconstructedWorldFacts,
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

const MAX_JSON_FILE_SIZE = 1024 * 1024 // 1MB

export class PreflightCliError extends Error {
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
  now: string
  isJson: boolean
}

const ALLOWED_FLAGS = new Set([
  '--audit',
  '--plan',
  '--authorization',
  '--approval',
  '--persistence-root',
  '--workspace-root',
  '--now',
  '--json',
])

function parseCliArgs(argv: string[]): ParsedArgs {
  const flagsMap = new Map<string, string>()
  let isJson = false
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]
    if (!arg.startsWith('--') || !ALLOWED_FLAGS.has(arg)) {
      throw new PreflightCliError('unknown_argument')
    }
    if (arg === '--json') {
      if (isJson) {
        throw new PreflightCliError('duplicate_argument')
      }
      isJson = true
      i++
      continue
    }
    if (flagsMap.has(arg)) {
      throw new PreflightCliError('duplicate_argument')
    }
    if (i + 1 >= argv.length) {
      throw new PreflightCliError('missing_argument_value')
    }
    const val = argv[i + 1]
    if (val.startsWith('--')) {
      throw new PreflightCliError('missing_argument_value')
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
  const now = flagsMap.get('--now')

  if (
    !auditPath ||
    !planPath ||
    !authPath ||
    !approvalPath ||
    !persistenceRoot ||
    !workspaceRoot ||
    !now
  ) {
    throw new PreflightCliError('missing_required_argument')
  }

  const pathsToCheck = [
    auditPath,
    planPath,
    authPath,
    approvalPath,
    persistenceRoot,
    workspaceRoot,
  ]
  for (const p of pathsToCheck) {
    if (!isAbsolute(p) || p.split(sep).includes('..')) {
      throw new PreflightCliError('relative_path_rejected')
    }
  }

  try {
    assertRfc3339Utc(now)
  } catch {
    throw new PreflightCliError('invalid_now_timestamp')
  }

  return {
    auditPath,
    planPath,
    authPath,
    approvalPath,
    persistenceRoot,
    workspaceRoot,
    now,
    isJson,
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let fh
  try {
    fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err: any) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK' || err.code === 'EISDIR')) {
      throw new PreflightCliError('invalid_file_type')
    }
    throw new PreflightCliError('file_read_error')
  }

  let content: string
  try {
    let stat
    try {
      stat = await fh.stat()
    } catch {
      throw new PreflightCliError('file_read_error')
    }

    if (!stat.isFile()) {
      throw new PreflightCliError('invalid_file_type')
    }

    if (stat.size > MAX_JSON_FILE_SIZE) {
      throw new PreflightCliError('oversized_file')
    }

    try {
      content = await fh.readFile({ encoding: 'utf8' })
    } catch {
      throw new PreflightCliError('file_read_error')
    }
  } finally {
    await fh.close().catch(() => {})
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new PreflightCliError('malformed_json')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PreflightCliError('invalid_json_object')
  }

  return parsed
}

export async function runRealCanaryPreflight(options: {
  audit: ProviderCompatibilityAudit
  plan: RealCanaryPlan
  authorization: RealCanaryAuthorizationRequest
  approval: RealCanaryApprovalReceipt
  now: string
  persistence_root: string
  workspace_root: string
}): Promise<ReconstructedWorldFacts & { status: 'ready' }> {
  const worldFacts = await validateExecutionWorld({
    audit: options.audit,
    plan: options.plan,
    authorization: options.authorization,
    approval: options.approval,
    now: options.now,
    persistence_root: options.persistence_root,
    workspace_root: options.workspace_root,
  })

  await verifyPersistenceRoot(options.persistence_root, options.approval.execution_root_sha256)

  return {
    ...worldFacts,
    status: 'ready',
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let isJson = false
  try {
    isJson = argv.includes('--json')
    const parsedArgs = parseCliArgs(argv)
    isJson = parsedArgs.isJson

    const rawAudit = await readJsonFile(parsedArgs.auditPath)
    let audit: ProviderCompatibilityAudit
    try {
      audit = validateProviderCompatibilityAudit(rawAudit)
    } catch {
      throw new PreflightCliError('invalid_audit_object')
    }

    const rawPlan = await readJsonFile(parsedArgs.planPath)
    let plan: RealCanaryPlan
    try {
      plan = validateRealCanaryPlan(rawPlan)
    } catch {
      throw new PreflightCliError('invalid_plan_object')
    }

    const rawAuth = await readJsonFile(parsedArgs.authPath)
    let authorization: RealCanaryAuthorizationRequest
    try {
      authorization = validateRealCanaryAuthorizationRequest(rawAuth)
    } catch {
      throw new PreflightCliError('invalid_authorization_object')
    }

    const rawApproval = await readJsonFile(parsedArgs.approvalPath)
    let approval: RealCanaryApprovalReceipt
    try {
      approval = validateRealCanaryApprovalReceipt(rawApproval)
    } catch {
      throw new PreflightCliError('invalid_approval_object')
    }

    let worldFacts: ReconstructedWorldFacts
    try {
      worldFacts = await validateExecutionWorld({
        audit,
        plan,
        authorization,
        approval,
        now: parsedArgs.now,
        persistence_root: parsedArgs.persistenceRoot,
        workspace_root: parsedArgs.workspaceRoot,
      })
    } catch {
      throw new PreflightCliError('execution_world_mismatch')
    }

    try {
      await verifyPersistenceRoot(parsedArgs.persistenceRoot, approval.execution_root_sha256)
    } catch {
      throw new PreflightCliError('persistence_root_invalid')
    }

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            status: 'ready',
            audit_sha256: audit.audit_sha256,
            plan_sha256: plan.plan_sha256,
            authorization_sha256: authorization.authorization_sha256,
            approval_sha256: approval.approval_sha256,
            fixture_manifest_sha256: worldFacts.fixtureManifestSha256,
            m05e_plan_sha256: worldFacts.m05ePlanSha256,
            execution_root_sha256: approval.execution_root_sha256,
          },
          null,
          2
        )
      )
    } else {
      console.log('=== DSH Mnemosyne M0.5D-D2 Real Canary Preflight ===')
      console.log('Status: ready')
      console.log(`Audit SHA-256: ${audit.audit_sha256}`)
      console.log(`Plan SHA-256: ${plan.plan_sha256}`)
      console.log(`Authorization SHA-256: ${authorization.authorization_sha256}`)
      console.log(`Approval SHA-256: ${approval.approval_sha256}`)
      console.log(`Fixture Manifest SHA-256: ${worldFacts.fixtureManifestSha256}`)
      console.log(`M0.5E Plan SHA-256: ${worldFacts.m05ePlanSha256}`)
      console.log(`Execution Root SHA-256: ${approval.execution_root_sha256}`)
    }

    return 0
  } catch (err: unknown) {
    const reasonCode = err instanceof PreflightCliError ? err.reasonCode : 'preflight_failed'
    if (isJson) {
      console.error(JSON.stringify({ status: 'error', reason_code: reasonCode }))
    } else {
      console.error(`=== DSH Mnemosyne M0.5D-D2 Real Canary Preflight Error ===\nReason: ${reasonCode}`)
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
