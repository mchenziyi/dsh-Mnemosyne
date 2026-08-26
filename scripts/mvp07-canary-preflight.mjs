#!/usr/bin/env node
import { executeCanaryPreflight } from '../src/m07/preflight.js'

const PREFLIGHT_ERROR_ALLOWLIST = new Set([
  'duplicate_argument',
  'missing_tarball_argument_value',
  'unknown_argument',
  'dry_run_flag_required',
  'tarball_path_required',
  'tarball_must_be_absolute_path',
  'tarball_file_not_found',
  'tarball_cannot_be_symlink',
  'tarball_must_be_regular_file',
  'tarball_read_failed',
  'tarball_file_count_invalid',
  'tarball_contains_duplicate_entries',
  'tarball_missing_required_files',
  'tarball_contains_unexpected_files',
  'tarball_manifest_read_failed',
  'tarball_manifest_invalid_json',
  'invalid_package_name_in_tarball',
  'invalid_package_version_in_tarball',
  'missing_dsh_bundle_patch_in_tarball',
  'dsh_cli_unavailable',
  'unsupported_dsh_version',
  'invalid_plan_id',
])

class PreflightError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PreflightError'
    this.code = PREFLIGHT_ERROR_ALLOWLIST.has(code) ? code : 'preflight_failed'
  }
}

function mapPreflightError(err) {
  const code =
    err instanceof PreflightError
      ? err.code
      : err instanceof Error
        ? err.message
        : ''
  if (PREFLIGHT_ERROR_ALLOWLIST.has(code)) {
    return code
  }
  return 'preflight_failed'
}

function parseArgs(argv) {
  const flags = new Map()
  let isJson = false
  let isDryRun = false
  let tarballPath = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      if (flags.has('--json')) throw new PreflightError('duplicate_argument')
      flags.set('--json', '')
      isJson = true
    } else if (arg === '--dry-run') {
      if (flags.has('--dry-run')) throw new PreflightError('duplicate_argument')
      flags.set('--dry-run', '')
      isDryRun = true
    } else if (arg === '--tarball') {
      if (flags.has('--tarball')) throw new PreflightError('duplicate_argument')
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new PreflightError('missing_tarball_argument_value')
      }
      tarballPath = argv[++i]
      flags.set('--tarball', tarballPath)
    } else {
      throw new PreflightError('unknown_argument')
    }
  }

  if (!isDryRun) throw new PreflightError('dry_run_flag_required')
  if (!tarballPath) throw new PreflightError('tarball_path_required')

  return { isJson, isDryRun, tarballPath }
}

async function main() {
  let isJson = process.argv.includes('--json')
  try {
    const parsed = parseArgs(process.argv.slice(2))
    isJson = parsed.isJson

    const result = await executeCanaryPreflight({
      tarballPath: parsed.tarballPath,
      isDryRun: parsed.isDryRun,
    })

    if (isJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      process.stdout.write(`Canary Preflight: ${result.status}\n`)
      process.stdout.write(`Package SHA256: ${result.package_sha256}\n`)
      process.stdout.write(`Plan SHA256: ${result.plan_sha256}\n`)
      process.stdout.write(`Model Requests: ${result.model_calls_executed}\n`)
    }
    process.exitCode = 0
  } catch (err) {
    const reasonCode = mapPreflightError(err)
    if (isJson) {
      process.stdout.write(JSON.stringify({ status: 'fail', reason_code: reasonCode }, null, 2) + '\n')
    } else {
      process.stderr.write(`Preflight failed: ${reasonCode}\n`)
    }
    process.exitCode = 1
  }
}

await main()
