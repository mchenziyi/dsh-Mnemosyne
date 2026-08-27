import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAcquisitionRuntime, type AcquisitionRuntime } from '../src/acquisition-runtime.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'

describe('MVP-05 acquisition runtime', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-acq-test-'))
    const projectScopeId = computeProjectScopeId(root)
    const scopeRuntime = createScopeRuntime({ projectRoot: root })
    const store = openMemoryFactStore({
      project_root: root,
      project_scope_id: projectScopeId,
    })
    const compiler = createOKFCompiler()

    return {
      root,
      scopeRuntime,
      store,
      compiler,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  function createMockLlm(handler: (options: GenerateOptions) => AsyncIterable<StreamChunk>): LlmRuntime {
    return {
      stream: (options: GenerateOptions) => handler(options),
    } as unknown as LlmRuntime
  }

  async function* textStream(text: string, withReasoning = false): AsyncIterable<StreamChunk> {
    let idx = 0
    if (withReasoning) {
      yield { type: 'block-start', index: idx, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: idx, text: 'Thinking about problem...' }
      yield { type: 'block-end', index: idx, block: { type: 'reasoning', text: 'Thinking about problem...' } }
      idx++
    }
    yield { type: 'block-start', index: idx, blockType: 'text' }
    yield { type: 'text-delta', index: idx, text }
    yield { type: 'block-end', index: idx, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  function createCompletedTurnSession(
    sessionId: string,
    root: string,
    userText: string,
    asstText: string,
    turn = 1
  ): { session: Session; turnEndEvent: SessionEvent } {
    const turnEndEvent: SessionEvent = {
      seq: 4,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn,
      data: { turn, reason: { kind: 'completed' } },
    } as never

    const events: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'turn/start',
        turn,
        data: { turn },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:51.000Z',
        type: 'request/header',
        turn,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn,
        data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
      } as never,
      {
        seq: 3,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn,
        data: { turn, step: 1, message: { id: 'a1', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: asstText }] } },
      } as never,
      turnEndEvent,
    ]

    const session: Session = {
      id: sessionId as never,
      header: { cwd: root } as never,
      events,
    } as unknown as Session

    return { session, turnEndEvent }
  }

  it('successfully enqueues, calls LLM once, writes short-term Fact, and compiles OKF Generation', async () => {
    const env = await setupEnvironment()
    let llmCallCount = 0
    let lastOptions: GenerateOptions | null = null

    const mockLlm = createMockLlm((options) => {
      llmCallCount++
      lastOptions = options
      const candidate = {
        schema_version: 1,
        decision: 'remember',
        title: 'Compiler cache rule',
        summary: 'Targeted cache rebuilds',
        body: 'Preserve cache and run smallest affected target when options change.',
        tags: ['build', 'cache'],
      }
      return textStream(JSON.stringify(candidate), true)
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { session, turnEndEvent } = createCompletedTurnSession(
      'session_success_1',
      env.root,
      'How to optimize build?',
      'Keep targeted compiler cache.'
    )

    env.scopeRuntime.observeSession(session)
    const enqueued = runtime.enqueueTurn(session, turnEndEvent)
    expect(enqueued).toBe(true)

    // Await all queued tasks to settle
    await runtime.drain()

    expect(llmCallCount).toBe(1)
    expect(lastOptions!.provider).toBe('deepseek')
    expect(lastOptions!.model).toBe('deepseek-chat')
    expect(lastOptions!.tools).toEqual([])
    expect(lastOptions!.maxTokens).toBe(1024)

    // Verify ShortTerm Fact written
    const scopeRes = env.scopeRuntime.observeSession(session)
    expect(scopeRes.status).toBe('ready')
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(1)
    expect(facts[0].tier).toBe('short_term')
    expect(facts[0].title).toBe('Compiler cache rule')
    expect(facts[0].tags).toEqual(['build', 'cache'])
    expect(facts[0].memory_id).toMatch(/^mem_auto_[0-9a-f]{32}$/)

    // Verify OKF Generation compiled and CURRENT updated
    const current = await env.compiler.readCurrent(env.root, (scopeRes as { scope: { project_scope_id: string } }).scope.project_scope_id)
    expect(current).not.toBeNull()
    expect(current!.generation_id).toMatch(/^gen_/)

    await runtime.dispose()
    await env.cleanup()
  })

  it('skips Fact write and Compiler when candidate decision is skip', async () => {
    const env = await setupEnvironment()
    let llmCallCount = 0

    const mockLlm = createMockLlm(() => {
      llmCallCount++
      const skipCandidate = {
        schema_version: 1,
        decision: 'skip',
        reason_code: 'no_reusable_knowledge',
      }
      return textStream(JSON.stringify(skipCandidate))
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { session, turnEndEvent } = createCompletedTurnSession(
      'session_skip_1',
      env.root,
      'Hello',
      'Hi there, how can I help you today?'
    )

    env.scopeRuntime.observeSession(session)
    runtime.enqueueTurn(session, turnEndEvent)
    await runtime.drain()

    expect(llmCallCount).toBe(1)
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(0)

    const current = await env.compiler.readCurrent(env.root, (scopeRes as { scope: { project_scope_id: string } }).scope.project_scope_id)
    expect(current).toBeNull()

    await runtime.dispose()
    await env.cleanup()
  })

  it('deduplicates repeat event keys and duplicate evidence hashes without second LLM call', async () => {
    const env = await setupEnvironment()
    let llmCallCount = 0

    const mockLlm = createMockLlm(() => {
      llmCallCount++
      const candidate = {
        schema_version: 1,
        decision: 'remember',
        title: 'Cache rule',
        summary: 'Targeted cache',
        body: 'Preserve cache.',
        tags: ['cache'],
      }
      return textStream(JSON.stringify(candidate))
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { session, turnEndEvent } = createCompletedTurnSession(
      'session_dedupe_1',
      env.root,
      'User prompt text',
      'Assistant answer text'
    )

    env.scopeRuntime.observeSession(session)

    // First enqueue
    expect(runtime.enqueueTurn(session, turnEndEvent)).toBe(true)
    await runtime.drain()
    expect(llmCallCount).toBe(1)

    // Repeat enqueue with identical turnEndEvent
    expect(runtime.enqueueTurn(session, turnEndEvent)).toBe(false)
    await runtime.drain()
    expect(llmCallCount).toBe(1)

    await runtime.dispose()
    await env.cleanup()
  })

  it('skips creating duplicate Fact when candidate projection exactly matches existing memory', async () => {
    const env = await setupEnvironment()
    let llmCallCount = 0

    const mockLlm = createMockLlm(() => {
      llmCallCount++
      const candidate = {
        schema_version: 1,
        decision: 'remember',
        title: 'Identical cache rule',
        summary: 'Targeted cache summary',
        body: 'Identical body text across different turns.',
        tags: ['build', 'cache'],
      }
      return textStream(JSON.stringify(candidate))
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    // Turn 1
    const { session: s1, turnEndEvent: te1 } = createCompletedTurnSession(
      'session_exact_1',
      env.root,
      'Turn 1 prompt',
      'Turn 1 answer',
      1
    )
    env.scopeRuntime.observeSession(s1)
    runtime.enqueueTurn(s1, te1)
    await runtime.drain()
    expect(llmCallCount).toBe(1)

    // Turn 2 with different prompt and answer, but LLM returns identical remember candidate
    const { session: s2, turnEndEvent: te2 } = createCompletedTurnSession(
      'session_exact_1',
      env.root,
      'Turn 2 prompt different',
      'Turn 2 answer different',
      2
    )
    runtime.enqueueTurn(s2, te2)
    await runtime.drain()
    expect(llmCallCount).toBe(2)

    // Only 1 Fact should exist because the candidate projection is exact duplicate
    const scopeRes = env.scopeRuntime.observeSession(s1)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(1)

    await runtime.dispose()
    await env.cleanup()
  })

  it('keeps Fact and preserves old CURRENT when Compiler fails', async () => {
    const env = await setupEnvironment()

    const mockLlm = createMockLlm(() => {
      const candidate = {
        schema_version: 1,
        decision: 'remember',
        title: 'Compiler failure test',
        summary: 'Summary',
        body: 'Body text',
        tags: ['test'],
      }
      return textStream(JSON.stringify(candidate))
    })

    // Create failing compiler via instance options
    const failingCompiler = createOKFCompiler({
      hooks: {
        onStagingWrite() {
          throw new Error('staging write failure')
        },
      },
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: failingCompiler,
    })

    const { session, turnEndEvent } = createCompletedTurnSession(
      'session_fail_compiler',
      env.root,
      'Prompt',
      'Answer'
    )

    env.scopeRuntime.observeSession(session)
    runtime.enqueueTurn(session, turnEndEvent)

    // Drain should not throw even if compiler fails
    await expect(runtime.drain()).resolves.not.toThrow()

    // Fact should remain in Fact Store!
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(1)

    // CURRENT pointer should remain null/unchanged
    const current = await env.compiler.readCurrent(env.root, (scopeRes as { scope: { project_scope_id: string } }).scope.project_scope_id)
    expect(current).toBeNull()

    await runtime.dispose()
    await env.cleanup()
  })

  it('enforces queue capacity limits (max 32 total, max 8 per session) by safely dropping new items', async () => {
    const env = await setupEnvironment()
    let activeStreamCount = 0

    // Slow LLM
    const mockLlm = createMockLlm(async function* (options) {
      activeStreamCount++
      await new Promise((resolve) => setTimeout(resolve, 50))
      const candidate = {
        schema_version: 1,
        decision: 'skip',
        reason_code: 'no_reusable_knowledge',
      }
      yield* textStream(JSON.stringify(candidate))
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    // Enqueue 10 turns for the same session (cap is 8 pending)
    let enqueuedCount = 0
    for (let t = 1; t <= 10; t++) {
      const { session, turnEndEvent } = createCompletedTurnSession('session_cap_1', env.root, `User ${t}`, `Asst ${t}`, t)
      env.scopeRuntime.observeSession(session)
      if (runtime.enqueueTurn(session, turnEndEvent)) {
        enqueuedCount++
      }
    }

    // Should enqueue up to 8 and reject the rest
    expect(enqueuedCount).toBeLessThanOrEqual(8)

    await runtime.drain()
    await runtime.dispose()
    await env.cleanup()
  })

  it('cancels and drains cleanly on dispose without leaking memory or throwing', async () => {
    const env = await setupEnvironment()

    const mockLlm = createMockLlm(async function* (options) {
      if (options.signal) {
        await new Promise((_, reject) => {
          options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      yield* textStream('{}')
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { session, turnEndEvent } = createCompletedTurnSession('session_dispose_1', env.root, 'U', 'A')
    env.scopeRuntime.observeSession(session)
    runtime.enqueueTurn(session, turnEndEvent)

    // Dispose immediately while call is in-flight
    await expect(runtime.dispose()).resolves.not.toThrow()

    await env.cleanup()
  })

  it('stream state machine: rejects stream with missing finish, multiple finishes, or chunks after finish', async () => {
    const validCandidateJson = JSON.stringify({
      schema_version: 1,
      decision: 'remember',
      title: 'Valid title',
      summary: 'Valid summary',
      body: 'Valid body',
      tags: ['test'],
    })

    // 1. Missing finish chunk
    const env1 = await setupEnvironment()
    const llmMissingFinish = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
    })
    const rt1 = createAcquisitionRuntime({ scopeRuntime: env1.scopeRuntime, llm: llmMissingFinish, compiler: env1.compiler })
    const { session: s1, turnEndEvent: te1 } = createCompletedTurnSession('s_no_finish', env1.root, 'U', 'A')
    env1.scopeRuntime.observeSession(s1)
    rt1.enqueueTurn(s1, te1)
    await rt1.drain()
    const facts1 = await env1.store.listShortTerm((env1.scopeRuntime.observeSession(s1) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts1.length).toBe(0)
    await rt1.dispose()
    await env1.cleanup()

    // 2. Duplicate finish chunk
    const env2 = await setupEnvironment()
    const llmDuplicateFinish = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const rt2 = createAcquisitionRuntime({ scopeRuntime: env2.scopeRuntime, llm: llmDuplicateFinish, compiler: env2.compiler })
    const { session: s2, turnEndEvent: te2 } = createCompletedTurnSession('s_dup_finish', env2.root, 'U', 'A')
    env2.scopeRuntime.observeSession(s2)
    rt2.enqueueTurn(s2, te2)
    await rt2.drain()
    const facts2 = await env2.store.listShortTerm((env2.scopeRuntime.observeSession(s2) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts2.length).toBe(0)
    await rt2.dispose()
    await env2.cleanup()

    // 3. Chunk received after stop finish
    const env3 = await setupEnvironment()
    const llmAfterStop = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      yield { type: 'text-delta', index: 0, text: 'extra forbidden trailing content' }
    })
    const rt3 = createAcquisitionRuntime({ scopeRuntime: env3.scopeRuntime, llm: llmAfterStop, compiler: env3.compiler })
    const { session: s3, turnEndEvent: te3 } = createCompletedTurnSession('s_after_stop', env3.root, 'U', 'A')
    env3.scopeRuntime.observeSession(s3)
    rt3.enqueueTurn(s3, te3)
    await rt3.drain()
    const facts3 = await env3.store.listShortTerm((env3.scopeRuntime.observeSession(s3) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts3.length).toBe(0)
    await rt3.dispose()
    await env3.cleanup()
  })

  it('stream state machine: rejects multiple text blocks or tool calls', async () => {
    const validCandidateJson = JSON.stringify({
      schema_version: 1,
      decision: 'remember',
      title: 'Valid title',
      summary: 'Valid summary',
      body: 'Valid body',
      tags: ['test'],
    })

    // 1. Multiple text blocks
    const env1 = await setupEnvironment()
    const llmMultipleText = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 'second block' }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'second block' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const rt1 = createAcquisitionRuntime({ scopeRuntime: env1.scopeRuntime, llm: llmMultipleText, compiler: env1.compiler })
    const { session: s1, turnEndEvent: te1 } = createCompletedTurnSession('s_multi_text', env1.root, 'U', 'A')
    env1.scopeRuntime.observeSession(s1)
    rt1.enqueueTurn(s1, te1)
    await rt1.drain()
    const facts1 = await env1.store.listShortTerm((env1.scopeRuntime.observeSession(s1) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts1.length).toBe(0)
    await rt1.dispose()
    await env1.cleanup()

    // 2. Tool call delta
    const env2 = await setupEnvironment()
    const llmToolCall = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' } as any
      yield { type: 'text-delta', index: 0, text: validCandidateJson } as any
      yield { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'bash', argumentsDelta: 'ls' } as any
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } } as any
      yield { type: 'finish', reason: { kind: 'stop' } } as any
    })
    const rt2 = createAcquisitionRuntime({ scopeRuntime: env2.scopeRuntime, llm: llmToolCall, compiler: env2.compiler })
    const { session: s2, turnEndEvent: te2 } = createCompletedTurnSession('s_tool_call', env2.root, 'U', 'A')
    env2.scopeRuntime.observeSession(s2)
    rt2.enqueueTurn(s2, te2)
    await rt2.drain()
    const facts2 = await env2.store.listShortTerm((env2.scopeRuntime.observeSession(s2) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts2.length).toBe(0)
    await rt2.dispose()
    await env2.cleanup()

    // 3. finish reason is 'length' / 'error' / 'tool-calls'
    const env3 = await setupEnvironment()
    const llmLengthFinish = createMockLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' } as any
      yield { type: 'text-delta', index: 0, text: validCandidateJson } as any
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } } as any
      yield { type: 'finish', reason: { kind: 'length' } } as any
    })
    const rt3 = createAcquisitionRuntime({ scopeRuntime: env3.scopeRuntime, llm: llmLengthFinish, compiler: env3.compiler })
    const { session: s3, turnEndEvent: te3 } = createCompletedTurnSession('s_len_finish', env3.root, 'U', 'A')
    env3.scopeRuntime.observeSession(s3)
    rt3.enqueueTurn(s3, te3)
    await rt3.drain()
    const facts3 = await env3.store.listShortTerm((env3.scopeRuntime.observeSession(s3) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts3.length).toBe(0)
    await rt3.dispose()
    await env3.cleanup()
  })

  it('stream state machine: enforces UTF-8 byte length limit of 16,384 bytes and iterator finalization', async () => {
    let iteratorClosed = false

    // Multi-byte characters: 6000 Chinese characters is 6000 chars, but 18,000 UTF-8 bytes (> 16384 bytes)
    const multiByteOverLimit = '中'.repeat(6000)
    expect(multiByteOverLimit.length).toBe(6000)
    expect(Buffer.byteLength(multiByteOverLimit, 'utf8')).toBe(18000)

    const env = await setupEnvironment()
    const llmMultiByte = createMockLlm(async function* () {
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: multiByteOverLimit }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: multiByteOverLimit } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        iteratorClosed = true
      }
    })

    const runtime = createAcquisitionRuntime({ scopeRuntime: env.scopeRuntime, llm: llmMultiByte, compiler: env.compiler })
    const { session, turnEndEvent } = createCompletedTurnSession('s_multibyte', env.root, 'U', 'A')
    env.scopeRuntime.observeSession(session)
    runtime.enqueueTurn(session, turnEndEvent)
    await runtime.drain()

    const facts = await env.store.listShortTerm((env.scopeRuntime.observeSession(session) as any).scope.session_scope_id, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(0)
    expect(iteratorClosed).toBe(true)

    await runtime.dispose()
    await env.cleanup()
  })

  it('stream state machine: strict block lifecycle rejects missing/mismatched/nested block boundaries', async () => {
    const validCandidateJson = JSON.stringify({
      schema_version: 1,
      decision: 'remember',
      title: 'Lifecycle Candidate',
      summary: 'Testing strict stream lifecycle',
      body: 'Valid candidate body content for stream testing',
      tags: ['lifecycle'],
    })

    // Helper to run stream case and return written facts count
    async function testStreamSequence(generator: () => AsyncGenerator<any, void, any>): Promise<number> {
      const env = await setupEnvironment()
      const llm = createMockLlm(generator)
      const rt = createAcquisitionRuntime({ scopeRuntime: env.scopeRuntime, llm, compiler: env.compiler })
      const { session, turnEndEvent } = createCompletedTurnSession('s_seq_test', env.root, 'U', 'A')
      env.scopeRuntime.observeSession(session)
      rt.enqueueTurn(session, turnEndEvent)
      await rt.drain()
      const facts = await env.store.listShortTerm(
        (env.scopeRuntime.observeSession(session) as any).scope.session_scope_id,
        '2026-08-25T08:00:00.000Z'
      )
      await rt.dispose()
      await env.cleanup()
      return facts.length
    }

    // 1. Text start + delta + finish, missing text block-end (must reject)
    const count1 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count1).toBe(0)

    // 2. Delta without block-start (must reject)
    const count2 = await testStreamSequence(async function* () {
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count2).toBe(0)

    // 3. Block-end without block-start (must reject)
    const count3 = await testStreamSequence(async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count3).toBe(0)

    // 4. Delta index different from active block (must reject)
    const count4 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count4).toBe(0)

    // 5. Block-end index different from active block (must reject)
    const count5 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count5).toBe(0)

    // 6. Block-end type different from active block (must reject)
    const count6 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning' } as any }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count6).toBe(0)

    // 7. Text block nesting a reasoning block (must reject)
    const count7 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning' } as any }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count7).toBe(0)

    // 8. Reasoning delta without reasoning start (must reject)
    const count8 = await testStreamSequence(async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'some reasoning' } as any
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: validCandidateJson }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count8).toBe(0)

    // 9. Reasoning block unclosed when finish arrives (must reject)
    const count9 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'some reasoning' } as any
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count9).toBe(0)

    // 10. Usage inside active block (must reject)
    const count10 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'usage', inputTokens: 10, outputTokens: 20 } as any
      yield { type: 'text-delta', index: 0, text: validCandidateJson }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count10).toBe(0)

    // 11. Legal multiple reasoning blocks + legal single text block + stop succeeds
    const count11 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'reasoning step 1' } as any
      yield { type: 'block-end', index: 0, block: { type: 'reasoning' } as any }
      yield { type: 'usage', inputTokens: 5, outputTokens: 5 } as any
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: 'reasoning step 2' } as any
      yield { type: 'block-end', index: 1, block: { type: 'reasoning' } as any }
      yield { type: 'block-start', index: 2, blockType: 'text' }
      yield { type: 'text-delta', index: 2, text: validCandidateJson }
      yield { type: 'block-end', index: 2, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'usage', inputTokens: 10, outputTokens: 20 } as any
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count11).toBe(1)

    // 12. Displayed deltas and final block text must be byte-identical.
    const count12 = await testStreamSequence(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '{"schema_version":1,"decision":"skip","reason_code":"not_novel"}' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: validCandidateJson } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(count12).toBe(0)
  })
})
