import { describe, expect, it } from 'vitest'
import { buildRecallSubagentPromptV3, runDshSubagentV3, type DshSubagentFactoryV3 } from '../src/v3/dsh-subagent.js'

describe('v3 dsh subagent adapter', () => {
  it('builds a strict JSON-only task packet with bounded disclosed items', () => {
    const prompt = buildRecallSubagentPromptV3({ stage: 'root_titles', task: 'task', items: [{ ref: 'node_a', title: 'A', kind: 'node' }] })
    expect(prompt).toContain('Return JSON only')
    expect(prompt).toContain('node_a')
    expect(prompt).not.toContain('content')
  })
  it('creates a child with explicit route and disposes it after reading output', async () => {
    let disposed = false
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"selected_refs":[]}' }] } } }] } }
    const factory: DshSubagentFactoryV3 = async (_parent, request) => { expect(request.provider).toBe('p'); expect(request.model).toBe('m'); return { agent: child as any, dispose: async () => { disposed = true } } as any }
    const output = await runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: new AbortController().signal }, factory)
    expect(output).toContain('selected_refs'); expect(disposed).toBe(true)
  })
})
