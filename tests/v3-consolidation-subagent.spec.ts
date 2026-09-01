import { describe, expect, it } from 'vitest'
import { buildConsolidationSubagentPromptV3, runConsolidationSubagentV3, SubagentProtocolError } from '../src/v3/consolidation-subagent.js'

describe('v3 consolidation subagent', () => {
  it('uses a strict create/skip task packet', () => {
    const prompt = buildConsolidationSubagentPromptV3({ task: 'task', outcome: 'done', used_memory_refs: [] })
    expect(prompt).toContain('Return JSON only'); expect(prompt).toContain('used_memory_refs')
    expect(prompt).toContain('Never create only because a memory was read')
    expect(prompt).toContain('extends a used memory')
  })
  it('validates structured create output and rejects malformed output', async () => {
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ decision: 'create', title: '经验', summary: '摘要', content: '正文', related_memory_refs: [] }) }] } } }] } }
    const factory = async () => ({ agent: child as any, dispose: async () => undefined }) as any
    await expect(runConsolidationSubagentV3({} as any, { task: 'task', outcome: 'done', used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }, factory)).resolves.toMatchObject({ decision: 'create', title: '经验' })
  })
  it('does not turn protocol-invalid output into a fallback signal', async () => {
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{}' }] } } }] } }
    const factory = async () => ({ agent: child as any, dispose: async () => undefined }) as any
    await expect(runConsolidationSubagentV3({} as any, { task: 'task', outcome: 'done', used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }, factory)).rejects.toBeInstanceOf(SubagentProtocolError)
  })
})
