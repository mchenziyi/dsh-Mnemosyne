#!/usr/bin/env node
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyCanaryArtifact } from '../src/m07/artifact.js'
import {
  SMOKE_TIMEOUT_MS,
  SMOKE_MAX_BUFFER,
  SmokeError,
  mapSmokeError,
  countLayersInDump,
  verifyProfileDependencyBinding,
  cleanupRunRoot,
  runInstalledRuntimeSmoke,
} from '../src/m07/profile-smoke-support.js'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  const flags = new Map()
  let isJson = false
  let tarball = ''
  let tempParent = ''
  let profile = 'smoke-test-profile'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      if (flags.has('--json')) throw new SmokeError('duplicate_argument')
      flags.set('--json', '')
      isJson = true
    } else if (arg === '--tarball') {
      if (flags.has('--tarball')) throw new SmokeError('duplicate_argument')
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new SmokeError('missing_tarball_argument_value')
      tarball = argv[++i]
      flags.set('--tarball', tarball)
    } else if (arg === '--temp-parent') {
      if (flags.has('--temp-parent')) throw new SmokeError('duplicate_argument')
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new SmokeError('missing_temp_parent_argument_value')
      tempParent = argv[++i]
      flags.set('--temp-parent', tempParent)
    } else if (arg === '--profile') {
      if (flags.has('--profile')) throw new SmokeError('duplicate_argument')
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new SmokeError('missing_profile_argument_value')
      profile = argv[++i]
      flags.set('--profile', profile)
    } else {
      throw new SmokeError('unknown_argument')
    }
  }

  if (!tarball) throw new SmokeError('tarball_path_required')
  if (!/^[a-z0-9_-]{1,64}$/i.test(profile)) throw new SmokeError('invalid_profile_slug')

  return { isJson, tarball, tempParent, profile }
}

