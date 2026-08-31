import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const SMOKE_TIMEOUT_MS = 30000
export const SMOKE_MAX_BUFFER = 4 * 1024 * 1024

export const SMOKE_ERROR_ALLOWLIST = new Set([
  'duplicate_argument',
  'missing_tarball_argument_value',
  'missing_temp_parent_argument_value',
  'missing_profile_argument_value',
  'unknown_argument',
  'tarball_path_required',
  'invalid_profile_slug',
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
  'temp_parent_must_be_absolute',
  'temp_parent_not_found',
  'temp_parent_cannot_be_symlink',
  'temp_parent_cannot_be_default_dsh_home',
  'invalid_layer_count_after_add',
  'invalid_layer_count_after_remove',
  'plugin_tarball_source_mismatch',
  'runtime_smoke_failed',
  'cleanup_failed',
  'subprocess_timeout',
  'injected_stage_failed',
])

export class SmokeError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SmokeError'
    this.code = SMOKE_ERROR_ALLOWLIST.has(code) ? code : 'smoke_failed'
  }
}

export function mapSmokeError(err) {
  if (err && typeof err === 'object' && (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
    return 'subprocess_timeout'
  }
  const code =
    err instanceof SmokeError
      ? err.code
      : err instanceof Error
        ? err.message
        : ''
  if (SMOKE_ERROR_ALLOWLIST.has(code)) {
    return code
  }
  return 'smoke_failed'
}

export function countLayersInDump(dumpText) {
  if (typeof dumpText !== 'string') return 0
  const lines = dumpText.split('\n')
  let count = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue
    if (
      trimmed === 'dsh-mnemosyne:' ||
      trimmed === '- dsh-mnemosyne' ||
      trimmed === 'name: dsh-mnemosyne' ||
      trimmed === 'name: "dsh-mnemosyne"' ||
      trimmed === "name: 'dsh-mnemosyne'" ||
      trimmed === 'name: @cziyi/dsh-mnemosyne' ||
      trimmed === 'name: "@cziyi/dsh-mnemosyne"' ||
      trimmed === "name: '@cziyi/dsh-mnemosyne'"
    ) {
      count++
    }
  }
  return count
}

export async function verifyProfileDependencyBinding(depVal, profileDir, expectedRealTarballPath) {
  if (typeof depVal !== 'string' || !depVal.startsWith('file:')) {
    throw new SmokeError('plugin_tarball_source_mismatch')
  }

  const relativeOrAbsPath = depVal.slice(5) // remove 'file:'
  if (!relativeOrAbsPath) {
    throw new SmokeError('plugin_tarball_source_mismatch')
  }

  const resolvedDepPath = isAbsolute(relativeOrAbsPath)
    ? relativeOrAbsPath
    : resolve(profileDir, relativeOrAbsPath)

  // Verify resolvedDepPath is not a symlink itself
  const lstatRes = await lstat(resolvedDepPath).catch(() => {
    throw new SmokeError('plugin_tarball_source_mismatch')
  })
  if (lstatRes.isSymbolicLink()) {
    throw new SmokeError('plugin_tarball_source_mismatch')
  }

  const realDepPath = await realpath(resolvedDepPath).catch(() => {
    throw new SmokeError('plugin_tarball_source_mismatch')
  })

  if (realDepPath !== expectedRealTarballPath) {
    throw new SmokeError('plugin_tarball_source_mismatch')
  }

  return true
}

export async function cleanupRunRoot(runRoot) {
  if (!runRoot) return { success: true }
  try {
    if (process.env.__TEST_FAIL_CLEANUP === 'rm_fail') {
      return { success: false, reason: 'cleanup_failed' }
    }
    await rm(runRoot, { recursive: true, force: true })
    if (process.env.__TEST_FAIL_CLEANUP === 'stat_eacces' || process.env.__TEST_FAIL_CLEANUP === 'stat_fail') {
      return { success: false, reason: 'cleanup_failed' }
    }
    try {
      await stat(runRoot)
      return { success: false, reason: 'cleanup_failed' }
    } catch (statErr) {
      if (statErr && statErr.code === 'ENOENT') {
        return { success: true }
      }
      return { success: false, reason: 'cleanup_failed' }
    }
  } catch {
    return { success: false, reason: 'cleanup_failed' }
  }
}

export async function runInstalledRuntimeSmoke(profileDir, sanitizedEnv) {
  const scriptContent = `
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const profileDir = process.env.PROFILE_DIR
if (!profileDir) throw new Error('profile_dir_required')

async function load(specifier) {
  const parts = specifier.startsWith('@') ? specifier.split('/') : [specifier]
  const roots = [join(profileDir, 'node_modules'), join(dirname(profileDir), 'node_modules')]
  for (const root of roots) {
    const packageDir = join(root, ...parts)
    try {
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
      const entry = manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? manifest.exports?.['.'] ?? manifest.module ?? manifest.main
      if (typeof entry !== 'string') throw new Error('package_has_no_esm_entry')
      return import(pathToFileURL(join(packageDir, entry)).href)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error('cannot_resolve_package')
}

const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }, { default: LlmRuntime }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-llm'),
  load('@cziyi/dsh-mnemosyne'),
])

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(LlmRuntime)
const fiber = await ctx.plugin({
  name: plugin.name,
  Config: plugin.Config,
  inject: plugin.inject,
  apply: plugin.apply,
}, { enabled: true })

const forbiddenTools = [
  'mnemosyne_status',
  'mnemosyne_acquisition_status',
  'mnemosyne_search',
  'mnemosyne_open',
  'mnemosyne_remember',
  'mnemosyne_list',
  'mnemosyne_promote',
  'mnemosyne_forget',
]

for (const name of forbiddenTools) {
  if (ctx.tools.get(name) !== undefined) throw new Error('unexpected_tool_' + name)
}

await fiber.dispose()

for (const name of forbiddenTools) {
  if (ctx.tools.get(name) !== undefined) throw new Error('tool_not_disposed_' + name)
}
`

  try {
    await execFileAsync('node', ['--input-type=module', '-e', scriptContent], {
      env: { ...sanitizedEnv, PROFILE_DIR: profileDir },
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: SMOKE_MAX_BUFFER,
    })
  } catch {
    throw new SmokeError('runtime_smoke_failed')
  }
}
