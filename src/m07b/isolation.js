import { lstat, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, dirname, sep, relative } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { computeSha256 } from './canary-protocol.js'

export function isInsideOrSameDirectory(parentDir, targetPath) {
  if (!parentDir || !targetPath) return false
  const rel = relative(resolve(parentDir), resolve(targetPath))
  if (rel === '') return true
  if (!rel.startsWith('..') && !isAbsolute(rel)) return true
  return false
}

export async function resolveExecutableRealpath(executable) {
  if (!executable || typeof executable !== 'string') {
    throw new Error('invalid_executable')
  }
  let target = executable
  if (!target.includes('/') && !target.includes('\\')) {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync('which', [target])
      const found = stdout.trim().split('\n')[0]
      if (found) {
        target = found
      }
    } catch {}
  }
  return await realpath(target)
}

export function createSanitizedEnv(overrides = {}, baseEnv = process.env) {
  const forbiddenKeyPattern = /TOKEN|SECRET|CREDENTIAL|AUTHORIZATION|API_KEY|KEY/i
  const merged = { ...baseEnv, ...overrides }
  const clean = {}
  for (const [k, v] of Object.entries(merged)) {
    if (forbiddenKeyPattern.test(k)) continue
    if (['PATH', 'NODE_PATH', 'HOME', 'DSH_HOME', 'TMPDIR'].includes(k)) {
      clean[k] = v
    }
  }
  return clean
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isProcessGroupAlive(pid) {
  if (process.platform === 'win32') {
    return isProcessAlive(pid)
  }
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return isProcessAlive(pid)
  }
}

export async function killProcessGroup(pidOrChild, options = {}) {
  const pid = typeof pidOrChild === 'number' ? pidOrChild : pidOrChild?.pid
  if (!pid || typeof pid !== 'number') return

  const {
    graceMs = 300,
    pollIntervalMs = 50,
    maxWaitMs = 3000,
    isAliveForTesting,
  } = options

  const checkAlive = isAliveForTesting || isProcessGroupAlive

  // 1. Send SIGTERM to process group
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        process.kill(pid, 'SIGTERM')
      }
    } else {
      const { execFile } = await import('node:child_process')
      execFile('taskkill', ['/pid', String(pid), '/T'], () => {})
    }
  } catch {}

  // 2. Wait grace period while polling if alive
  const graceEnd = Date.now() + graceMs
  while (Date.now() < graceEnd) {
    if (!checkAlive(pid)) return
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  // 3. Send SIGKILL if still alive
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    } else {
      const { execFile } = await import('node:child_process')
      execFile('taskkill', ['/F', '/pid', String(pid), '/T'], () => {})
    }
  } catch {}

  // 4. Poll until group is completely dead or maxWaitMs reached
  const maxEnd = Date.now() + maxWaitMs
  while (Date.now() < maxEnd) {
    if (!checkAlive(pid)) return
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  // 5. Fail closed if process group is still alive
  if (checkAlive(pid)) {
    throw new Error('process_group_cleanup_failed')
  }
}

export async function spawnProcessGroup(executable, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = createSanitizedEnv(),
    timeout = 120000,
    maxBuffer = 1048576,
    killOptions = {},
  } = options

  let child
  let timer = null
  let timedOut = false
  let settled = false
  const stdoutChunks = []
  const stderrChunks = []
  let totalStdout = 0
  let totalStderr = 0

  let closeResolve
  const closePromise = new Promise((resolve) => {
    closeResolve = resolve
  })

  const promise = new Promise((resolvePromise, rejectPromise) => {
    const doResolve = (val) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(val)
    }

    const doReject = (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      rejectPromise(err)
    }

    try {
      child = spawn(executable, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return doReject(err)
    }

    const pid = child.pid

    if (timeout && timeout > 0) {
      timer = setTimeout(async () => {
        timedOut = true
        let killErr = null
        try {
          // 1. Send SIGTERM, wait grace period, send SIGKILL, wait for entire process group death
          await killProcessGroup(pid, killOptions)
          // 2. Wait for child close event
          await Promise.race([closePromise, new Promise((r) => setTimeout(r, 2000))])
        } catch (err) {
          killErr = err
        }

        if (killErr) {
          const err = new Error('process_group_cleanup_failed')
          err.killed = true
          err.timedOut = true
          doReject(err)
        } else {
          const err = new Error('subprocess_timeout')
          err.killed = true
          err.timedOut = true
          doReject(err)
        }
      }, timeout)
    }

    child.stdout?.on('data', (chunk) => {
      totalStdout += chunk.length
      if (totalStdout <= maxBuffer) {
        stdoutChunks.push(chunk)
      }
    })

    child.stderr?.on('data', (chunk) => {
      totalStderr += chunk.length
      if (totalStderr <= maxBuffer) {
        stderrChunks.push(chunk)
      }
    })

    child.on('error', async (err) => {
      try {
        await killProcessGroup(pid)
      } catch {}
      await Promise.race([closePromise, new Promise((r) => setTimeout(r, 1000))])
      doReject(err)
    })

    child.on('close', (code, signal) => {
      closeResolve({ code, signal })
      if (timedOut || settled) return
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (code === 0) {
        doResolve({ stdout, stderr, exitCode: 0 })
      } else {
        const err = new Error(`Process exited with code ${code} signal ${signal}`)
        err.stdout = stdout
        err.stderr = stderr
        err.exitCode = code
        err.signal = signal
        doReject(err)
      }
    })
  })

  return {
    promise,
    child,
    pid: child?.pid,
  }
}

