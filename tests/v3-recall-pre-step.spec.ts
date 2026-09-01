import { describe, expect, it } from 'vitest'
import { createRecallPreStepHandlerV3 } from '../src/v3/recall-pre-step.js'

describe('v3 recall pre-step', () => {
  it('does not recurse for subagent-origin sessions', async () => {
    let legacy = 0
    const handler = createRecallPreStepHandlerV3({ scopeRuntime: { observeSession: () => ({ status: 'ready', scope: {} }) } as any, legacyRuntime: { recall: async () => { legacy++; throw new Error() } } as any })
    const result = await handler({ agent: { options: { provider: 'p', model: 'm' }, session: { id: 's', header: { origin: 'subagent' } } } as any, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect(result).toEqual({ kind: 'enter', messages: [] }); expect(legacy).toBe(0)
  })
})
