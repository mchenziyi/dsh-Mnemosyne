import { describe, expect, it } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { computeFactHash } from '../src/memory-fact.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { createManagementRuntime } from '../src/management-runtime.js'
import { createCandidateWriter } from '../src/candidate-writer.js'
import { createAcquisitionRuntime } from '../src/acquisition-runtime.js'
import { createMutationCoordinator, type MutationCoordinator } from '../src/mutation-coordinator.js'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface CoordinatorLogEvent {
  type: 'requested' | 'entered' | 'exited'
  tag: string
  projectScopeId: string
}

interface TagHooks {
  onRequested?: () => void
  onEntered?: () => void | Promise<void>
  onExited?: () => void
}

function createRecordingCoordinator(underlying: MutationCoordinator = createMutationCoordinator()) {
  const events: CoordinatorLogEvent[] = []
  let activeCount = 0
  let maxConcurrent = 0
  const tagStorage = new AsyncLocalStorage<string>()
  const tagHooks = new Map<string, TagHooks>()

  function setTagHooks(tag: string, hooks: TagHooks) {
    tagHooks.set(tag, hooks)
  }

  async function runTagged<T>(
    tag: string,
    projectScopeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    events.push({ type: 'requested', tag, projectScopeId })
    const hooks = tagHooks.get(tag)
    hooks?.onRequested?.()

    return underlying.run(projectScopeId, async () => {
      activeCount++
      if (activeCount > maxConcurrent) maxConcurrent = activeCount
      events.push({ type: 'entered', tag, projectScopeId })

      if (hooks?.onEntered) {
        await hooks.onEntered()
      }

      try {
        return await operation()
      } finally {
        activeCount--
        events.push({ type: 'exited', tag, projectScopeId })
        hooks?.onExited?.()
      }
    })
  }

  const coordinator: MutationCoordinator = {
    async run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T> {
      const currentTag = tagStorage.getStore() ?? 'default'
      return runTagged(currentTag, projectScopeId, operation)
    },
  }

  function forTag(tag: string): MutationCoordinator {
    return {
      run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T> {
        return runTagged(tag, projectScopeId, operation)
      },
    }
  }

  function runWithTag<T>(tag: string, fn: () => T): T {
    return tagStorage.run(tag, fn)
  }

  return {
    coordinator,
    forTag,
    runWithTag,
    setTagHooks,
    events,
    getMaxConcurrent: () => maxConcurrent,
  }
}