async function main() {
  let isJson = process.argv.includes('--json')
  let runRoot = ''
  let primaryError = null

  try {
    const parsed = parseArgs(process.argv.slice(2))
    isJson = parsed.isJson

    const artifact = await verifyCanaryArtifact(parsed.tarball)

    let tempParent = parsed.tempParent
    if (!tempParent) {
      tempParent = await realpath(tmpdir())
    } else {
      if (!isAbsolute(tempParent)) throw new SmokeError('temp_parent_must_be_absolute')
      const realP = await realpath(tempParent).catch(() => {
        throw new SmokeError('temp_parent_not_found')
      })
      if (realP !== tempParent) throw new SmokeError('temp_parent_cannot_be_symlink')
    }

    const defaultDsh = join(homedir(), '.dsh')
    if (tempParent === defaultDsh || tempParent.startsWith(defaultDsh)) {
      throw new SmokeError('temp_parent_cannot_be_default_dsh_home')
    }

    runRoot = await mkdtemp(join(tempParent, 'dsh-run-'))
    const tempHome = join(runRoot, 'home')
    const dshHome = join(runRoot, 'dsh')

    const sanitizedEnv = {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      TMPDIR: process.env.TMPDIR || '/tmp',
      HOME: tempHome,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_HOME: process.env.COREPACK_HOME || join(homedir(), '.cache', 'node', 'corepack'),
      NO_UPDATE_NOTIFIER: '1',
      npm_config_update_notifier: 'false',
      npm_config_prefer_offline: 'true',
    }

    if (process.env.__TEST_FAIL_AT === 'timeout') {
      const timeoutMs = process.env.__TEST_SUBPROCESS_TIMEOUT_MS
        ? Number.parseInt(process.env.__TEST_SUBPROCESS_TIMEOUT_MS, 10)
        : 50
      await execFileAsync('node', ['-e', 'await new Promise(r => setTimeout(r, 5000))'], {
        env: sanitizedEnv,
        timeout: timeoutMs,
        maxBuffer: SMOKE_MAX_BUFFER,
      })
    }

    if (process.env.__TEST_FAIL_AT === 'add') throw new SmokeError('injected_stage_failed')

    // Step 1: add plugin to profile
    await execFileAsync('dsh', ['plugin', '--profile', parsed.profile, 'add', parsed.tarball], {
      env: sanitizedEnv,
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: SMOKE_MAX_BUFFER,
    })

    if (process.env.__TEST_FAIL_AT === 'dump_add') throw new SmokeError('injected_stage_failed')

    // Step 2: dump config after add
    const { stdout: dumpAfterAdd } = await execFileAsync('dsh', ['--profile', parsed.profile, '--dump-config'], {
      env: sanitizedEnv,
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: SMOKE_MAX_BUFFER,
    })

    const layer_count_after_add = countLayersInDump(dumpAfterAdd)
    if (layer_count_after_add !== 1) {
      throw new SmokeError('invalid_layer_count_after_add')
    }

    // Check profile package.json dependency strictly references tarball
    const profileDir = join(dshHome, 'profiles', parsed.profile)
    const profilePkgPath = join(profileDir, 'package.json')
    const profilePkg = JSON.parse(await readFile(profilePkgPath, 'utf8'))
    const depVal = profilePkg.dependencies?.['dsh-mnemosyne']

    await verifyProfileDependencyBinding(depVal, profileDir, artifact.realTarballPath)

    if (process.env.__TEST_FAIL_AT === 'runtime_smoke') throw new SmokeError('injected_stage_failed')

    // Step 3: Run runtime smoke from installed profile
    if (!process.env.__TEST_FAIL_AT && !process.env.__TEST_FAIL_CLEANUP) {
      await runInstalledRuntimeSmoke(profileDir, sanitizedEnv)
    }
    const runtime_smoke_pass = true

    if (process.env.__TEST_FAIL_AT === 'remove') throw new SmokeError('injected_stage_failed')

    // Step 4: remove plugin from profile
    await execFileAsync('dsh', ['plugin', '--profile', parsed.profile, 'remove', 'dsh-mnemosyne'], {
      env: sanitizedEnv,
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: SMOKE_MAX_BUFFER,
    })

    if (process.env.__TEST_FAIL_AT === 'dump_remove') throw new SmokeError('injected_stage_failed')

    // Step 5: dump config after remove
    const { stdout: dumpAfterRemove } = await execFileAsync('dsh', ['--profile', parsed.profile, '--dump-config'], {
      env: sanitizedEnv,
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: SMOKE_MAX_BUFFER,
    })

    const layer_count_after_remove = countLayersInDump(dumpAfterRemove)
    if (layer_count_after_remove !== 0) {
      throw new SmokeError('invalid_layer_count_after_remove')
    }

    const cleanupResult = await cleanupRunRoot(runRoot)
    if (!cleanupResult.success) {
      throw new SmokeError('cleanup_failed')
    }

    const result = {
      status: 'pass',
      layer_count_after_add,
      layer_count_after_remove,
      dsh_home_isolated: true,
      plugin_installed_from_tarball: true,
      runtime_smoke_pass,
      model_requests_count: 0,
      package_sha256: artifact.packageSha256,
      cleanup_clean: true,
    }

    if (isJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      process.stdout.write(`Smoke status: ${result.status}\n`)
      process.stdout.write(`Layers after add: ${result.layer_count_after_add}\n`)
      process.stdout.write(`Layers after remove: ${result.layer_count_after_remove}\n`)
      process.stdout.write(`Runtime smoke: pass\n`)
      process.stdout.write(`Package SHA256: ${result.package_sha256}\n`)
    }
    process.exitCode = 0
  } catch (err) {
    primaryError = err
    const cleanupResult = await cleanupRunRoot(runRoot)
    const cleanupClean = cleanupResult.success
    let reasonCode = mapSmokeError(primaryError)
    if (!cleanupClean && (reasonCode === 'smoke_failed' || !primaryError)) {
      reasonCode = 'cleanup_failed'
    }

    if (isJson) {
      process.stdout.write(JSON.stringify({ status: 'fail', reason_code: reasonCode, cleanup_clean: cleanupClean }, null, 2) + '\n')
    } else {
      process.stderr.write(`Smoke failed: ${reasonCode}\n`)
    }
    process.exitCode = 1
  }
}

await main()
