import { describe, expect, it } from 'vitest'
import { buildRecallSubagentPromptV3, createDshSubagentFactoryV3, runDshSubagentV3, type DshSubagentFactoryV3 } from '../src/v3/dsh-subagent.js'

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
  it('uses the requested session event form for consolidation work', async () => {
    let source: any
    const child = { followup: (message: any) => { source = message.source }, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"decision":"skip"}' }] } } }] } }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: async () => undefined }) as any
    await runDshSubagentV3({} as any, { task: 'consolidate', provider: 'p', model: 'm', signal: new AbortController().signal, form: 'consolidation' }, factory)
    expect(source).toMatchObject({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice' })
  })
  it('creates a tool-free child and binds creation to the parent signal', async () => {
    const restrictions: unknown[] = []
    const guards: Array<(execution: unknown) => string | undefined> = []
    let createOptions: any
    const handle = { agent: {} as any, dispose: async () => undefined }
    const parent = { ctx: { agents: { create: async (options: any) => {
      createOptions = options
      await options.setup({ tools: { restrict: (value: unknown) => restrictions.push(value), guard: (value: any) => guards.push(value) } })
      return handle
    } } }, session: { id: 'parent', header: { cwd: '/tmp/project' } } } as any
    const controller = new AbortController()
    const result = await createDshSubagentFactoryV3()(parent, { task: 'recall', provider: 'p', model: 'm', signal: controller.signal })
    expect(result).toBe(handle)
    expect(createOptions.signal).toBe(controller.signal)
    expect(restrictions).toEqual([{ allow: [] }])
    expect(guards).toHaveLength(1)
    expect(guards[0]!({})).toBe('mnemosyne_subagent_tools_disabled')
  })
  it('cancels and disposes an active child when the parent signal aborts', async () => {
    let disposed = false
    let cancelled = false
    let settleIdle!: () => void
    const idle = new Promise<void>((resolve) => { settleIdle = resolve })
    const child = {
      followup: () => undefined,
      whenIdle: () => idle,
      cancel: (cause: unknown) => { expect(cause).toEqual({ kind: 'parent' }); cancelled = true; settleIdle() },
      session: { events: [] },
    }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: async () => { disposed = true } }) as any
    const controller = new AbortController()
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: controller.signal }, factory)
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'subagent_aborted' })
    expect(cancelled).toBe(true)
    expect(disposed).toBe(true)
  })
})
