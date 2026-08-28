import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  validateCanaryPlan,
  validateCanaryReport,
  computePlanSha256,
  computeReportSha256,
  createCanaryPlan,
  REQUIRED_CANARY_STEPS,
  type CanaryPlan,
  type CanaryReport,
} from '../src/m07/canary-schema.js'
import { verifyCanaryArtifact, REQUIRED_CANARY_TARBALL_FILES } from '../src/m07/artifact.js'
import { executeCanaryPreflight } from '../src/m07/preflight.js'

const execFileAsync = promisify(execFile)

describe('MVP-07A Final CTO Review: Canary Plan/Report Schema & Dry-run Preflight', () => {
  const preflightScriptPath = join(new URL('../scripts/mvp07-canary-preflight.mjs', import.meta.url).pathname)

  let fixtureTarballDir: string
  let sharedTarballPath: string

  async function makeTestTarball(targetDir: string, name: string, files: Record<string, string>): Promise<string> {
    const buildDir = join(targetDir, name)
    await mkdir(join(buildDir, 'package', 'dist'), { recursive: true })
    for (const [relPath, content] of Object.entries(files)) {
      const fullP = join(buildDir, relPath)
      await writeFile(fullP, content, 'utf8')
    }
    const outTgz = join(targetDir, `${name}.tgz`)
    await execFileAsync('tar', ['-czf', outTgz, '-C', buildDir, ...Object.keys(files)])
    return outTgz
  }

  const validPkgJson = JSON.stringify({
    name: '@cziyi/dsh-mnemosyne',
    version: '0.0.0-dev',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  beforeAll(async () => {
    const base = await realpath(tmpdir())
    fixtureTarballDir = await mkdtemp(join(base, 'dsh-canary-fixture-'))
    sharedTarballPath = await makeTestTarball(fixtureTarballDir, 'standard-fixture', {
      'package/package.json': validPkgJson,
      'package/README.md': '# dsh-mnemosyne\n',
      'package/LICENSE': 'MIT License\n',
      'package/cordis.patch.yml': '# cordis patch\n',
      'package/dist/index.mjs': 'export default {}\n',
      'package/dist/index.d.mts': 'export default {}\n',
    })
  })

  afterAll(async () => {
    if (fixtureTarballDir) {
      await rm(fixtureTarballDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const samplePlan = createCanaryPlan({
    tarball_sha256: 'sha256_' + 'a'.repeat(64),
    knowledge: {
      topic: 'Aurora component envelope',
      canary_fact: 'Aurora component uses amber envelope format verified as aurora-envelope-v1.',
    },
  })

  it('validates valid CanaryPlan and computes deterministic canonical sha256', () => {
    const validated = validateCanaryPlan(samplePlan)
    expect(validated).toEqual(samplePlan)
    const hash = computePlanSha256(samplePlan)
    expect(hash).toMatch(/^sha256_[0-9a-f]{64}$/)
  })

  it('proves createCanaryPlan returns independent clones: mutating returned plan steps does not pollute subsequent plans', () => {
    const plan1 = createCanaryPlan({
      tarball_sha256: 'sha256_' + 'a'.repeat(64),
      knowledge: {
        topic: 'Aurora component envelope',
        canary_fact: 'Aurora component uses amber envelope format verified as aurora-envelope-v1.',
      },
    })

    // Mutate plan1 steps
    plan1.steps[0].name = 'tampered_name'

    const plan2 = createCanaryPlan({
      tarball_sha256: 'sha256_' + 'a'.repeat(64),
      knowledge: {
        topic: 'Aurora component envelope',
        canary_fact: 'Aurora component uses amber envelope format verified as aurora-envelope-v1.',
      },
    })

    expect(plan2.steps[0].name).toBe('automatic_capture')
    expect(REQUIRED_CANARY_STEPS[0].name).toBe('automatic_capture')
  })

  it('rejects invalid CanaryPlan with exceeded budget, wrong step sequence, bad knowledge, or forged plan_id', () => {
    // 1. Altered budget
    expect(() =>
      validateCanaryPlan({
        ...samplePlan,
        budget: { ...samplePlan.budget, max_runs: 5 },
      })
    ).toThrow()

    // 2. Swapped step sequence
    expect(() =>
      validateCanaryPlan({
        ...samplePlan,
        steps: [
          samplePlan.steps[1],
          samplePlan.steps[0],
          ...samplePlan.steps.slice(2),
        ],
      })
    ).toThrow()

    // 3. Forged plan_id
    expect(() =>
      validateCanaryPlan({
        ...samplePlan,
        plan_id: 'plan_forged_id',
      })
    ).toThrow()

    // 4. Forbidden path or key in knowledge topic/canary_fact
    expect(() =>
      validateCanaryPlan({
        ...samplePlan,
        knowledge: {
          topic: 'Forbidden Key in /Users/victim',
          canary_fact: 'Valid fact body',
        },
      })
    ).toThrow()

    expect(() =>
      validateCanaryPlan({
        ...samplePlan,
        knowledge: {
          topic: 'Valid topic',
          canary_fact: 'Here is an api_key=secret token in /var/log/test',
        },
      })
    ).toThrow()
  })

  it('validates CanaryReport status matrix: pass, dry_run_ready, and fail', () => {
    // 1. Valid pass report
    const passBase = {
      schema_version: 1 as const,
      status: 'pass' as const,
      dsh_version: '0.1.1-rc.2' as const,
      package_version: '0.0.0-dev' as const,
      package_sha256: 'sha256_' + 'b'.repeat(64),
      run_count: 6,
      model_request_count: 8,
      checks: {
        automatic_capture: 'pass' as const,
        restart_persistence: 'pass' as const,
        progressive_disclosure: 'pass' as const,
        promotion: 'pass' as const,
        forget_and_grant: 'pass' as const,
        scope_isolation: 'pass' as const,
      },
      reason_code: null,
      cleanup_clean: true,
    }
    const passReport: CanaryReport = {
      ...passBase,
      report_sha256: computeReportSha256(passBase),
    }
    expect(validateCanaryReport(passReport)).toEqual(passReport)

    // 2. Valid dry_run_ready report
    const dryRunBase = {
      schema_version: 1 as const,
      status: 'dry_run_ready' as const,
      dsh_version: '0.1.1-rc.2' as const,
      package_version: '0.0.0-dev' as const,
      package_sha256: 'sha256_' + 'b'.repeat(64),
      run_count: 0,
      model_request_count: 0,
      checks: {
        automatic_capture: 'not_run' as const,
        restart_persistence: 'not_run' as const,
        progressive_disclosure: 'not_run' as const,
        promotion: 'not_run' as const,
        forget_and_grant: 'not_run' as const,
        scope_isolation: 'not_run' as const,
      },
      reason_code: null,
      cleanup_clean: true,
    }
    const dryRunReport: CanaryReport = {
      ...dryRunBase,
      report_sha256: computeReportSha256(dryRunBase),
    }
    expect(validateCanaryReport(dryRunReport)).toEqual(dryRunReport)

    // 3. Invalid pass report with incomplete runs
    expect(() =>
      validateCanaryReport({
        ...passReport,
        run_count: 5,
        report_sha256: computeReportSha256({ ...passReport, run_count: 5 }),
      })
    ).toThrow()

    // 4. Invalid hash in report
    expect(() =>
      validateCanaryReport({
        ...passReport,
        report_sha256: 'sha256_' + '0'.repeat(64),
      })
    ).toThrow()
  })

  it('runs preflight CLI in dry-run mode with explicit tarball, outputting awaiting_user_approval with 0 model requests', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [
        preflightScriptPath,
        '--tarball',
        sharedTarballPath,
        '--dry-run',
        '--json',
      ],
      {
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'forbidden_dummy_key_that_must_never_be_called',
        },
      }
    )

    const result = JSON.parse(stdout)
    expect(result.status).toBe('awaiting_user_approval')
    expect(result.package_name).toBe('@cziyi/dsh-mnemosyne')
    expect(result.package_version).toBe('0.0.0-dev')
    expect(result.dsh_version).toBe('0.1.1-rc.2')
    expect(result.package_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(result.plan_id).toMatch(/^plan_[0-9a-f]{32}$/)
    expect(result.plan_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(result.budget.max_runs).toBe(6)
    expect(result.budget.max_model_requests).toBe(12)
    expect(result.model_calls_executed).toBe(0)
    expect(result.mode).toBe('dry_run')
  }, 10000)

  it('tests artifact verification: valid tarball returns verified info, invalid tarball fails closed across comprehensive attack matrix', async () => {
    const info = await verifyCanaryArtifact(sharedTarballPath)
    expect(info.packageName).toBe('@cziyi/dsh-mnemosyne')
    expect(info.packageVersion).toBe('0.0.0-dev')
    expect(info.packageSha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(info.realTarballPath).toBe(sharedTarballPath)
    expect(REQUIRED_CANARY_TARBALL_FILES.length).toBe(6)

    const base = await realpath(tmpdir())
    const tempBadDir = await mkdtemp(join(base, 'dsh-bad-tarball-'))

    try {
      // 1. Missing a required file (5 files instead of 6)
      const tgzMissing = await makeTestTarball(tempBadDir, 'missing-readme', {
        'package/package.json': validPkgJson,
        'package/LICENSE': 'MIT License\n',
        'package/cordis.patch.yml': '# patch',
        'package/dist/index.mjs': 'export default {}',
        'package/dist/index.d.mts': 'export default {}',
      })
      await expect(verifyCanaryArtifact(tgzMissing)).rejects.toThrow('tarball_file_count_invalid')

      // 2. Extra unexpected file (7 files instead of 6)
      const tgzExtra = await makeTestTarball(tempBadDir, 'extra-file', {
        'package/package.json': validPkgJson,
        'package/README.md': '# readme',
        'package/LICENSE': 'MIT License\n',
        'package/cordis.patch.yml': '# patch',
        'package/dist/index.mjs': 'export default {}',
        'package/dist/index.d.mts': 'export default {}',
        'package/malicious.js': 'console.log(1)',
      })
      await expect(verifyCanaryArtifact(tgzExtra)).rejects.toThrow('tarball_file_count_invalid')

      // 3. Duplicate entry in tarball (e.g. package.json added twice, total 6 entries with duplicate)
      const dupDir = join(tempBadDir, 'dup-entry')
      await mkdir(join(dupDir, 'package', 'dist'), { recursive: true })
      await writeFile(join(dupDir, 'package', 'package.json'), validPkgJson, 'utf8')
      await writeFile(join(dupDir, 'package', 'LICENSE'), 'MIT License\n', 'utf8')
      await writeFile(join(dupDir, 'package', 'cordis.patch.yml'), '# patch', 'utf8')
      await writeFile(join(dupDir, 'package', 'dist', 'index.mjs'), 'export default {}', 'utf8')
      await writeFile(join(dupDir, 'package', 'dist', 'index.d.mts'), 'export default {}', 'utf8')
      const tgzDup = join(tempBadDir, 'duplicate-entry.tgz')
      await execFileAsync('tar', [
        '-czf',
        tgzDup,
        '-C',
        dupDir,
        'package/package.json',
        'package/package.json',
        'package/LICENSE',
        'package/cordis.patch.yml',
        'package/dist/index.mjs',
        'package/dist/index.d.mts',
      ])
      await expect(verifyCanaryArtifact(tgzDup)).rejects.toThrow('tarball_contains_duplicate_entries')

      // 4. Bad package name in manifest
      const tgzBadName = await makeTestTarball(tempBadDir, 'bad-name', {
        'package/package.json': JSON.stringify({
          name: 'evil-plugin',
          version: '0.0.0-dev',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/README.md': '# readme',
        'package/LICENSE': 'MIT License\n',
        'package/cordis.patch.yml': '# patch',
        'package/dist/index.mjs': 'export default {}',
        'package/dist/index.d.mts': 'export default {}',
      })
      await expect(verifyCanaryArtifact(tgzBadName)).rejects.toThrow('invalid_package_name_in_tarball')

      // 5. Bad package version in manifest
      const tgzBadVersion = await makeTestTarball(tempBadDir, 'bad-version', {
        'package/package.json': JSON.stringify({
          name: '@cziyi/dsh-mnemosyne',
          version: '99.9.9',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/README.md': '# readme',
        'package/LICENSE': 'MIT License\n',
        'package/cordis.patch.yml': '# patch',
        'package/dist/index.mjs': 'export default {}',
        'package/dist/index.d.mts': 'export default {}',
      })
      await expect(verifyCanaryArtifact(tgzBadVersion)).rejects.toThrow('invalid_package_version_in_tarball')

      // 6. Missing dsh.bundle.patch
      const tgzMissingPatch = await makeTestTarball(tempBadDir, 'missing-patch', {
        'package/package.json': JSON.stringify({
          name: '@cziyi/dsh-mnemosyne',
          version: '0.0.0-dev',
        }),
        'package/README.md': '# readme',
        'package/LICENSE': 'MIT License\n',
        'package/cordis.patch.yml': '# patch',
        'package/dist/index.mjs': 'export default {}',
        'package/dist/index.d.mts': 'export default {}',
      })
      await expect(verifyCanaryArtifact(tgzMissingPatch)).rejects.toThrow('missing_dsh_bundle_patch_in_tarball')
    } finally {
      await rm(tempBadDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 10000)
})
