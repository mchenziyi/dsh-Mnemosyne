import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createRememberTool, type RememberRuntime } from '../src/remember-tool.js'
import { createAcquisitionRuntime } from '../src/acquisition-runtime.js'
import {
  createCandidateWriter,
  type CandidateWriter,
  type WriteCandidateParams,
  type WriteCandidateResult,
} from '../src/candidate-writer.js'
import {
  computeCandidateSha256,
  type RememberCandidate,
} from '../src/protocol/acquisition.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('MVP-05 mnemosyne_remember tool', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-remember-test-'))
    const projectScopeId = computeProjectScopeId(root)
    const scopeRuntime = createScopeRuntime({ projectRoot: root })
    const store = openMemoryFactStore({
      project_root: root,
      project_scope_id: projectScopeId,
    })
    const compiler = createOKFCompiler()

    return {
      root,
      projectScopeId,
      scopeRuntime,
      store,
      compiler,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  function createMockExecContext(
    sessionId: string,
    root: string,
    callId: string,
    toolCallTime = '2026-08-25T08:00:00.000Z'
  ): { exec: ToolRunContext; session: Session } {
    const toolCallEvent: SessionEvent = {
      seq: 3,
      time: toolCallTime,
      type: 'tool/call',
      turn: 1,
      step: 1,
      data: {
        turn: 1,
        step: 1,
        callId,
        name: 'mnemosyne_remember',
        arguments: '{}',
      },
    } as never

    const session: Session = {
      id: sessionId as never,
      header: { cwd: root } as never,
      events: [
        { seq: 0, time: '2026-08-25T07:59:50.000Z', type: 'turn/start', turn: 1, data: { turn: 1 } } as never,
        { seq: 1, time: '2026-08-25T07:59:51.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } } as never,
        { seq: 2, time: '2026-08-25T07:59:52.000Z', type: 'user/message', turn: 1, data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember this' }] } } as never,
        toolCallEvent,
      ],
    } as unknown as Session

    const agent: Agent = {
      id: sessionId as never,
      session,
    } as unknown as Agent

    const exec: ToolRunContext = {
      agent,
      callId: callId as never,
    } as unknown as ToolRunContext

    return { exec, session }
  }

  function createMockSessionWithTurnEnd(
    sessionId: string,
    root: string,
    callId: string,
    userPrompt = 'User question or instruction for acquisition evidence',
    assistantAnswer = 'Assistant complete visible response for evidence'
  ): { exec: ToolRunContext; session: Session; turnEndEvent: SessionEvent } {
    const toolCallEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'tool/call',
      turn: 1,
      step: 1,
      data: {
        turn: 1,
        step: 1,
        callId,
        name: 'mnemosyne_remember',
        arguments: '{}',
      },
    } as never

    const turnEndEvent: SessionEvent = {
      seq: 5,
      time: '2026-08-25T08:00:02.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const session: Session = {
      id: sessionId as never,
      header: { cwd: root } as never,
      events: [
        { seq: 0, time: '2026-08-25T07:59:50.000Z', type: 'turn/start', turn: 1, data: { turn: 1 } } as never,
        { seq: 1, time: '2026-08-25T07:59:51.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } } as never,
        { seq: 2, time: '2026-08-25T07:59:52.000Z', type: 'user/message', turn: 1, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: userPrompt }] } } as never,
        toolCallEvent,
        { seq: 4, time: '2026-08-25T08:00:01.000Z', type: 'assistant/message', turn: 1, data: { turn: 1, step: 1, message: { id: 'a1', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: assistantAnswer }] } } } as never,
        turnEndEvent,
      ],
    } as unknown as Session

    const agent: Agent = {
      id: sessionId as never,
      session,
    } as unknown as Agent

    const exec: ToolRunContext = {
      agent,
      callId: callId as never,
    } as unknown as ToolRunContext

    return { exec, session, turnEndEvent }
  }

  it('creates short-term memory Fact, compiles OKF Generation, and returns status: created', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { exec, session } = createMockExecContext('session_rem_1', env.root, 'call_rem_101')
    env.scopeRuntime.observeSession(session)

    const args = {
      title: 'Manual memory title',
      summary: 'Manual memory summary',
      body: 'Manual memory full body engineering knowledge.',
      tags: ['manual', 'engineering'],
    }

    const result = await (rememberTool.execute as any)(args, exec)
    expect(result).toBeDefined()
    expect(result.status).toBe('created')
    expect(result.memory_id).toMatch(/^mem_manual_[0-9a-f]{32}$/)
    expect(result.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(result.generation_id).toMatch(/^gen_/)

    // Verify Fact in store
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(1)
    expect(facts[0].memory_id).toBe(result.memory_id)
    expect(facts[0].tier).toBe('short_term')
    expect(facts[0].title).toBe('Manual memory title')
    expect(facts[0].created_at).toBe('2026-08-25T08:00:00.000Z')

    // Verify Current pointer updated
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).not.toBeNull()
    expect(current!.generation_id).toBe(result.generation_id)

    await env.cleanup()
  })

  it('replaying the identical durable tool call returns status: noop with identical output', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { exec, session } = createMockExecContext('session_rem_2', env.root, 'call_rem_102')
    env.scopeRuntime.observeSession(session)

    const args = {
      title: 'Manual title 2',
      summary: 'Manual summary 2',
      body: 'Manual body 2',
      tags: ['tag2'],
    }

    const first = await (rememberTool.execute as any)(args, exec)
    expect(first.status).toBe('created')

    // Second call with same execution context and args (replay)
    const second = await (rememberTool.execute as any)(args, exec)
    expect(second.status).toBe('noop')
    expect(second.memory_id).toBe(first.memory_id)
    expect(second.content_sha256).toBe(first.content_sha256)
    expect(second.generation_id).toBe(first.generation_id)

    await env.cleanup()
  })

  it('rejects invalid inputs, sensitive text, control characters, or unknown fields without leaking sensitive data', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { exec, session } = createMockExecContext('session_rem_3', env.root, 'call_rem_103')
    env.scopeRuntime.observeSession(session)

    // Missing title
    await expect((rememberTool.execute as any)({ summary: 's', body: 'b' }, exec)).rejects.toThrow()

    // Unknown field / caller trying to supply memory_id or tier
    await expect((rememberTool.execute as any)({
      title: 't',
      summary: 's',
      body: 'b',
      memory_id: 'mem_fake',
    }, exec)).rejects.toThrow()

    // Sensitive path leak
    await expect((rememberTool.execute as any)({
      title: 'Found in /Users/czy/Desktop/secret',
      summary: 's',
      body: 'b',
    }, exec)).rejects.toThrow()

    // Sensitive credential leak
    await expect((rememberTool.execute as any)({
      title: 't',
      summary: 'bearer abcdefghijklmnop',
      body: 'b',
    }, exec)).rejects.toThrow()

    // Control character
    await expect((rememberTool.execute as any)({
      title: 't\0',
      summary: 's',
      body: 'b',
    }, exec)).rejects.toThrow()

    await env.cleanup()
  })

  it('fails closed when missing agent context or when tool/call event is not found in session events', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { exec, session } = createMockExecContext('session_rem_4', env.root, 'call_rem_104')
    env.scopeRuntime.observeSession(session)

    const args = { title: 'T', summary: 'S', body: 'B' }

    // Missing exec
    await expect((rememberTool.execute as any)(args, undefined)).rejects.toThrow()

    // Missing exec.agent
    await expect((rememberTool.execute as any)(args, { callId: 'call_rem_104' } as never)).rejects.toThrow()

    // callId mismatch with session events
    const mismatchedExec: ToolRunContext = {
      agent: exec.agent,
      callId: 'call_unrecorded' as never,
    } as unknown as ToolRunContext
    await expect((rememberTool.execute as any)(args, mismatchedExec)).rejects.toThrow()

    await env.cleanup()
  })

  it('fails closed and throws sanitized error when compiler fails during remember execution', async () => {
    const env = await setupEnvironment()

    // Create failing compiler via instance options
    const failingCompiler = createOKFCompiler({
      hooks: {
        onStagingWrite() {
          throw new Error('staging write failure')
        },
      },
    })

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: failingCompiler,
    })

    const { exec, session } = createMockExecContext('session_rem_5', env.root, 'call_rem_105')
    env.scopeRuntime.observeSession(session)

    const args = { title: 'Compiler fail title', summary: 'S', body: 'B' }

    await expect((rememberTool.execute as any)(args, exec)).rejects.toThrow()

    // Fact remains written in Fact Store
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(1)

    // CURRENT remains null
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).toBeNull()

    await env.cleanup()
  })

  it('tightens identity: rejects tool/call events with non-matching tool name or duplicate callId', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    // 1. Tool name mismatch (e.g. call was for "fs_read")
    const { exec: execWrongName, session: sWrongName } = createMockExecContext('s_wrong_name', env.root, 'call_wrong')
    const toolCallEvent = sWrongName.events.find((e) => e.type === 'tool/call') as any
    toolCallEvent.data.name = 'fs_read'
    env.scopeRuntime.observeSession(sWrongName)

    // 2. Duplicate tool/call with identical callId and name
    const { exec: execDup, session: sDup } = createMockExecContext('s_dup_callid', env.root, 'call_dup')
    const validToolCall = sDup.events.find((e) => e.type === 'tool/call') as any
    ;(sDup.events as any[]).push({ ...validToolCall, seq: 4 })
    env.scopeRuntime.observeSession(sDup)

    await expect((rememberTool.execute as any)({ title: 'T', summary: 'S', body: 'B' }, execDup)).rejects.toThrow()

    // 3. Another tool with same callId
    const { exec: execAnother, session: sAnother } = createMockExecContext('s_another_callid', env.root, 'call_shared')
    ;(sAnother.events as any[]).push({
      seq: 4,
      time: '2026-08-25T08:00:01.000Z',
      type: 'tool/call',
      turn: 1,
      step: 2,
      data: { turn: 1, step: 2, callId: 'call_shared', name: 'other_tool', arguments: '{}' },
    } as never)
    env.scopeRuntime.observeSession(sAnother)
    await expect((rememberTool.execute as any)({ title: 'T', summary: 'S', body: 'B' }, execAnother)).rejects.toThrow()

    await env.cleanup()
  })

  it('concurrent remember calls with identical candidate write exactly 1 Fact, and loser returns noop', async () => {
    const env = await setupEnvironment()

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const { exec: exec1, session: s1 } = createMockExecContext('session_race_1', env.root, 'call_race_1')
    const { exec: exec2, session: s2 } = createMockExecContext('session_race_1', env.root, 'call_race_2', '2026-08-25T08:00:01.000Z')
    // S2 has the tool call for call_race_2 in its event list
    const toolCall2 = ((exec2.agent?.session.events ?? []) as any[]).find((e) => e.data?.callId === 'call_race_2')
    ;(s1.events as any[]).push(toolCall2)

    env.scopeRuntime.observeSession(s1)

    const identicalArgs = {
      title: 'Concurrent Race Candidate',
      summary: 'Race summary',
      body: 'Race body text should deduplicate safely without concurrency TOCTOU.',
      tags: ['race', 'concurrency'],
    }

    // Launch both executions concurrently
    const [res1, res2] = await Promise.all([
      (rememberTool.execute as any)(identicalArgs, exec1),
      (rememberTool.execute as any)(identicalArgs, exec2),
    ])

    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual(['created', 'noop'])
    expect(res1.memory_id).toBeDefined()
    expect(res2.memory_id).toBeDefined()

    // Exactly 1 Fact in store
    const scopeRes = env.scopeRuntime.observeSession(s1)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:05.000Z')
    expect(facts.length).toBe(1)

    await env.cleanup()
  })

  it('cross-entry concurrency: identical candidate across auto-acquisition and remember tool writes exactly 1 Fact, and loser returns noop', async () => {
    const env = await setupEnvironment()

    // Real underlying CandidateWriter
    const realWriter = createCandidateWriter({
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    // Decorator wrapper to record every write call and WriteResult without mocking any logic
    const writeCalls: WriteCandidateParams[] = []
    const writeResults: WriteCandidateResult[] = []
    const trackingWriter: CandidateWriter = {
      async write(params: WriteCandidateParams): Promise<WriteCandidateResult> {
        writeCalls.push(params)
        const result = await realWriter.write(params)
        writeResults.push(result)
        return result
      },
    }

    const candidatePayload: RememberCandidate = {
      schema_version: 1,
      decision: 'remember',
      title: 'Shared Cross-Entry Candidate',
      summary: 'Testing cross-entry race deduplication',
      body: 'Body content for cross-entry deduplication between auto-acquisition and remember tool.',
      tags: ['shared', 'cross_entry'],
    }

    const llmStartedDeferred = createDeferred<void>()
    const rememberTriggeredDeferred = createDeferred<void>()
    let llmStreamCallCount = 0

    const mockLlm = {
      stream: () => {
        llmStreamCallCount++
        return (async function* () {
          llmStartedDeferred.resolve()
          // Deterministic barrier: hold LLM stream until remember tool execution has begun
          await rememberTriggeredDeferred.promise

          const text = JSON.stringify(candidatePayload)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime

    const autoRuntime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      writer: trackingWriter,
    })

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      writer: trackingWriter,
    })

    // Create a complete session with both tool/call and durable turn/end with full assistant message
    const sessionId = 'session_cross_race_identical'
    const { exec, session, turnEndEvent } = createMockSessionWithTurnEnd(
      sessionId,
      env.root,
      'call_cross_race_ident',
      'User instruction text for acquisition evidence',
      'Assistant response text for acquisition evidence'
    )

    env.scopeRuntime.observeSession(session)

    // 1. Enqueue auto-acquisition turn (must succeed and return true)
    const enqueued = autoRuntime.enqueueTurn(session, turnEndEvent)
    expect(enqueued).toBe(true)

    // 2. Wait until autoRuntime has dequeued the item and called mock LLM stream
    await llmStartedDeferred.promise
    expect(llmStreamCallCount).toBe(1)

    // 3. Trigger remember tool with identical candidate
    const rememberPromise = (rememberTool.execute as any)(
      {
        title: candidatePayload.title,
        summary: candidatePayload.summary,
        body: candidatePayload.body,
        tags: candidatePayload.tags,
      },
      exec
    )

    // 4. Release LLM stream barrier so both entries race towards the shared CandidateWriter concurrently
    rememberTriggeredDeferred.resolve()

    // 5. Await both in-flight operations
    const [, rememberRes] = await Promise.all([
      autoRuntime.drain(),
      rememberPromise,
    ])

    // Assertions:
    // LLM stream was called exactly once
    expect(llmStreamCallCount).toBe(1)

    // Writer was invoked exactly 2 times (once by auto, once by remember)
    expect(writeCalls.length).toBe(2)
    expect(writeResults.length).toBe(2)

    // Both calls targeted the same candidate fingerprint
    expect(computeCandidateSha256(writeCalls[0].candidate)).toBe(computeCandidateSha256(writeCalls[1].candidate))

    // The two writer results are strictly one created and one noop
    const writerStatuses = writeResults.map((r) => r.status).sort()
    expect(writerStatuses).toEqual(['created', 'noop'])

    // Remember tool returned a valid status (either created or noop)
    expect(['created', 'noop']).toContain(rememberRes.status)

    // Exactly 1 Fact in Fact Store
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:05.000Z')
    expect(facts.length).toBe(1)
    expect(facts[0].title).toBe(candidatePayload.title)

    // CURRENT and Generation metadata are valid
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).not.toBeNull()
    const genMeta = await env.compiler.verifyGeneration(env.root, current!.generation_id)
    expect(genMeta.status).toBe('complete')

    // Check OKF Generation index.json: memory appears exactly once in entries
    const genIndex = JSON.parse(
      await readFile(join(env.root, '.dsh-mnemosyne', 'generations', current!.generation_id, 'index.json'), 'utf8')
    )
    const memoryEntries = genIndex.entries.filter((e: any) => e.memory_id === facts[0].memory_id)
    expect(memoryEntries.length).toBe(1)
    expect(memoryEntries[0].page_ref).toBe(`wiki/memories/${facts[0].memory_id}.md`)

    await autoRuntime.dispose()
    await env.cleanup()
  })

  it('cross-entry concurrency: different candidates across auto-acquisition and remember tool both create distinct Facts', async () => {
    const env = await setupEnvironment()

    // Real underlying CandidateWriter
    const realWriter = createCandidateWriter({
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    // Decorator wrapper to record every write call and WriteResult
    const writeCalls: WriteCandidateParams[] = []
    const writeResults: WriteCandidateResult[] = []
    const trackingWriter: CandidateWriter = {
      async write(params: WriteCandidateParams): Promise<WriteCandidateResult> {
        writeCalls.push(params)
        const result = await realWriter.write(params)
        writeResults.push(result)
        return result
      },
    }

    const candidateAuto: RememberCandidate = {
      schema_version: 1,
      decision: 'remember',
      title: 'Candidate Alpha from Auto Acquisition',
      summary: 'Testing distinct cross-entry candidate A',
      body: 'Alpha candidate body text for distinct concurrent write testing.',
      tags: ['alpha', 'auto'],
    }

    const candidateRemember: RememberCandidate = {
      schema_version: 1,
      decision: 'remember',
      title: 'Candidate Beta from Remember Tool',
      summary: 'Testing distinct cross-entry candidate B',
      body: 'Beta candidate body text for distinct concurrent write testing.',
      tags: ['beta', 'manual'],
    }

    const llmStartedDeferred = createDeferred<void>()
    const rememberTriggeredDeferred = createDeferred<void>()
    let llmStreamCallCount = 0

    const mockLlm = {
      stream: () => {
        llmStreamCallCount++
        return (async function* () {
          llmStartedDeferred.resolve()
          // Hold LLM stream until remember tool execution is in flight
          await rememberTriggeredDeferred.promise

          const text = JSON.stringify(candidateAuto)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime

    const autoRuntime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      writer: trackingWriter,
    })

    const rememberTool = createRememberTool({
      scopeRuntime: env.scopeRuntime,
      writer: trackingWriter,
    })

    const sessionId = 'session_cross_race_distinct'
    const { exec, session, turnEndEvent } = createMockSessionWithTurnEnd(
      sessionId,
      env.root,
      'call_cross_race_distinct',
      'User prompt text for distinct evidence',
      'Assistant response text for distinct evidence'
    )

    env.scopeRuntime.observeSession(session)

    // 1. Enqueue auto-acquisition turn (must return true)
    const enqueued = autoRuntime.enqueueTurn(session, turnEndEvent)
    expect(enqueued).toBe(true)

    // 2. Wait until autoRuntime enters mock LLM stream
    await llmStartedDeferred.promise
    expect(llmStreamCallCount).toBe(1)

    // 3. Trigger remember tool with distinct candidate
    const rememberPromise = (rememberTool.execute as any)(
      {
        title: candidateRemember.title,
        summary: candidateRemember.summary,
        body: candidateRemember.body,
        tags: candidateRemember.tags,
      },
      exec
    )

    // 4. Release LLM stream barrier
    rememberTriggeredDeferred.resolve()

    // 5. Await both concurrent operations
    const [, rememberRes] = await Promise.all([
      autoRuntime.drain(),
      rememberPromise,
    ])

    // Assertions:
    expect(llmStreamCallCount).toBe(1)
    expect(writeCalls.length).toBe(2)
    expect(writeResults.length).toBe(2)

    // Two candidates have distinct fingerprints
    expect(computeCandidateSha256(writeCalls[0].candidate)).not.toBe(computeCandidateSha256(writeCalls[1].candidate))

    // Both results are 'created'
    const writerStatuses = writeResults.map((r) => r.status).sort()
    expect(writerStatuses).toEqual(['created', 'created'])
    expect(rememberRes.status).toBe('created')

    // The two created memory IDs are distinct
    expect(writeResults[0].memory_id).not.toBe(writeResults[1].memory_id)

    // Fact Store has EXACTLY 2 facts
    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:05.000Z')
    expect(facts.length).toBe(2)
    const factTitles = facts.map((f) => f.title).sort()
    expect(factTitles).toEqual([candidateAuto.title, candidateRemember.title].sort())

    // CURRENT and Generation metadata are valid
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).not.toBeNull()
    const genMeta = await env.compiler.verifyGeneration(env.root, current!.generation_id)
    expect(genMeta.status).toBe('complete')

    // Both memory pages exist in the Generation index entries
    const genIndex = JSON.parse(
      await readFile(join(env.root, '.dsh-mnemosyne', 'generations', current!.generation_id, 'index.json'), 'utf8')
    )
    expect(genIndex.entries.length).toBe(2)
    const entryIds = genIndex.entries.map((e: any) => e.memory_id)
    expect(entryIds).toContain(writeResults[0].memory_id)
    expect(entryIds).toContain(writeResults[1].memory_id)

    await autoRuntime.dispose()
    await env.cleanup()
  })
})
