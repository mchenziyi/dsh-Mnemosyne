import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

describe('production entry', () => {
  it('installs V3 without a caller-supplied mode', async () => {
    const listeners = new Map<string, unknown>()
    const ctx = {
      llm: {},
      get: () => undefined,
      plugin: async () => undefined,
      on: (event: string, handler: unknown) => { listeners.set(event, handler) },
      effect: () => undefined,
    } as any
    await apply(ctx, { enabled: true })
    expect(listeners.has('agent/pre-step')).toBe(true)
    expect(listeners.has('system-prompt/assemble')).toBe(true)
  })
})
