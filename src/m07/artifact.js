import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 15000
const MAX_BUFFER = 4 * 1024 * 1024

export const REQUIRED_CANARY_TARBALL_FILES = Object.freeze([
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/cordis.patch.yml',
  'package/dist/index.mjs',
  'package/dist/index.d.mts',
])

const REQUIRED_CANARY_TARBALL_FILES_SET = new Set(REQUIRED_CANARY_TARBALL_FILES)

export async function verifyCanaryArtifact(tarballPath) {
  if (typeof tarballPath !== 'string' || !isAbsolute(tarballPath)) {
    throw new Error('tarball_must_be_absolute_path')
  }

  const realTarballPath = await realpath(tarballPath).catch(() => {
    throw new Error('tarball_file_not_found')
  })
  if (realTarballPath !== tarballPath) {
    throw new Error('tarball_cannot_be_symlink')
  }

  const fileStat = await stat(tarballPath).catch(() => {
    throw new Error('tarball_file_not_found')
  })
  if (!fileStat.isFile()) {
    throw new Error('tarball_must_be_regular_file')
  }

  const bytes = await readFile(tarballPath)
  const packageSha256 = 'sha256_' + createHash('sha256').update(bytes).digest('hex')

  // Check TOC
  let tocOut = ''
  try {
    const res = await execFileAsync('tar', ['-tzf', tarballPath], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    tocOut = res.stdout
  } catch {
    throw new Error('tarball_read_failed')
  }

  const entries = tocOut.trim().split('\n').filter(Boolean)
  if (entries.length !== REQUIRED_CANARY_TARBALL_FILES.length) {
    throw new Error('tarball_file_count_invalid')
  }

  const entrySet = new Set(entries)
  if (entrySet.size !== entries.length) {
    throw new Error('tarball_contains_duplicate_entries')
  }

  for (const requiredFile of REQUIRED_CANARY_TARBALL_FILES) {
    if (!entrySet.has(requiredFile)) {
      throw new Error('tarball_missing_required_files')
    }
  }

  for (const entry of entrySet) {
    if (!REQUIRED_CANARY_TARBALL_FILES_SET.has(entry)) {
      throw new Error('tarball_contains_unexpected_files')
    }
  }

  // Read package.json inside tarball
  let pkgOut = ''
  try {
    const res = await execFileAsync('tar', ['-xOzf', tarballPath, 'package/package.json'], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    pkgOut = res.stdout
  } catch {
    throw new Error('tarball_manifest_read_failed')
  }

  let manifest
  try {
    manifest = JSON.parse(pkgOut)
  } catch {
    throw new Error('tarball_manifest_invalid_json')
  }

  if (manifest.name !== '@cziyi/dsh-mnemosyne') {
    throw new Error('invalid_package_name_in_tarball')
  }
  if (manifest.version !== '0.0.0-dev' && manifest.version !== '0.1.0') {
    throw new Error('invalid_package_version_in_tarball')
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('missing_dsh_bundle_patch_in_tarball')
  }

  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    packageSha256,
    realTarballPath,
  }
}
