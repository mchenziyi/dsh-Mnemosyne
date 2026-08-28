import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

export async function setupFakeDsh(binDir: string): Promise<string> {
  await mkdir(binDir, { recursive: true })
  const fakeDshPath = join(binDir, 'dsh')

  const fakeDshScript = `#!/usr/bin/env node
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const argv = process.argv.slice(2)

async function run() {
  const dshHome = process.env.DSH_HOME || '/tmp'

  if (argv.includes('--version')) {
    process.stdout.write('0.1.1-rc.2\\n')
    return
  }

  // Parse --profile <name>
  let profile = 'default'
  const profIdx = argv.indexOf('--profile')
  if (profIdx !== -1 && profIdx + 1 < argv.length) {
    profile = argv[profIdx + 1]
  }

  const profileDir = join(dshHome, 'profiles', profile)
  const markerPath = join(profileDir, '.installed_marker')
  const pkgPath = join(profileDir, 'package.json')

  if (argv[0] === 'plugin' && argv.includes('add')) {
    const tarball = argv[argv.length - 1]
    await mkdir(profileDir, { recursive: true })
    await writeFile(markerPath, 'installed', 'utf8')
    const pkg = {
      name: 'dsh-profile-' + profile,
      dependencies: {
        '@cziyi/dsh-mnemosyne': 'file:' + tarball,
      },
    }
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
    process.stdout.write('Plugin added\\n')
    return
  }

  if (argv.includes('--dump-config')) {
    let isInstalled = false
    try {
      await stat(markerPath)
      isInstalled = true
    } catch {
      isInstalled = false
    }

    if (isInstalled) {
      process.stdout.write('plugins:\\n  - dsh-mnemosyne\\n')
    } else {
      process.stdout.write('plugins: []\\n')
    }
    return
  }

  if (argv[0] === 'plugin' && argv.includes('remove')) {
    try {
      await rm(markerPath, { force: true })
      const pkg = {
        name: 'dsh-profile-' + profile,
        dependencies: {},
      }
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
    } catch {}
    process.stdout.write('Plugin removed\\n')
    return
  }
}

await run()
`

  await writeFile(fakeDshPath, fakeDshScript, { mode: 0o755 })
  await chmod(fakeDshPath, 0o755)
  return fakeDshPath
}
