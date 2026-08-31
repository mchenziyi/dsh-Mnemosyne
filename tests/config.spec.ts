import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('M0 config contract', () => {
  it('accepts only installation-first enabled and projectRoot settings', () => {
    expect(Config({})).toEqual({ enabled: true })
    expect(Config({ enabled: false })).toEqual({ enabled: false })
    expect(Config({ projectRoot: '/project' })).toEqual({ enabled: true, projectRoot: '/project' })
  })

  it('rejects invalid enabled and projectRoot values', () => {
    expect(() => Config({ enabled: 'yes' } as never)).toThrow()
    expect(() => Config({ enabled: 1 } as never)).toThrow()
    expect(() => Config({ projectRoot: 1 } as never)).toThrow()
  })

  it('records that Schemastery preserves unknown fields for this public schema', () => {
    expect(Config({ enabled: true, unknown: true } as never)).toEqual({ enabled: true, unknown: true })
  })
})