describe('MVP-06 Final Review: MutationCoordinator & Cross-Entry Deterministic Barriers', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-coord-test-'))
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

  function createMockExec(
    sessionId: string,
    root: string,
    callId: string,
    toolName: string,
    time = '2026-08-25T08:00:00.000Z'
  ) {
    const session: Session = {
      id: sessionId as never,
      header: { cwd: root } as never,
      events: [
        { seq: 0, time: '2026-08-25T07:50:00.000Z', type: 'turn/start', turn: 1, data: { turn: 1 } } as never,
        {
          seq: 1,
          time,
          type: 'tool/call',
          turn: 1,
          step: 1,
          data: {
            turn: 1,
            step: 1,
            callId,
            name: toolName,
            arguments: '{}',
          },
        } as never,
      ],
    } as unknown as Session

    const agent: Agent = { id: sessionId as never, session } as unknown as Agent
    const exec: ToolRunContext = { agent, callId: callId as never } as unknown as ToolRunContext

    return { exec, session }
  }

  async function* textStream(text: string): AsyncIterable<any> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  describe('1. Coordinator Unit & Identity-Safe Map Cleanup', () => {
    it('executes same-project operations in FIFO order and handles rejections without breaking chain', async () => {
      const coordinator = createMutationCoordinator()
      const p1 = 'sha256_proj1'
      const executionOrder: number[] = []

      const op1 = coordinator.run(p1, async () => {
        executionOrder.push(1)
        return 'res1'
      })

      const op2 = coordinator.run(p1, async () => {
        executionOrder.push(2)
        throw new Error('op2 failed')
      })

      const op3 = coordinator.run(p1, async () => {
        executionOrder.push(3)
        return 'res3'
      })

      expect(await op1).toBe('res1')
      await expect(op2).rejects.toThrow('op2 failed')
      expect(await op3).toBe('res3')
      expect(executionOrder).toEqual([1, 2, 3])
    })

    it('runs operations across different projects concurrently without blocking each other', async () => {
      const coordinator = createMutationCoordinator()
      const p1 = 'sha256_proj1'
      const p2 = 'sha256_proj2'

      const p1Entered = createDeferred()
      const p1Release = createDeferred()
      const p2Entered = createDeferred()

      const task1 = coordinator.run(p1, async () => {
        p1Entered.resolve()
        await p1Release.promise
        return 'done1'
      })

      // Wait until task1 enters
      await p1Entered.promise

      // task2 in project 2 should enter immediately despite project 1 being paused
      const task2 = coordinator.run(p2, async () => {
        p2Entered.resolve()
        return 'done2'
      })

      await p2Entered.promise
      const res2 = await task2
      expect(res2).toBe('done2')

      // Unblock project 1
      p1Release.resolve()
      const res1 = await task1
      expect(res1).toBe('done1')
    })

    it('performs identity-safe cleanup so older task finally never deletes a newer tail', async () => {
      const coordinator = createMutationCoordinator()
      const p = 'sha256_cleanup_proj'

      const def1 = createDeferred()
      const def2 = createDeferred()
      const order: number[] = []

      // Task 1 runs and holds
      const t1 = coordinator.run(p, async () => {
        order.push(1)
        await def1.promise
        return 't1'
      })

      // While Task 1 is running, queue Task 2 and Task 3
      const t2 = coordinator.run(p, async () => {
        order.push(2)
        await def2.promise
        return 't2'
      })

      const t3 = coordinator.run(p, async () => {
        order.push(3)
        return 't3'
      })

      // Release Task 1. Task 1's finally should NOT delete the queue since tail is now Task 3.
      def1.resolve()
      expect(await t1).toBe('t1')

      // Release Task 2. Task 2's finally should NOT delete the queue since tail is now Task 3.
      def2.resolve()
      expect(await t2).toBe('t2')

      // Task 3 completes. Task 3's finally cleans up the queue.
      expect(await t3).toBe('t3')

      expect(order).toEqual([1, 2, 3])

      // Enqueue a subsequent Task 4 to verify queue operates freshly and cleanly
      const t4 = coordinator.run(p, async () => {
        return 't4'
      })
      expect(await t4).toBe('t4')
    })
  })

  describe('2. Deterministic Deferred Barrier: Auto Acquisition + Promote Shared Coordinator Proof', () => {
    it('proves CandidateWriter and ManagementRuntime share the same Coordinator critical section', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_barrier_auto_promote'

      const recording = createRecordingCoordinator()

      let llmCallCount = 0
      const mockLlm: any = {
        stream: () => {
          llmCallCount++
          const candidate = {
            schema_version: 1,
            decision: 'remember',
            title: 'Auto Title Shared Barrier',
            summary: 'Auto Summary Shared Barrier',
            body: 'Auto Body Shared Barrier',
            tags: ['auto', 'barrier'],
          }
          return textStream(JSON.stringify(candidate))
        },
      }

      // Complete session turn events
      const session: Session = {
        id: sessionId as never,
        header: { cwd: env.root } as never,
        events: [
          { seq: 0, time: '2026-08-25T07:50:00.000Z', type: 'turn/start', turn: 1, data: { turn: 1 } } as never,
          {
            seq: 1,
            time: '2026-08-25T07:50:01.000Z',
            type: 'request/header',
            turn: 1,
            data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
          } as never,
          {
            seq: 2,
            time: '2026-08-25T07:50:02.000Z',
            type: 'user/message',
            turn: 1,
            data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Important data' }] },
          } as never,
          {
            seq: 3,
            time: '2026-08-25T07:50:03.000Z',
            type: 'assistant/message',
            turn: 1,
            data: {
              turn: 1,
              step: 1,
              message: {
                id: 'a1',
                source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
                content: [{ type: 'text', text: 'I understand.' }],
              },
            },
          } as never,
          {
            seq: 4,
            time: '2026-08-25T07:50:04.000Z',
            type: 'tool/call',
            turn: 1,
            step: 1,
            data: {
              turn: 1,
              step: 1,
              callId: 'call_promote_barrier',
              name: 'mnemosyne_promote',
              arguments: '{}',
            },
          } as never,
          {
            seq: 5,
            time: '2026-08-25T07:50:05.000Z',
            type: 'turn/end',
            turn: 1,
            data: { turn: 1, reason: { kind: 'completed' } },
          } as never,
        ],
      } as unknown as Session

      const agent: Agent = { id: sessionId as never, session } as unknown as Agent
      const exec: ToolRunContext = { agent, callId: 'call_promote_barrier' as never } as unknown as ToolRunContext

      const scope = (env.scopeRuntime.observeSession(session) as any).scope

      // Write short fact to promote
      const shortFactBase = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        project_scope_id: env.projectScopeId,
        session_scope_id: scope.session_scope_id,
        memory_id: 'mem_to_promote_barrier',
        title: 'Short to Promote Barrier',
        summary: 'Summary to Promote Barrier',
        body: 'Body to Promote Barrier',
        tags: ['barrier'],
        created_at: '2026-08-25T07:00:00.000Z',
        expires_at: '2026-09-01T07:00:00.000Z',
      }
      const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
      await env.store.putShortTerm(scope.session_scope_id, shortFact)

      await env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T07:05:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      // Setup deferred signals for Auto + Promote
      const autoEntered = createDeferred()
      const autoRelease = createDeferred()
      const promoteRequested = createDeferred()
      const promoteEntered = createDeferred()

      recording.setTagHooks('auto', {
        onEntered: async () => {
          autoEntered.resolve()
          await autoRelease.promise
        },
      })

      recording.setTagHooks('promote', {
        onRequested: () => {
          promoteRequested.resolve()
        },
        onEntered: () => {
          promoteEntered.resolve()
        },
      })

      const writer = createCandidateWriter({
        storeFactory: () => env.store,
        compiler: env.compiler,
        coordinator: recording.forTag('auto'),
      })

      const acqRuntime = createAcquisitionRuntime({
        scopeRuntime: env.scopeRuntime,
        llm: mockLlm,
        writer,
      })

      const runtime = createManagementRuntime({
        scopeRuntime: env.scopeRuntime,
        storeFactory: () => env.store,
        compiler: env.compiler,
        coordinator: recording.coordinator,
      })

      const turnEndEvent = session.events[5]

      // 1. Enqueue Auto Acquisition
      const enqueued = acqRuntime.enqueueTurn(session, turnEndEvent)
      expect(enqueued).toBe(true)

      // 2. Wait until auto acquisition enters coordinator critical section
      await autoEntered.promise

      // 3. Launch promote while auto is held inside coordinator
      const promotePromise = recording.runWithTag('promote', () =>
        runtime.promote({ memory_id: 'mem_to_promote_barrier' }, exec)
      )

      // 4. Wait until promote calls coordinator.run
      await promoteRequested.promise

      // 5. Assert: At this instant, auto has entered, promote is requested, but promote has NOT entered
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'auto', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'auto', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      // 6. Release auto barrier
      autoRelease.resolve()

      // 7. Wait until promote genuinely enters critical section after auto exits
      await promoteEntered.promise

      const [, promoteRes] = await Promise.all([acqRuntime.drain(), promotePromise])
      expect(promoteRes.status).toBe('created')

      // 8. Assert complete, exact event sequence
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'auto', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'auto', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'auto', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'promote', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      // Verify CURRENT contains both
      const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
      expect(current).not.toBeNull()

      const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_b', 'mnemosyne_list')
      const listRes = await runtime.list({}, execList)
      const ids = listRes.items.map((i) => i.memory_id)
      expect(ids).toContain(promoteRes.memory_id)
      expect(ids).not.toContain('mem_to_promote_barrier')

      await env.cleanup()
    })
  })

  describe('3. Deterministic Deferred Barrier: Forget + Promote (Both Orderings)', () => {
    it('proves Forget first then Promote second are serialized through shared coordinator', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_barrier_forget_promote'

      const recording = createRecordingCoordinator()

      const { exec: execInit } = createMockExec(sessionId, env.root, 'call_init', 'mnemosyne_forget')
      const scope = (env.scopeRuntime.observeSession((execInit.agent as any).session) as any).scope

      const shortFactBase = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        project_scope_id: env.projectScopeId,
        session_scope_id: scope.session_scope_id,
        memory_id: 'mem_fp_barrier',
        title: 'FP Barrier Title',
        summary: 'FP Barrier Summary',
        body: 'FP Barrier Body',
        tags: ['fp'],
        created_at: '2026-08-25T07:00:00.000Z',
        expires_at: '2026-09-01T07:00:00.000Z',
      }
      const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
      await env.store.putShortTerm(scope.session_scope_id, shortFact)

      await env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T07:05:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const forgetEntered = createDeferred()
      const forgetRelease = createDeferred()
      const promoteRequested = createDeferred()
      const promoteEntered = createDeferred()

      recording.setTagHooks('forget', {
        onEntered: async () => {
          forgetEntered.resolve()
          await forgetRelease.promise
        },
      })

      recording.setTagHooks('promote', {
        onRequested: () => {
          promoteRequested.resolve()
        },
        onEntered: () => {
          promoteEntered.resolve()
        },
      })

      const runtime = createManagementRuntime({
        scopeRuntime: env.scopeRuntime,
        storeFactory: () => env.store,
        compiler: env.compiler,
        coordinator: recording.coordinator,
      })

      const { exec: execF } = createMockExec(sessionId, env.root, 'call_f_barrier', 'mnemosyne_forget')
      const { exec: execP } = createMockExec(sessionId, env.root, 'call_p_barrier', 'mnemosyne_promote')

      // 1. Launch Forget
      const forgetPromise = recording.runWithTag('forget', () =>
        runtime.forget({ tier: 'short_term', memory_id: 'mem_fp_barrier' }, execF)
      )

      // 2. Wait until forget enters critical section
      await forgetEntered.promise

      // 3. Launch Promote while forget is held inside coordinator
      const promotePromise = recording.runWithTag('promote', () =>
        runtime.promote({ memory_id: 'mem_fp_barrier' }, execP)
      )

      // 4. Wait until promote requests coordinator.run
      await promoteRequested.promise

      // 5. Assert: forget has entered, promote is requested, but promote has NOT entered
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      // 6. Release Forget barrier
      forgetRelease.resolve()

      // 7. Wait until promote enters after forget exits
      await promoteEntered.promise

      const [forgetRes, promoteRes] = await Promise.all([forgetPromise, promotePromise])
      expect(forgetRes.status).toBe('created')
      expect(promoteRes.status).toBe('created')

      // 8. Assert complete event sequence
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'promote', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      // Verify status priority: forgotten > promoted
      const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_fp', 'mnemosyne_list')
      const listRes = await runtime.list({ include_inactive: true }, execList)
      const shortItem = listRes.items.find((i) => i.memory_id === 'mem_fp_barrier')
      expect(shortItem?.state).toBe('forgotten')

      await env.cleanup()
    })

    it('proves Promote first then Forget second are serialized through shared coordinator', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_barrier_promote_forget'

      const recording = createRecordingCoordinator()

      const { exec: execInit } = createMockExec(sessionId, env.root, 'call_init_pf', 'mnemosyne_promote')
      const scope = (env.scopeRuntime.observeSession((execInit.agent as any).session) as any).scope

      const shortFactBase = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        project_scope_id: env.projectScopeId,
        session_scope_id: scope.session_scope_id,
        memory_id: 'mem_pf_barrier',
        title: 'PF Barrier Title',
        summary: 'PF Barrier Summary',
        body: 'PF Barrier Body',
        tags: ['pf'],
        created_at: '2026-08-25T07:00:00.000Z',
        expires_at: '2026-09-01T07:00:00.000Z',
      }
      const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
      await env.store.putShortTerm(scope.session_scope_id, shortFact)

      await env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T07:05:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const promoteEntered = createDeferred()
      const promoteRelease = createDeferred()
      const forgetRequested = createDeferred()
      const forgetEntered = createDeferred()

      recording.setTagHooks('promote', {
        onEntered: async () => {
          promoteEntered.resolve()
          await promoteRelease.promise
        },
      })

      recording.setTagHooks('forget', {
        onRequested: () => {
          forgetRequested.resolve()
        },
        onEntered: () => {
          forgetEntered.resolve()
        },
      })

      const runtime = createManagementRuntime({
        scopeRuntime: env.scopeRuntime,
        storeFactory: () => env.store,
        compiler: env.compiler,
        coordinator: recording.coordinator,
      })

      const { exec: execP } = createMockExec(sessionId, env.root, 'call_p_barrier_2', 'mnemosyne_promote')
      const { exec: execF } = createMockExec(sessionId, env.root, 'call_f_barrier_2', 'mnemosyne_forget')

      // 1. Launch Promote
      const promotePromise = recording.runWithTag('promote', () =>
        runtime.promote({ memory_id: 'mem_pf_barrier' }, execP)
      )

      // 2. Wait until promote enters
      await promoteEntered.promise

      // 3. Launch Forget while promote is held
      const forgetPromise = recording.runWithTag('forget', () =>
        runtime.forget({ tier: 'short_term', memory_id: 'mem_pf_barrier' }, execF)
      )

      // 4. Wait until forget requests coordinator.run
      await forgetRequested.promise

      // 5. Assert: promote has entered, forget is requested, but forget has NOT entered
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'forget', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      // 6. Release Promote barrier
      promoteRelease.resolve()

      // 7. Wait until forget enters after promote exits
      await forgetEntered.promise

      const [promoteRes, forgetRes] = await Promise.all([promotePromise, forgetPromise])
      expect(promoteRes.status).toBe('created')
      expect(forgetRes.status).toBe('created')

      // 8. Assert complete event sequence
      expect(recording.events).toEqual([
        { type: 'requested', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'requested', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'promote', projectScopeId: env.projectScopeId },
        { type: 'entered', tag: 'forget', projectScopeId: env.projectScopeId },
        { type: 'exited', tag: 'forget', projectScopeId: env.projectScopeId },
      ])
      expect(recording.getMaxConcurrent()).toBe(1)

      const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_pf', 'mnemosyne_list')
      const listRes = await runtime.list({ include_inactive: true }, execList)
      const shortItem = listRes.items.find((i) => i.memory_id === 'mem_pf_barrier')
      expect(shortItem?.state).toBe('forgotten')

      await env.cleanup()
    })
  })
})
