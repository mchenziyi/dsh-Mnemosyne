import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRecallSubagentPromptV3, createDshSubagentFactoryV3, runDshSubagentV3, type DshSubagentFactoryV3 } from '../src/v3/dsh-subagent.js'

describe('v3 dsh subagent adapter', () => {
  afterEach(() => { vi.useRealTimers() })
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
  it('emits a complete bounded diagnostic lifecycle without payloads', async () => {
    const diagnostics: any[] = []
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"decision":"skip"}' }] } } }] } }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: async () => undefined }) as any
    await runDshSubagentV3({} as any, { task: 'secret task', provider: 'p', model: 'm', signal: new AbortController().signal, onEvent: (event, detail) => diagnostics.push({ event, ...detail }) }, factory)
    expect(diagnostics.map((event) => event.event)).toEqual(['running', 'running', 'running', 'running', 'running', 'created', 'followup_sent', 'completed', 'disposed'])
    expect(diagnostics.map((event) => event.reason_code).filter(Boolean)).toContain('subagent_run_entered')
    expect(diagnostics.every((event) => Number.isInteger(event.elapsed_ms) && event.elapsed_ms >= 0)).toBe(true)
    expect(JSON.stringify(diagnostics)).not.toContain('secret task')
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
    const sections: any[] = []
    let createOptions: any
    const handle = { agent: {} as any, dispose: async () => undefined }
    const parent = { ctx: { agents: { create: async (options: any) => {
      createOptions = options
      await options.setup({ on: () => () => undefined, systemPrompt: { section: (value: any) => sections.push(value) }, tools: { restrict: (value: unknown) => restrictions.push(value), guard: (value: any) => guards.push(value) } })
      return handle
    } } }, session: { id: 'parent', header: { cwd: '/tmp/project' } } } as any
    const controller = new AbortController()
    const result = await createDshSubagentFactoryV3()(parent, { task: 'UNTRUSTED_TASK_EVIDENCE', outputContract: 'TRUSTED_STAGE_CONTRACT', provider: 'p', model: 'm', signal: controller.signal })
    expect(result).toBe(handle)
    expect(createOptions.signal).toBe(controller.signal)
    expect(createOptions.agentOptions).toMatchObject({ provider: 'p', model: 'm' })
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'deployment:persona', complete: true })
    expect(sections[0].text).toContain('TRUSTED_STAGE_CONTRACT')
    expect(sections[0].text).not.toContain('UNTRUSTED_TASK_EVIDENCE')
    expect(restrictions).toEqual([{ allow: [] }])
    expect(guards).toHaveLength(1)
    expect(guards[0]!({})).toBe('mnemosyne_subagent_tools_disabled')
  })
  it('classifies alpha4 setup and publication failures without leaking the raw error', async () => {
    for (const phase of ['setup', 'publish'] as const) {
      const diagnostics: any[] = []
      const parent = { ctx: { agents: { create: async (options: any) => {
        const commit = await options.setup({
          on: () => () => undefined,
          systemPrompt: { section: () => undefined },
          tools: {
            restrict: () => { if (phase === 'setup') throw new Error('secret setup failure') },
            guard: () => undefined,
          },
        })
        commit?.commit()
        if (phase === 'publish') throw new Error('secret publish failure')
        return { agent: {}, dispose: async () => undefined }
      } } }, session: { id: 'parent', header: { cwd: '/tmp/project' } } } as any
      await expect(createDshSubagentFactoryV3()(parent, {
        task: 'secret task', provider: 'p', model: 'm', signal: new AbortController().signal,
        onEvent: (event, detail) => diagnostics.push({ event, ...detail }),
      })).rejects.toMatchObject({ code: 'subagent_unavailable' })
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: 'error',
        reason_code: phase === 'setup' ? 'subagent_setup_failed' : 'subagent_publish_failed',
      }))
      expect(JSON.stringify(diagnostics)).not.toContain('secret')
    }
  })
  it('cancels and disposes an active child when the parent signal aborts', async () => {
    let disposed = false
    let cancelled = false
    let settleIdle!: () => void
    let resolveFollowup!: () => void
    const followupSent = new Promise<void>((resolve) => { resolveFollowup = resolve })
    const idle = new Promise<void>((resolve) => { settleIdle = resolve })
    const child = {
      followup: () => { resolveFollowup() },
      whenIdle: () => idle,
      cancel: (cause: unknown) => { expect(cause).toEqual({ kind: 'parent' }); cancelled = true; settleIdle() },
      session: { events: [] },
    }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: async () => { disposed = true } }) as any
    const controller = new AbortController()
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: controller.signal }, factory)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'subagent_aborted' })
    expect(cancelled).toBe(true)
    expect(disposed).toBe(true)
  })
  it('waits for a long-running child until the parent is cancelled', async () => {
    let disposed = false
    let cancelled = false
    let settleIdle!: () => void
    let resolveFollowup!: () => void
    const followupSent = new Promise<void>((resolve) => { resolveFollowup = resolve })
    const idle = new Promise<void>((resolve) => { settleIdle = resolve })
    const child = {
      followup: () => { resolveFollowup() },
      whenIdle: () => idle,
      cancel: () => { cancelled = true; settleIdle() },
      session: { events: [] },
    }
    let resolveCreated!: () => void
    const created = new Promise<void>((resolve) => { resolveCreated = resolve })
    const factory: DshSubagentFactoryV3 = async () => {
      resolveCreated()
      return ({ agent: child as any, dispose: async () => { disposed = true } }) as any
    }
    const controller = new AbortController()
    const running = runDshSubagentV3({} as any, { task: 'consolidate', provider: 'p', model: 'm', signal: controller.signal, form: 'consolidation' }, factory)
    await created
    await Promise.resolve()
    await followupSent
    const assertion = expect(running).rejects.toMatchObject({ code: 'subagent_aborted' })
    controller.abort()
    await assertion
    expect(cancelled).toBe(true)
    expect(disposed).toBe(true)
  })
  it('does not remain blocked when child disposal never settles', async () => {
    vi.useFakeTimers()
    const child = { followup: () => undefined, whenIdle: async () => undefined, session: { events: [] } }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: () => new Promise<void>(() => undefined) }) as any
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: new AbortController().signal }, factory)
    const assertion = expect(running).rejects.toMatchObject({ code: 'subagent_unavailable' })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })
  it('preserves cancellation when dispose throws synchronously', async () => {
    const controller = new AbortController()
    const child = { followup: () => undefined, whenIdle: () => new Promise<void>(() => undefined), cancel: () => controller.abort(), session: { events: [] } }
    const factory: DshSubagentFactoryV3 = async () => ({ agent: child as any, dispose: () => { throw new Error('dispose') } }) as any
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: controller.signal }, factory)
    const assertion = expect(running).rejects.toMatchObject({ code: 'subagent_aborted' })
    controller.abort()
    await assertion
  })
  it('times out while creating a child and reports the creating phase', async () => {
    vi.useFakeTimers()
    const diagnostics: any[] = []
    const factory: DshSubagentFactoryV3 = async () => new Promise(() => undefined)
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: new AbortController().signal, onEvent: (event, detail) => diagnostics.push({ event, ...detail }) }, factory)
    const assertion = expect(running).rejects.toMatchObject({ code: 'subagent_create_timeout' })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(diagnostics.filter((event) => event.reason_code === 'subagent_create_pending').length).toBeLessThanOrEqual(4)
    expect(diagnostics.some((event) => event.reason_code === 'subagent_create_pending')).toBe(true)
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'timeout', phase: 'creating', reason_code: 'subagent_create_timeout' }))
    expect(diagnostics.some((event) => event.event === 'created')).toBe(false)
  })
  it('disposes a handle that arrives after creation timeout', async () => {
    vi.useFakeTimers()
    let resolveFactory!: (handle: any) => void
    let disposed = false
    const factory: DshSubagentFactoryV3 = async () => new Promise((resolve) => { resolveFactory = resolve })
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: new AbortController().signal }, factory)
    const assertion = expect(running).rejects.toMatchObject({ code: 'subagent_create_timeout' })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    resolveFactory({ agent: {} as any, dispose: async () => { disposed = true } })
    await Promise.resolve()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    expect(disposed).toBe(true)
  })
  it('cancels a pending creation immediately when the parent aborts', async () => {
    vi.useFakeTimers()
    let observedAbort = false
    const factory: DshSubagentFactoryV3 = async (_parent, request) => {
      request.signal.addEventListener('abort', () => { observedAbort = true }, { once: true })
      return new Promise(() => undefined)
    }
    const controller = new AbortController()
    const running = runDshSubagentV3({} as any, { task: 'map', provider: 'p', model: 'm', signal: controller.signal }, factory)
    await Promise.resolve()
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'subagent_aborted' })
    expect(observedAbort).toBe(true)
  })
})
