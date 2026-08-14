import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('M0 bundle manifest', () => {
  it('declares the public dsh bundle patch only', async () => {
    const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.packageManager).toBe('pnpm@11.7.0')
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md'])
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-session': '0.1.0-rc.6',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
      '@deepseek-ai/schemastery': '3.18.1',
    })
  })
})
