import { describe, expect, it } from 'vitest'
import { canonicalBytes, canonicalHash, ProtocolValidationError } from '../src/protocol/canonical.js'

describe('M0.5A canonical JSON v1', () => {
  it('sorts object keys by Unicode code point and keeps arrays in order', () => {
    expect(canonicalBytes({ '𐀀': 1, '\uE000': 2, items: [2, 1] })).toBe('{"items":[2,1],"":2,"𐀀":1}')
  })

  it('normalizes negative zero but rejects non-finite and exponent-unstable numbers', () => {
    expect(canonicalBytes({ value: -0 })).toBe('{"value":0}')
    expect(() => canonicalBytes({ value: Number.NaN })).toThrow(ProtocolValidationError)
    expect(() => canonicalBytes({ value: 1e-7 })).toThrow(ProtocolValidationError)
    expect(() => canonicalBytes({ value: 1e21 })).toThrow(ProtocolValidationError)
  })

  it('rejects non-plain values and produces stable hashes', () => {
    expect(() => canonicalBytes(new Date())).toThrow(ProtocolValidationError)
    expect(() => canonicalBytes({ value: undefined })).toThrow(ProtocolValidationError)
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }))
    const sparse: unknown[] = []; sparse.length = 1
    expect(() => canonicalBytes(sparse)).toThrow(ProtocolValidationError)
    const symbol = Symbol('hidden'); const withSymbol = { visible: 1, [symbol]: 2 }
    expect(() => canonicalBytes(withSymbol)).toThrow(ProtocolValidationError)
    const hidden = {} as Record<string, unknown>; Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false })
    expect(() => canonicalBytes(hidden)).toThrow(ProtocolValidationError)
    const accessor = { get secret() { return 1 } }
    expect(() => canonicalBytes(accessor)).toThrow(ProtocolValidationError)
  })

  it('preserves the JSON __proto__ key during canonicalization', () => {
    const parsed = JSON.parse('{"__proto__":1,"safe":2}')
    expect(canonicalBytes(parsed)).toBe('{"__proto__":1,"safe":2}')
    expect(canonicalHash(parsed)).toBe(canonicalHash(JSON.parse('{"safe":2,"__proto__":1}')))
  })
})
