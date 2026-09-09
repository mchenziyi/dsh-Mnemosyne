import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/typert.remote-client.js'

describe('consolidation status remote contract', () => {
  it('uses strict codecs accepted by the DSH client gateway', () => {
    const [descriptor] = TYPERT_REMOTE.descriptors
    expect(descriptor.parameters[0]?.codec.mode).toBe('strict')
    expect(descriptor.result.mode).toBe('strict')
    if (descriptor.parameters[0]?.codec.mode !== 'strict' || descriptor.result.mode !== 'strict') return
    expect(descriptor.parameters[0].codec.schema.parse('session-a')).toBe('session-a')
    expect(() => descriptor.parameters[0]?.codec.mode === 'strict'
      && descriptor.parameters[0].codec.schema.parse(42)).toThrow('invalid_session_id')
    expect(descriptor.result.schema.parse(null)).toBeNull()
    expect(descriptor.result.schema.parse({ status: 'running', turn: 1, updatedAt: 10 }))
      .toEqual({ status: 'running', turn: 1, updatedAt: 10 })
    expect(() => descriptor.result.mode === 'strict'
      && descriptor.result.schema.parse({ status: 'unknown', turn: 1, updatedAt: 10 }))
      .toThrow('invalid_consolidation_status')
  })
})
