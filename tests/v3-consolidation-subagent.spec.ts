import { describe, expect, it } from 'vitest'
import { buildConsolidationSubagentPromptV3, createConsolidationSubagentModelV3, runConsolidationSubagentV3, SubagentProtocolError } from '../src/v3/consolidation-subagent.js'
import type { ConsolidationModelRequestV2 } from '../src/v2/consolidation-runtime.js'

describe('v3 consolidation subagent', () => {
  it.each([
    { stage: 'judgment', fields: ['"decision":"skip"', '"decision":"create"', '"reason_code"', '"related_memory_refs"'] },
    { stage: 'category_titles', fields: ['"decision":"candidate"', '"node_ref"', '"decision":"no_candidate"'] },
    { stage: 'category_summary', fields: ['"decision":"attach"', '"decision":"expand"', '"decision":"reject"'] },
    { stage: 'category_new', fields: ['"decision":"new"', '"title"', '"summary"'] },
  ] as const)('supplies the complete production output contract for $stage', async ({ stage, fields }) => {
    let packet = ''
    let contract = ''
    const request = { schema_version: 1, stage } as ConsolidationModelRequestV2
    const decisions = { judgment: 'skip', category_titles: 'no_candidate', category_summary: 'attach', category_new: 'new' }
    const factory = async (_parent: any, input: any) => {
      packet = input.task
      contract = input.outputContract ?? ''
      return { agent: { followup() {}, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ decision: decisions[stage] }) }] } } }] } }, dispose: async () => undefined } as any
    }
    await createConsolidationSubagentModelV3({} as any, factory)(request, { provider: 'p', model: 'm', signal: new AbortController().signal })
    for (const field of fields) expect(contract).toContain(field)
    expect(packet).not.toContain('Your final response MUST')
    if (stage === 'judgment') expect(contract).toContain('related_memory_refs is mandatory even when there are no related memories; emit []')
    expect(JSON.parse(packet.split('\n').at(-1)!)).toEqual(request)
  })
  it('rejects tool-call text from the production path instead of repairing it into a memory', async () => {
    const factory = async () => ({ agent: { followup() {}, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '<tool_calls><invoke name="exec"></invoke></tool_calls>' }] } } }] } }, dispose: async () => undefined }) as any
    await expect(createConsolidationSubagentModelV3({} as any, factory)({ schema_version: 1, stage: 'judgment', evidence: { task: 'task', outcome: 'done' }, used_memory_refs: [] }, { provider: 'p', model: 'm', signal: new AbortController().signal })).rejects.toBeInstanceOf(SubagentProtocolError)
  })
  it('keeps standalone evidence in a separate task packet', () => {
    const prompt = buildConsolidationSubagentPromptV3({ task: 'task', outcome: 'done', used_memory_refs: [] })
    expect(JSON.parse(prompt.split('\n').at(-1)!)).toEqual({ schema_version: 1, task: 'task', outcome: 'done', used_memory_refs: [] })
  })
  it('validates structured create output and rejects malformed output', async () => {
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ decision: 'create', title: '经验', summary: '摘要', content: '正文', related_memory_refs: [] }) }] } } }] } }
    const factory = async (_parent: any, request: any) => {
      expect(request.outputContract).toContain('related_memory_refs is mandatory even when there are no related memories; emit []')
      expect(request.outputContract).toContain('Never create only because a memory was read')
      expect(request.outputContract).toContain('extends a used memory')
      return { agent: child as any, dispose: async () => undefined } as any
    }
    await expect(runConsolidationSubagentV3({} as any, { task: 'task', outcome: 'done', used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }, factory)).resolves.toMatchObject({ decision: 'create', title: '经验' })
  })
  it('does not turn protocol-invalid output into a fallback signal', async () => {
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{}' }] } } }] } }
    const factory = async () => ({ agent: child as any, dispose: async () => undefined }) as any
    await expect(runConsolidationSubagentV3({} as any, { task: 'task', outcome: 'done', used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }, factory)).rejects.toBeInstanceOf(SubagentProtocolError)
  })
})
