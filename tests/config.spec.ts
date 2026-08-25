import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('M0 config contract', () => {
  it('accepts the default and explicit enabled and autoCapture values', () => {
    expect(Config({})).toEqual({ enabled: true, autoCapture: true })
    expect(Config({ enabled: false })).toEqual({ enabled: false, autoCapture: true })
    expect(Config({ autoCapture: false })).toEqual({ enabled: true, autoCapture: false })
  })

  it('rejects non-boolean enabled and autoCapture values', () => {
    expect(() => Config({ enabled: 'yes' } as never)).toThrow()
    expect(() => Config({ enabled: 1 } as never)).toThrow()
    expect(() => Config({ autoCapture: 'no' } as never)).toThrow()
  })

  it('records that Schemastery preserves unknown fields for this public schema', () => {
    expect(Config({ enabled: true, unknown: true } as never)).toEqual({ enabled: true, autoCapture: true, unknown: true })
  })
})
