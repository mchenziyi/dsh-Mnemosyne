#!/usr/bin/env node
import { register } from 'node:module'

const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
      const tsSpecifier = specifier.slice(0, -3) + '.ts';
      try {
        return await nextResolve(tsSpecifier, context);
      } catch {}
    }
    throw err;
  }
}
`

const loaderDataUrl = 'data:text/javascript,' + encodeURIComponent(loaderCode)
register(loaderDataUrl, import.meta.url)

import { parseArgs } from 'node:util'

const { executeDryRun, executePrepare, executeCanary } = await import('../src/m07b/runner.js')

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        tarball: { type: 'string' },
        'temp-parent': { type: 'string' },
        'dry-run': { type: 'boolean' },
        prepare: { type: 'boolean' },
        execute: { type: 'boolean' },
        'run-root': { type: 'string' },
        'approval-sha256': { type: 'string' },
        'report-out': { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: false,
    })

    const isJson = values.json ?? false

    if (values['dry-run']) {
      if (!values.tarball) {
        throw new Error('tarball_path_required')
      }
      const res = await executeDryRun({ tarballPath: values.tarball })
      if (isJson) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      } else {
        process.stdout.write(`Canary status: ${res.status}\n`)
        process.stdout.write(`Plan SHA256: ${res.plan_sha256}\n`)
      }
      process.exitCode = 0
      return
    }

    if (values.prepare) {
      if (!values.tarball) throw new Error('tarball_path_required')
      if (!values['temp-parent']) throw new Error('temp_parent_path_required')
      const res = await executePrepare({
        tarballPath: values.tarball,
        tempParent: values['temp-parent'],
      })
      if (isJson) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      } else {
        process.stdout.write(`Canary prepared: ${res.plan_sha256}\n`)
        process.stdout.write(`Please write temporary credentials (0600) to: ${res.credential_target}\n`)
      }
      process.exitCode = 0
      return
    }

    if (values.execute) {
      if (!values['run-root']) throw new Error('run_root_path_required')
      if (!values['approval-sha256']) throw new Error('approval_sha256_required')
      const res = await executeCanary({
        runRoot: values['run-root'],
        approvalSha256: values['approval-sha256'],
        reportOutPath: values['report-out'],
      })
      if (isJson) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      } else {
        process.stdout.write(`Canary executed: status=${res.status}\n`)
      }
      process.exitCode = res.status === 'pass' ? 0 : 1
      return
    }

    throw new Error('missing_mode_flag_dry_run_prepare_or_execute')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'canary_failed'
    process.stderr.write(`Canary failed: ${message}\n`)
    process.exitCode = 1
  }
}

await main()
