import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('M0 config contract', () => {
  it('accepts the default and explicit enabled values', () => {
    expect(Config({})).toEqual({ enabled: true })
    expect(Config({ enabled: false })).toEqual({ enabled: false })
  })

  it('rejects non-boolean enabled values', () => {
    expect(() => Config({ enabled: 'yes' } as never)).toThrow()
    expect(() => Config({ enabled: 1 } as never)).toThrow()
  })

  it('records that Schemastery preserves unknown fields for this public schema', () => {
    expect(Config({ enabled: true, unknown: true } as never)).toEqual({ enabled: true, unknown: true })
  })
})
