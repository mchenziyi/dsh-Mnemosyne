import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('M0 bundle smoke', () => {
  it('keeps the patch in the supported insert form', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: dsh-mnemosyne')
    expect(patch).toContain('name: dsh-mnemosyne')
    expect(patch).toContain('enabled: true')
  })
})
