import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile, stat, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  countLayersInDump,
  verifyProfileDependencyBinding,
} from '../src/m07/profile-smoke-support.js'
import { setupFakeDsh } from './helpers/fake-dsh.js'

const execFileAsync = promisify(execFile)

describe('MVP-07A Final CTO Review: Isolated Profile Release Smoke', () => {
  const smokeScriptPath = join(new URL('../scripts/mvp07-profile-smoke.mjs', import.meta.url).pathname)
  const repoRoot = join(new URL('../', import.meta.url).pathname)

  let controlledTarballDir: string
  let sharedTarballPath: string
  let alternateTarballPath: string
  let fakeDshBinDir: string

  beforeAll(async () => {
    const base = await realpath(tmpdir())
    controlledTarballDir = await mkdtemp(join(base, 'dsh-smoke-tarball-'))

    const distEntry = join(repoRoot, 'dist', 'index.mjs')
    const distExists = await stat(distEntry).then(() => true).catch(() => false)
    if (!distExists) {
      await execFileAsync('corepack', ['pnpm', 'build'], { cwd: repoRoot })
    }

    await execFileAsync('corepack', ['pnpm', 'pack', '--pack-destination', controlledTarballDir], { cwd: repoRoot })
    const files = await readdir(controlledTarballDir)
    const tgzFiles = files.filter((f) => f.endsWith('.tgz'))
    if (tgzFiles.length !== 1) {
      throw new Error(`expected_exactly_one_tarball_found_${tgzFiles.length}`)
    }
    sharedTarballPath = join(controlledTarballDir, tgzFiles[0])

    // Create alternate tarball for source binding mismatch test
    const altDir = join(controlledTarballDir, 'alt')
    await mkdir(altDir, { recursive: true })
    alternateTarballPath = join(altDir, 'dsh-mnemosyne-alt.tgz')
    await copyFile(sharedTarballPath, alternateTarballPath)

    // Setup isolated fake dsh for failure matrix acceleration
    fakeDshBinDir = join(controlledTarballDir, 'fake-bin')
    await setupFakeDsh(fakeDshBinDir)
  }, 60000)

  afterAll(async () => {
    if (controlledTarballDir) {
      await rm(controlledTarballDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('unit test: countLayersInDump accurately counts exact layers and rejects substrings, evil suffixes, and comments', () => {
    // 0 layers
    expect(countLayersInDump('')).toBe(0)
    expect(countLayersInDump('# dsh-mnemosyne:\n# - dsh-mnemosyne\n# name: dsh-mnemosyne\n')).toBe(0)
    expect(countLayersInDump('name: dsh-mnemosyne-evil\n')).toBe(0)
    expect(countLayersInDump('name: dsh-mnemosyne-extra\n')).toBe(0)
    expect(countLayersInDump('prefix-dsh-mnemosyne-suffix:\n')).toBe(0)
    expect(countLayersInDump('This is a normal comment mentioning dsh-mnemosyne in text\n')).toBe(0)

    // 1 layer
    expect(countLayersInDump('plugins:\n  - dsh-mnemosyne\n')).toBe(1)
    expect(countLayersInDump('dsh-mnemosyne:\n  enabled: true\n')).toBe(1)
    expect(countLayersInDump('name: dsh-mnemosyne\n')).toBe(1)
    expect(countLayersInDump('name: "dsh-mnemosyne"\n')).toBe(1)
    expect(countLayersInDump("name: 'dsh-mnemosyne'\n")).toBe(1)

    // 2 layers
    expect(countLayersInDump('dsh-mnemosyne:\n  enabled: true\nname: dsh-mnemosyne\n')).toBe(2)
  })

  it('unit test: verifyProfileDependencyBinding strictly validates file: protocol, resolves relative paths, and rejects invalid protocols, symlinks, or alternate tarballs', async () => {
    const base = await realpath(tmpdir())
    const tempProfileDir = await mkdtemp(join(base, 'dsh-profile-bind-'))

    try {
      // 1. Valid absolute file: path -> PASS
      const res1 = await verifyProfileDependencyBinding(`file:${sharedTarballPath}`, tempProfileDir, sharedTarballPath)
      expect(res1).toBe(true)

      // 2. Valid relative file: path -> PASS
      const relTarball = join(tempProfileDir, 'local-pkg.tgz')
      await execFileAsync('cp', [sharedTarballPath, relTarball])
      const res2 = await verifyProfileDependencyBinding('file:./local-pkg.tgz', tempProfileDir, relTarball)
      expect(res2).toBe(true)

      // 3. link: protocol -> reject
      await expect(
        verifyProfileDependencyBinding(`link:${sharedTarballPath}`, tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')

      // 4. workspace: protocol -> reject
      await expect(
        verifyProfileDependencyBinding('workspace:*', tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')

      // 5. npm semver version -> reject
      await expect(
        verifyProfileDependencyBinding('0.0.0-dev', tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')

      // 6. http/https protocol -> reject
      await expect(
        verifyProfileDependencyBinding('https://registry.npmjs.org/dsh-mnemosyne/-/dsh-mnemosyne-0.0.0.tgz', tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')

      // 7. file: pointing to different tarball -> reject
      await expect(
        verifyProfileDependencyBinding(`file:${alternateTarballPath}`, tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')

      // 8. file: pointing to symlink -> reject
      const symlinkPath = join(tempProfileDir, 'symlink-pack.tgz')
      await symlink(sharedTarballPath, symlinkPath)
      await expect(
        verifyProfileDependencyBinding(`file:${symlinkPath}`, tempProfileDir, sharedTarballPath)
      ).rejects.toThrow('plugin_tarball_source_mismatch')
    } finally {
      await rm(tempProfileDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('Gate B Comprehensive Smoke: real tarball install, exact source binding, 7 tools runtime smoke, credential isolation, and clean cleanup', async () => {
    const base = await realpath(tmpdir())
    const tempParent = await mkdtemp(join(base, 'dsh-parent-real-gate-'))

    try {
      const { stdout } = await execFileAsync(
        'node',
        [
          smokeScriptPath,
          '--tarball',
          sharedTarballPath,
          '--temp-parent',
          tempParent,
          '--profile',
          'smoke-gate-profile',
          '--json',
        ],
        {
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: 'forbidden_parent_secret_key',
            OPENAI_API_KEY: 'forbidden_parent_openai_key',
            ANTHROPIC_API_KEY: 'forbidden_parent_anthropic_key',
            MY_CUSTOM_TOKEN: 'forbidden_token',
            DSH_HOME: '/forbidden/host/dsh_home',
          },
        }
      )

      const result = JSON.parse(stdout)
      expect(result.status).toBe('pass')
      expect(result.layer_count_after_add).toBe(1)
      expect(result.layer_count_after_remove).toBe(0)
      expect(result.dsh_home_isolated).toBe(true)
      expect(result.plugin_installed_from_tarball).toBe(true)
      expect(result.runtime_smoke_pass).toBe(true)
      expect(result.model_requests_count).toBe(0)
      expect(result.package_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
      expect(result.cleanup_clean).toBe(true)

      // tempParent must still exist, runRoot must not
      const parentStat = await stat(tempParent)
      expect(parentStat.isDirectory()).toBe(true)
      const remainingChildren = await readdir(tempParent)
      expect(remainingChildren.length).toBe(0)
    } finally {
      await rm(tempParent, { recursive: true, force: true }).catch(() => {})
    }
  }, 60000)

  it('rejects missing tarball flag, relative tarball, symlink tarball, invalid flags, and invalid profile slug', async () => {
    const base = await realpath(tmpdir())
    const tempDir = await mkdtemp(join(base, 'dsh-smoke-adv-'))
    const symlinkTarball = join(tempDir, 'symlink-pack.tgz')
    await symlink(sharedTarballPath, symlinkTarball)

    const tempParent = await mkdtemp(join(base, 'dsh-parent-'))

    try {
      // 1. Missing --tarball flag must fail
      const p1 = await execFileAsync('node', [smokeScriptPath, '--temp-parent', tempParent, '--json']).catch((e) => e)
      expect(p1.stdout ? JSON.parse(p1.stdout).reason_code : '').toBe('tarball_path_required')

      // 2. Relative tarball path must fail
      const p2 = await execFileAsync('node', [smokeScriptPath, '--tarball', './some.tgz', '--temp-parent', tempParent, '--json']).catch((e) => e)
      expect(p2.stdout ? JSON.parse(p2.stdout).reason_code : '').toBe('tarball_must_be_absolute_path')

      // 3. Symlink tarball must fail
      const p3 = await execFileAsync('node', [smokeScriptPath, '--tarball', symlinkTarball, '--temp-parent', tempParent, '--json']).catch((e) => e)
      expect(p3.stdout ? JSON.parse(p3.stdout).reason_code : '').toBe('tarball_cannot_be_symlink')

      // 4. Unknown flag must fail
      const p4 = await execFileAsync('node', [smokeScriptPath, '--tarball', sharedTarballPath, '--temp-parent', tempParent, '--unknown', '--json']).catch((e) => e)
      expect(p4.stdout ? JSON.parse(p4.stdout).reason_code : '').toBe('unknown_argument')

      // 5. Invalid profile name slug must fail
      const p5 = await execFileAsync('node', [smokeScriptPath, '--tarball', sharedTarballPath, '--temp-parent', tempParent, '--profile', '../bad/profile', '--json']).catch((e) => e)
      expect(p5.stdout ? JSON.parse(p5.stdout).reason_code : '').toBe('invalid_profile_slug')
    } finally {
      await rm(tempParent, { recursive: true, force: true }).catch(() => {})
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 10000)

  it('cleanup fail-closed matrix: verifies proper cleanup and sentinel preservation across all failure stages using isolated fake DSH', async () => {
    const base = await realpath(tmpdir())
    const tempParent = await mkdtemp(join(base, 'dsh-parent-fail-matrix-'))
    const sentinelPath = join(tempParent, 'sentinel.txt')
    const sentinelContent = 'sentinel_canary_content_v1'
    await writeFile(sentinelPath, sentinelContent, 'utf8')

    const failureStages = ['add', 'dump_add', 'runtime_smoke', 'remove', 'dump_remove']

    try {
      for (const stage of failureStages) {
        const p = await execFileAsync(
          'node',
          [
            smokeScriptPath,
            '--tarball',
            sharedTarballPath,
            '--temp-parent',
            tempParent,
            '--profile',
            `smoke-fail-${stage}`,
            '--json',
          ],
          {
            env: {
              ...process.env,
              PATH: `${fakeDshBinDir}:${process.env.PATH || ''}`,
              __TEST_FAIL_AT: stage,
            },
          }
        ).catch((e) => e)

        expect(p.stdout).toBeDefined()
        const res = JSON.parse(p.stdout)
        expect(res.status).toBe('fail')
        expect(res.reason_code).toBe('injected_stage_failed')
        expect(res.cleanup_clean).toBe(true)

        // Sentinel must remain intact
        const readSentinel = await readFile(sentinelPath, 'utf8')
        expect(readSentinel).toBe(sentinelContent)

        // tempParent must contain ONLY sentinel.txt (runRoot was deleted)
        const remaining = await readdir(tempParent)
        expect(remaining).toEqual(['sentinel.txt'])
      }

      // Test simulated cleanup failure (rm_fail)
      const pRmFail = await execFileAsync(
        'node',
        [
          smokeScriptPath,
          '--tarball',
          sharedTarballPath,
          '--temp-parent',
          tempParent,
          '--profile',
          'smoke-fail-rm',
          '--json',
        ],
        {
          env: {
            ...process.env,
            PATH: `${fakeDshBinDir}:${process.env.PATH || ''}`,
            __TEST_FAIL_CLEANUP: 'rm_fail',
          },
        }
      ).catch((e) => e)

      const rmRes = JSON.parse(pRmFail.stdout)
      expect(rmRes.status).toBe('fail')
      expect(rmRes.reason_code).toBe('cleanup_failed')
      expect(rmRes.cleanup_clean).toBe(false)
      expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelContent)

      // Test simulated cleanup failure (stat_eacces)
      const pStatEacces = await execFileAsync(
        'node',
        [
          smokeScriptPath,
          '--tarball',
          sharedTarballPath,
          '--temp-parent',
          tempParent,
          '--profile',
          'smoke-fail-eacces',
          '--json',
        ],
        {
          env: {
            ...process.env,
            PATH: `${fakeDshBinDir}:${process.env.PATH || ''}`,
            __TEST_FAIL_CLEANUP: 'stat_eacces',
          },
        }
      ).catch((e) => e)

      const eaccesRes = JSON.parse(pStatEacces.stdout)
      expect(eaccesRes.status).toBe('fail')
      expect(eaccesRes.reason_code).toBe('cleanup_failed')
      expect(eaccesRes.cleanup_clean).toBe(false)
      expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelContent)
    } finally {
      await rm(tempParent, { recursive: true, force: true }).catch(() => {})
    }
  }, 15000)

  it('real subprocess timeout: aborts hanging subprocess via execFile timeout and guarantees clean environment and sentinel preservation', async () => {
    const base = await realpath(tmpdir())
    const tempParent = await mkdtemp(join(base, 'dsh-parent-timeout-'))
    const sentinelPath = join(tempParent, 'sentinel.txt')
    const sentinelContent = 'sentinel_timeout_check_content'
    await writeFile(sentinelPath, sentinelContent, 'utf8')

    try {
      const pTimeout = await execFileAsync(
        'node',
        [
          smokeScriptPath,
          '--tarball',
          sharedTarballPath,
          '--temp-parent',
          tempParent,
          '--profile',
          'smoke-timeout-profile',
          '--json',
        ],
        {
          env: {
            ...process.env,
            PATH: `${fakeDshBinDir}:${process.env.PATH || ''}`,
            __TEST_FAIL_AT: 'timeout',
            __TEST_SUBPROCESS_TIMEOUT_MS: '50',
          },
        }
      ).catch((e) => e)

      const rawStdout = pTimeout.stdout || ''
      const rawStderr = pTimeout.stderr || ''

      expect(rawStdout).toBeDefined()
      const res = JSON.parse(rawStdout)
      expect(res.status).toBe('fail')
      expect(res.reason_code).toBe('subprocess_timeout')
      expect(res.cleanup_clean).toBe(true)

      // Sentinel must remain unchanged
      expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelContent)

      // Subtree must only have sentinel.txt left
      const remaining = await readdir(tempParent)
      expect(remaining).toEqual(['sentinel.txt'])

      // Raw output must be desensitized
      expect(rawStdout).not.toContain('setTimeout')
      expect(rawStderr).not.toContain('SIGTERM')
      expect(rawStdout).not.toContain(tempParent)
      expect(rawStderr).not.toContain(tempParent)
    } finally {
      await rm(tempParent, { recursive: true, force: true }).catch(() => {})
    }
  }, 10000)

  it('adversarial error desensitization: output contains zero raw paths, secret tokens, or commands', async () => {
    const base = await realpath(tmpdir())
    const tempParent = await mkdtemp(join(base, 'dsh-parent-adv-'))

    try {
      const maliciousInputs = [
        '/Users/victim/.ssh/id_rsa',
        '/var/secrets/sk-secret-1234567890abcdef.tgz',
        '/tmp/Bearer-secret-token-xyz.tgz',
        '/root/rm-rf-root.tgz',
      ]

      for (const input of maliciousInputs) {
        const p = await execFileAsync(
          'node',
          [
            smokeScriptPath,
            '--tarball',
            input,
            '--temp-parent',
            tempParent,
            '--profile',
            'smoke-adv-profile',
            '--json',
          ]
        ).catch((e) => e)

        const rawStdout = p.stdout || ''
        const rawStderr = p.stderr || ''

        // Assert 0 occurrences of secret inputs in stdout or stderr
        expect(rawStdout).not.toContain('victim')
        expect(rawStdout).not.toContain('sk-secret')
        expect(rawStdout).not.toContain('Bearer')
        expect(rawStdout).not.toContain('rm-rf')

        expect(rawStderr).not.toContain('victim')
        expect(rawStderr).not.toContain('sk-secret')
        expect(rawStderr).not.toContain('Bearer')
        expect(rawStderr).not.toContain('rm-rf')

        if (rawStdout) {
          const res = JSON.parse(rawStdout)
          expect(res.status).toBe('fail')
          expect(res.reason_code).toMatch(/^[a-z0-9_]{1,64}$/)
        }
      }
    } finally {
      await rm(tempParent, { recursive: true, force: true }).catch(() => {})
    }
  }, 10000)
})