async function verifyAncestorChain(targetDir) {
  const parts = targetDir.split(sep).filter(Boolean)
  let current = sep

  for (const part of parts) {
    current = join(current, part)
    const s = await lstat(current)
    if (s.isSymbolicLink()) {
      throw new Error('symlink_ancestor_rejected')
    }
    if (!s.isDirectory()) {
      throw new Error('non_directory_ancestor_rejected')
    }
    // Check group/other write permissions on created parent dirs
    // (except system root / tmp)
    if (current !== '/' && current !== '/tmp' && current !== '/private/tmp') {
      if ((s.mode & 0o002) !== 0) {
        throw new Error('insecure_parent_permissions')
      }
    }
  }
}

export async function setupRunRootLayout(parentDir, runRootName = `canary-run-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  if (!parentDir || !isAbsolute(parentDir)) {
    throw new Error('parent_dir_must_be_absolute')
  }

  const resolvedParent = resolve(parentDir)
  await verifyAncestorChain(resolvedParent)

  const rootPath = resolve(join(resolvedParent, runRootName))
  if (dirname(rootPath) !== resolvedParent) {
    throw new Error('path_traversal_rejected')
  }

  const rootIdentity = computeSha256(rootPath + ':' + Date.now() + ':' + Math.random())

  const homePath = join(rootPath, 'home')
  const dshHomePath = join(rootPath, 'dsh-home')
  const tmpPath = join(rootPath, 'tmp')
  const projectAPath = join(rootPath, 'project-a')
  const projectBPath = join(rootPath, 'project-b')
  const evidencePath = join(rootPath, 'evidence')
  const claimsPath = join(evidencePath, 'llm-claims')
  const outcomesPath = join(evidencePath, 'llm-outcomes')
  const sessionEventsPath = join(evidencePath, 'session-events')

  // Single-layer mkdir without recursive punch-through
  await mkdir(rootPath, { mode: 0o700 })
  await mkdir(homePath, { mode: 0o700 })
  await mkdir(dshHomePath, { mode: 0o700 })
  await mkdir(tmpPath, { mode: 0o700 })
  await mkdir(projectAPath, { mode: 0o700 })
  await mkdir(projectBPath, { mode: 0o700 })
  await mkdir(evidencePath, { mode: 0o700 })
  await mkdir(claimsPath, { mode: 0o700 })
  await mkdir(outcomesPath, { mode: 0o700 })
  await mkdir(sessionEventsPath, { mode: 0o700 })

  const ownerReceipt = {
    schema_version: 1,
    root_path: rootPath,
    root_identity: rootIdentity,
    created_at: new Date().toISOString(),
    pid: process.pid,
  }
  await writeFile(join(rootPath, '.canary_owner_receipt.json'), JSON.stringify(ownerReceipt, null, 2), { mode: 0o600 })

  return {
    rootPath,
    rootIdentity,
    homePath,
    dshHomePath,
    tmpPath,
    projectAPath,
    projectBPath,
    evidencePath,
  }
}

export async function verifyCredentialMetadataOnly(dshHome) {
  if (!dshHome || !isAbsolute(dshHome)) {
    throw new Error('dsh_home_must_be_absolute')
  }

  const credPath = join(dshHome, '.credentials.yaml')
  let s
  try {
    s = await lstat(credPath)
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      throw new Error('credential_unavailable')
    }
    throw err
  }

  if (s.isSymbolicLink()) {
    throw new Error('credential_cannot_be_symlink')
  }
  if (!s.isFile()) {
    throw new Error('credential_must_be_regular_file')
  }

  const modeOctal = s.mode & 0o777
  if (modeOctal !== 0o600) {
    throw new Error('credential_insecure_permissions')
  }

  if (s.size <= 0 || s.size > 65536) {
    throw new Error('credential_invalid_size')
  }

  return {
    valid: true,
    mode: '0600',
    size: s.size,
  }
}

export async function cleanupRunRoot(rootPath, expectedRootIdentity) {
  if (!rootPath || typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
    return { success: false, reason: 'invalid_root_path' }
  }

  const resolved = resolve(rootPath)
  if (resolved === '/' || resolved === homedir() || resolved === process.cwd()) {
    return { success: false, reason: 'refusing_to_delete_critical_directory' }
  }

  const receiptPath = join(resolved, '.canary_owner_receipt.json')
  try {
    const rawReceipt = await readFile(receiptPath, 'utf8')
    const receipt = JSON.parse(rawReceipt)
    if (
      receipt.schema_version !== 1 ||
      receipt.root_path !== resolved ||
      (expectedRootIdentity && receipt.root_identity !== expectedRootIdentity)
    ) {
      return { success: false, reason: 'unverified_owner_receipt' }
    }
  } catch {
    return { success: false, reason: 'unverified_owner_receipt' }
  }

  try {
    await rm(resolved, { recursive: true, force: true })
    try {
      await lstat(resolved)
      return { success: false, reason: 'directory_still_exists_after_cleanup' }
    } catch {
      return { success: true }
    }
  } catch {
    return { success: false, reason: 'cleanup_failed' }
  }
}
