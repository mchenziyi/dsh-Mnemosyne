import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { computePlanSha256, createCanaryPlan } from './canary-schema.js'
import { verifyCanaryArtifact } from './artifact.js'

const execFileAsync = promisify(execFile)

export async function executeCanaryPreflight(options) {
  if (!options || options.isDryRun !== true) {
    throw new Error('dry_run_flag_required')
  }

  const { tarballPath } = options
  const artifact = await verifyCanaryArtifact(tarballPath)

  // Execute dsh --version (fail-closed if command unavailable or error)
  let dsh_version = ''
  try {
    const { stdout } = await execFileAsync('dsh', ['--version'], {
      timeout: 10000,
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
        TMPDIR: process.env.TMPDIR || '/tmp',
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
    })
    dsh_version = stdout.trim()
  } catch {
    throw new Error('dsh_cli_unavailable')
  }

  if (dsh_version !== '0.1.1-rc.2') {
    throw new Error('unsupported_dsh_version')
  }

  const plan = createCanaryPlan({
    tarball_sha256: artifact.packageSha256,
    knowledge: {
      topic: 'Aurora component envelope',
      canary_fact: 'Aurora component uses amber envelope format verified as aurora-envelope-v1.',
    },
  })
  const plan_sha256 = computePlanSha256(plan)

  return {
    status: 'awaiting_user_approval',
    package_name: artifact.packageName,
    package_version: artifact.packageVersion,
    dsh_version: '0.1.1-rc.2',
    package_sha256: artifact.packageSha256,
    plan_id: plan.plan_id,
    plan_sha256,
    budget: plan.budget,
    model_calls_executed: 0,
    mode: 'dry_run',
  }
}
