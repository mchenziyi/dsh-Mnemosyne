import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('M0 runtime side-effect boundary', () => {
  it('does not import storage, network, process, or model APIs', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const status = await readFile(new URL('../src/status.ts', import.meta.url), 'utf8')
    const combined = `${source}\n${status}`
    for (const forbidden of ['node:fs', 'node:net', 'node:child_process', 'fetch(', 'agent.inject', 'Session.append']) {
      expect(combined).not.toContain(forbidden)
    }
  })
})
