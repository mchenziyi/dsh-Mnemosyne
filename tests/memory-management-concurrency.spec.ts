import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { computeFactHash } from '../src/memory-fact.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { createManagementRuntime } from '../src/management-runtime.js'

describe('MVP-06E: Memory Management Concurrency and CAS Replays', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-m06-conc-'))
    const projectScopeId = computeProjectScopeId(root)
    const scopeRuntime = createScopeRuntime({ projectRoot: root })
    const store = openMemoryFactStore({
      project_root: root,
      project_scope_id: projectScopeId,
    })
    const compiler = createOKFCompiler()
    const runtime = createManagementRuntime({
      scopeRuntime,
      storeFactory: () => store,
      compiler,
    })

    return {
      root,
      projectScopeId,
      scopeRuntime,
      store,
      compiler,
      runtime,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  function createMockExec(sessionId: string, root: string, callId: string, toolName: string, time = '2026-08-25T08:00:00.000Z') {
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

  it('handles 16 concurrent promote calls on the same short-term memory cleanly with CAS (1 created, 15 noop)', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_conc_promote'
    const { exec: initExec } = createMockExec(sessionId, env.root, 'call_init', 'mnemosyne_promote')
    const scope = (env.scopeRuntime.observeSession((initExec.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_racing_promote',
      title: 'Racing Promote Title',
      summary: 'Racing Promote Summary',
      body: 'Racing Promote Body',
      tags: ['racing'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Fire 16 concurrent promote calls with unique callIds
    const concurrency = 16
    const tasks = Array.from({ length: concurrency }, (_, idx) => {
      const { exec } = createMockExec(sessionId, env.root, `call_p_${idx}`, 'mnemosyne_promote')
      return env.runtime.promote({ memory_id: 'mem_racing_promote' }, exec)
    })

    const results = await Promise.all(tasks)

    const createdCount = results.filter((r) => r.status === 'created').length
    const noopCount = results.filter((r) => r.status === 'noop').length

    expect(createdCount).toBe(1)
    expect(noopCount).toBe(concurrency - 1)

    // All results must have identical memory_id
    const memoryIds = new Set(results.map((r) => r.memory_id))
    expect(memoryIds.size).toBe(1)

    // Long-term facts in store must contain exactly 1 item
    const longFacts = await env.store.listLongTerm()
    expect(longFacts).toHaveLength(1)
    expect(longFacts[0].memory_id).toBe(results[0].memory_id)

    await env.cleanup()
  })

  it('handles 16 concurrent forget calls on the same memory cleanly with CAS (1 created, 15 noop)', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_conc_forget'
    const { exec: initExec } = createMockExec(sessionId, env.root, 'call_init', 'mnemosyne_forget')
    const scope = (env.scopeRuntime.observeSession((initExec.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_racing_forget',
      title: 'Racing Forget Title',
      summary: 'Racing Forget Summary',
      body: 'Racing Forget Body',
      tags: ['racing'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Fire 16 concurrent forget calls with unique callIds
    const concurrency = 16
    const tasks = Array.from({ length: concurrency }, (_, idx) => {
      const { exec } = createMockExec(sessionId, env.root, `call_f_${idx}`, 'mnemosyne_forget')
      return env.runtime.forget({ tier: 'short_term', memory_id: 'mem_racing_forget' }, exec)
    })

    const results = await Promise.all(tasks)

    const createdCount = results.filter((r) => r.status === 'created').length
    const noopCount = results.filter((r) => r.status === 'noop').length

    expect(createdCount).toBe(1)
    expect(noopCount).toBe(concurrency - 1)

    // All results must have identical forget_id
    const forgetIds = new Set(results.map((r) => r.forget_id))
    expect(forgetIds.size).toBe(1)

    // Forget facts in store must contain exactly 1 item
    const forgetFacts = await env.store.listForget()
    expect(forgetFacts).toHaveLength(1)
    expect(forgetFacts[0].forget_id).toBe(results[0].forget_id)

    await env.cleanup()
  })

  it('cross-entry concurrency: auto acquisition and promote race on shared coordinator without busy error', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_auto_promote_race'

    const { createMutationCoordinator } = await import('../src/mutation-coordinator.js')
    const coordinator = createMutationCoordinator()

    async function* textStream(text: string): AsyncIterable<any> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    let llmCallCount = 0
    const mockLlm: any = {
      stream: () => {
        llmCallCount++
        const candidate = {
          schema_version: 1,
          decision: 'remember',
          title: 'Auto Acquired Title',
          summary: 'Auto Acquired Summary',
          body: 'Auto Acquired Body',
          tags: ['auto'],
        }
        return textStream(JSON.stringify(candidate))
      },
    }

    // Set up a session with user message, assistant message, and turn/end
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
          data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Important information to remember' }] },
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
              content: [{ type: 'text', text: 'I understand and will remember that.' }],
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
            callId: 'call_race_p',
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
    const exec: ToolRunContext = { agent, callId: 'call_race_p' as never } as unknown as ToolRunContext

    const scope = (env.scopeRuntime.observeSession(session) as any).scope

    // Write a short-term fact to be promoted
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_to_promote_race',
      title: 'Short to Promote Race',
      summary: 'Summary to Promote Race',
      body: 'Body to Promote Race',
      tags: ['race'],
      created_at: '2026-08-25T07:00:00.000Z',
      expires_at: '2026-09-01T07:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T07:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    const { createCandidateWriter } = await import('../src/candidate-writer.js')
    const { createAcquisitionRuntime } = await import('../src/acquisition-runtime.js')
    const writer = createCandidateWriter({ storeFactory: () => env.store, compiler: env.compiler, coordinator })
    const acqRuntime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      writer,
    })
    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: env.compiler,
      coordinator,
    })

    const turnEndEvent = session.events[5]
    // Concurrently trigger auto acquisition and promote
    const autoPromise = (async () => {
      const enqueued = acqRuntime.enqueueTurn(session, turnEndEvent)
      expect(enqueued).toBe(true)
      await acqRuntime.drain()
    })()

    const promotePromise = runtime.promote({ memory_id: 'mem_to_promote_race' }, exec)

    const [, promoteRes] = await Promise.all([autoPromise, promotePromise])
    expect(promoteRes.status).toBe('created')
    expect(llmCallCount).toBe(1)

    // Verify CURRENT contains both the new auto short-term fact and the promoted long-term fact
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).not.toBeNull()

    const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_check', 'mnemosyne_list')
    const listRes = await env.runtime.list({}, execList)

    const memoryIds = listRes.items.map((i) => i.memory_id)
    expect(memoryIds).toContain(promoteRes.memory_id) // long-term
    expect(memoryIds).not.toContain('mem_to_promote_race') // source short-term excluded

    const autoShort = listRes.items.find((i) => i.title === 'Auto Acquired Title')
    expect(autoShort).toBeDefined()
    expect(autoShort?.tier).toBe('short_term')

    await env.cleanup()
  })

  it('cross-entry concurrency: forget invalidates active search grant, preventing open', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_forget_grant'

    const { createProductionRetrievalRuntime } = await import('../src/okf-retrieval-runtime.js')
    const { createSearchTool } = await import('../src/search-tool.js')
    const { createOpenTool } = await import('../src/open-tool.js')

    const retrievalRuntime = createProductionRetrievalRuntime(env.scopeRuntime)
    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: env.compiler,
      onForgetCommitted: () => {
        retrievalRuntime.clear()
      },
    })

    const { exec: exec1 } = createMockExec(sessionId, env.root, 'call_f_grant_1', 'mnemosyne_search')
    const scope = (env.scopeRuntime.observeSession((exec1.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_grant_target',
      title: 'Secret Auth Token Design',
      summary: 'Auth Token Summary',
      body: 'Auth Token Full Body Content',
      tags: ['auth'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Compile into generation
    await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    // 1. Search to obtain Grant
    const searchRes = await retrievalRuntime.search({ query: 'Auth Token' }, exec1)
    expect(searchRes.items.length).toBeGreaterThan(0)
    const item = searchRes.items[0]

    // 2. Forget the memory
    const { exec: execForget } = createMockExec(sessionId, env.root, 'call_forget_grant', 'mnemosyne_forget')
    await runtime.forget({ tier: 'short_term', memory_id: 'mem_grant_target' }, execForget)

    // 3. Attempting to open with previous grant MUST fail
    const { exec: execOpen } = createMockExec(sessionId, env.root, 'call_open_grant', 'mnemosyne_open')
    await expect(
      retrievalRuntime.open(
        {
          retrieval_id: searchRes.retrieval_id,
          search_disclosure_sha256: searchRes.content_sha256,
          memory_id: 'mem_grant_target',
        },
        execOpen
      )
    ).rejects.toThrow()

    // 4. New search does not return forgotten memory
    const { exec: execSearch2 } = createMockExec(sessionId, env.root, 'call_search_2', 'mnemosyne_search')
    const searchRes2 = await retrievalRuntime.search({ query: 'Auth Token' }, execSearch2)
    expect(searchRes2.items).toHaveLength(0)

    await env.cleanup()
  })

  it('cross-entry concurrency: forget and promote on same short-term memory with barrier (both orderings)', async () => {
    // Ordering A: Forget started first, Promote racing
    {
      const env = await setupEnvironment()
      const sessionId = 'session_race_ordering_a'
      const { exec: execInit } = createMockExec(sessionId, env.root, 'call_init_a', 'mnemosyne_forget')
      const scope = (env.scopeRuntime.observeSession((execInit.agent as any).session) as any).scope

      const shortFactBase = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        project_scope_id: env.projectScopeId,
        session_scope_id: scope.session_scope_id,
        memory_id: 'mem_race_same_a',
        title: 'Same Memory A',
        summary: 'Same Summary A',
        body: 'Same Body A',
        tags: ['race'],
        created_at: '2026-08-25T08:00:00.000Z',
        expires_at: '2026-09-01T08:00:00.000Z',
      }
      const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
      await env.store.putShortTerm(scope.session_scope_id, shortFact)

      await env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T08:05:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const { exec: execF } = createMockExec(sessionId, env.root, 'call_f_race', 'mnemosyne_forget')
      const { exec: execP } = createMockExec(sessionId, env.root, 'call_p_race', 'mnemosyne_promote')

      const [forgetRes, promoteRes] = await Promise.all([
        env.runtime.forget({ tier: 'short_term', memory_id: 'mem_race_same_a' }, execF),
        env.runtime.promote({ memory_id: 'mem_race_same_a' }, execP),
      ])

      expect(forgetRes.status).toBe('created')
      expect(promoteRes.status).toBe('created')

      // In list with include_inactive: true
      const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_a', 'mnemosyne_list')
      const listRes = await env.runtime.list({ include_inactive: true }, execList)

      const shortItem = listRes.items.find((i) => i.memory_id === 'mem_race_same_a')
      // Forgotten state has highest priority
      expect(shortItem?.state).toBe('forgotten')

      const longItem = listRes.items.find((i) => i.memory_id === promoteRes.memory_id)
      expect(longItem?.state).toBe('active')

      await env.cleanup()
    }

    // Ordering B: Promote started first, Forget racing
    {
      const env = await setupEnvironment()
      const sessionId = 'session_race_ordering_b'
      const { exec: execInit } = createMockExec(sessionId, env.root, 'call_init_b', 'mnemosyne_promote')
      const scope = (env.scopeRuntime.observeSession((execInit.agent as any).session) as any).scope

      const shortFactBase = {
        schema_version: 1 as const,
        tier: 'short_term' as const,
        project_scope_id: env.projectScopeId,
        session_scope_id: scope.session_scope_id,
        memory_id: 'mem_race_same_b',
        title: 'Same Memory B',
        summary: 'Same Summary B',
        body: 'Same Body B',
        tags: ['race'],
        created_at: '2026-08-25T08:00:00.000Z',
        expires_at: '2026-09-01T08:00:00.000Z',
      }
      const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
      await env.store.putShortTerm(scope.session_scope_id, shortFact)

      await env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T08:05:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const { exec: execP } = createMockExec(sessionId, env.root, 'call_p_race_b', 'mnemosyne_promote')
      const { exec: execF } = createMockExec(sessionId, env.root, 'call_f_race_b', 'mnemosyne_forget')

      const [promoteRes, forgetRes] = await Promise.all([
        env.runtime.promote({ memory_id: 'mem_race_same_b' }, execP),
        env.runtime.forget({ tier: 'short_term', memory_id: 'mem_race_same_b' }, execF),
      ])

      expect(promoteRes.status).toBe('created')
      expect(forgetRes.status).toBe('created')

      const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_b', 'mnemosyne_list')
      const listRes = await env.runtime.list({ include_inactive: true }, execList)

      const shortItem = listRes.items.find((i) => i.memory_id === 'mem_race_same_b')
      expect(shortItem?.state).toBe('forgotten')

      const longItem = listRes.items.find((i) => i.memory_id === promoteRes.memory_id)
      expect(longItem?.state).toBe('active')

      await env.cleanup()
    }
  })
})
