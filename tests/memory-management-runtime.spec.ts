import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { computeFactHash, type ShortTermMemoryFact, type LongTermMemoryFact } from '../src/memory-fact.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { createManagementRuntime } from '../src/management-runtime.js'
import { createMemoryForgetFact } from '../src/protocol/management.js'
import { MemoryStoreError } from '../src/memory-store-error.js'

describe('MVP-06B: mnemosyne_list and Management Runtime', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-m06b-test-'))
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

  it('lists memories in current session + project, correctly deriving state (active, promoted, expired, forgotten)', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const { exec } = createMockExec(sessionA, env.root, 'call_list_1', 'mnemosyne_list', '2026-08-25T12:00:00.000Z')
    const scopeA = (env.scopeRuntime.observeSession((exec.agent as any).session) as any).scope

    // 1. Active short fact in session A
    const shortActiveBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_s_active',
      title: 'Active Short Memory',
      summary: 'Active summary',
      body: 'Active body with secrets that must never appear in list',
      tags: ['alpha'],
      created_at: '2026-08-25T10:00:00.000Z',
      expires_at: '2026-08-25T18:00:00.000Z',
    }
    const shortActive = { ...shortActiveBase, content_sha256: computeFactHash(shortActiveBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortActive)

    // 2. Expired short fact in session A (expires at 11:00, list is at 12:00)
    const shortExpiredBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_s_expired',
      title: 'Expired Short Memory',
      summary: 'Expired summary',
      body: 'Expired body',
      tags: ['expired'],
      created_at: '2026-08-25T09:00:00.000Z',
      expires_at: '2026-08-25T11:00:00.000Z',
    }
    const shortExpired = { ...shortExpiredBase, content_sha256: computeFactHash(shortExpiredBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortExpired)

    // 3. Promoted short fact in session A
    const shortPromotedBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_s_promoted',
      title: 'Promoted Short Memory',
      summary: 'Promoted summary',
      body: 'Promoted body',
      tags: ['promoted'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-08-25T20:00:00.000Z',
    }
    const shortPromoted = { ...shortPromotedBase, content_sha256: computeFactHash(shortPromotedBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortPromoted)

    // 4. Long fact in project that references shortPromoted
    const longPromotedBase = {
      schema_version: 1 as const,
      tier: 'long_term' as const,
      project_scope_id: env.projectScopeId,
      memory_id: 'mem_l_from_promoted',
      title: 'Promoted Short Memory',
      summary: 'Promoted summary',
      body: 'Promoted body',
      tags: ['promoted'],
      created_at: '2026-08-25T08:00:00.000Z',
      source_short_term_refs: [
        {
          project_scope_id: env.projectScopeId,
          session_scope_id: scopeA.session_scope_id,
          memory_id: 'mem_s_promoted',
          content_sha256: shortPromoted.content_sha256,
        },
      ],
    }
    const longPromoted = { ...longPromotedBase, content_sha256: computeFactHash(longPromotedBase) }
    await env.store.putLongTerm(longPromoted)

    // 5. Forgotten long fact in project
    const longForgottenBase = {
      schema_version: 1 as const,
      tier: 'long_term' as const,
      project_scope_id: env.projectScopeId,
      memory_id: 'mem_l_forgotten',
      title: 'Forgotten Long Memory',
      summary: 'Forgotten summary',
      body: 'Forgotten body',
      tags: ['forgotten'],
      created_at: '2026-08-25T07:00:00.000Z',
      source_short_term_refs: [],
    }
    const longForgotten = { ...longForgottenBase, content_sha256: computeFactHash(longForgottenBase) }
    await env.store.putLongTerm(longForgotten)

    const forgetFact = createMemoryForgetFact({
      project_scope_id: env.projectScopeId,
      target: {
        tier: 'long_term',
        session_scope_id: null,
        memory_id: 'mem_l_forgotten',
        content_sha256: longForgotten.content_sha256,
      },
    })
    await env.store.putForget(forgetFact)

    // A. Default list (include_inactive = false): only active memories returned
    const listActiveOnly = await env.runtime.list({}, exec)
    expect(listActiveOnly.total_count).toBe(2) // 1 active short + 1 active long
    expect(listActiveOnly.items.map((i) => i.memory_id).sort()).toEqual(['mem_l_from_promoted', 'mem_s_active'])
    expect(listActiveOnly.items.every((i) => (i as any).body === undefined)).toBe(true)

    // B. Full list (include_inactive = true): all states returned with correct priority
    const listAll = await env.runtime.list({ include_inactive: true }, exec)
    expect(listAll.total_count).toBe(5)

    const stateMap = Object.fromEntries(listAll.items.map((i) => [i.memory_id, i.state]))
    expect(stateMap['mem_s_active']).toBe('active')
    expect(stateMap['mem_s_expired']).toBe('expired')
    expect(stateMap['mem_s_promoted']).toBe('promoted')
    expect(stateMap['mem_l_from_promoted']).toBe('active')
    expect(stateMap['mem_l_forgotten']).toBe('forgotten')

    // Verify ordering: created_at desc
    const createdTimes = listAll.items.map((i) => i.created_at)
    const sortedTimes = [...createdTimes].sort().reverse()
    expect(createdTimes).toEqual(sortedTimes)

    await env.cleanup()
  })

  it('promotes short-term memory to long-term memory deterministically and updates Generation', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_promote_01'
    const { exec: execPromote } = createMockExec(sessionId, env.root, 'call_p_1', 'mnemosyne_promote')
    const scope = (env.scopeRuntime.observeSession((execPromote.agent as any).session) as any).scope

    // Put a short-term fact
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_short_to_promote',
      title: 'Memory To Promote',
      summary: 'Promote summary',
      body: 'Promote full body text',
      tags: ['promote', 'eng'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile: short fact is active and present in Generation
    const initGen = await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })
    expect(initGen.status).toBe('created')

    // 1. Promote short fact
    const promoteRes1 = await env.runtime.promote({ memory_id: 'mem_short_to_promote' }, execPromote)
    expect(promoteRes1.status).toBe('created')
    expect(promoteRes1.memory_id).toMatch(/^mem_promoted_[0-9a-f]{32}$/)
    expect(promoteRes1.source_short_term_ref).toEqual({
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_short_to_promote',
      content_sha256: shortFact.content_sha256,
    })

    // 2. Replay promote returns noop
    const { exec: execPromote2 } = createMockExec(sessionId, env.root, 'call_p_2', 'mnemosyne_promote')
    const promoteRes2 = await env.runtime.promote({ memory_id: 'mem_short_to_promote' }, execPromote2)
    expect(promoteRes2.status).toBe('noop')
    expect(promoteRes2.memory_id).toBe(promoteRes1.memory_id)

    // 3. Verify in new Generation: short fact is EXCLUDED, long fact is INCLUDED
    const current = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current).not.toBeNull()

    const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_p', 'mnemosyne_list')
    const listActive = await env.runtime.list({}, execList)
    expect(listActive.total_count).toBe(1)
    expect(listActive.items[0].memory_id).toBe(promoteRes1.memory_id)
    expect(listActive.items[0].tier).toBe('long_term')

    const listAll = await env.runtime.list({ include_inactive: true }, execList)
    expect(listAll.total_count).toBe(2)
    const shortItem = listAll.items.find((i) => i.memory_id === 'mem_short_to_promote')
    expect(shortItem?.state).toBe('promoted')

    await env.cleanup()
  })

  it('forgets memories logically, updates Generation, and triggers grant clearance', async () => {
    let grantCleared = false
    const env = await setupEnvironment()

    // Override runtime with onForgetCommitted hook
    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: env.compiler,
      onForgetCommitted: async () => {
        grantCleared = true
      },
    })

    const sessionId = 'session_forget_01'
    const { exec: execForget } = createMockExec(sessionId, env.root, 'call_f_1', 'mnemosyne_forget')
    const scope = (env.scopeRuntime.observeSession((execForget.agent as any).session) as any).scope

    // Put a short-term fact and a long-term fact
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_short_to_forget',
      title: 'Short to Forget',
      summary: 'Short summary',
      body: 'Short body',
      tags: ['forget'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    // 1. Forget the short-term fact
    const forgetRes1 = await runtime.forget({ tier: 'short_term', memory_id: 'mem_short_to_forget' }, execForget)
    expect(forgetRes1.status).toBe('created')
    expect(forgetRes1.forget_id).toMatch(/^forget_[0-9a-f]{64}$/)
    expect(grantCleared).toBe(true)

    // 2. Replay forget returns noop
    const { exec: execForget2 } = createMockExec(sessionId, env.root, 'call_f_2', 'mnemosyne_forget')
    const forgetRes2 = await runtime.forget({ tier: 'short_term', memory_id: 'mem_short_to_forget' }, execForget2)
    expect(forgetRes2.status).toBe('noop')
    expect(forgetRes2.forget_id).toBe(forgetRes1.forget_id)

    // 3. Verify in list and Generation: forgotten memory is excluded from active
    const { exec: execList } = createMockExec(sessionId, env.root, 'call_list_f', 'mnemosyne_list')
    const listActive = await runtime.list({}, execList)
    expect(listActive.total_count).toBe(0)

    const listAll = await runtime.list({ include_inactive: true }, execList)
    expect(listAll.total_count).toBe(1)
    expect(listAll.items[0].state).toBe('forgotten')

    await env.cleanup()
  })

  it('fails closed when onForgetCommitted callback throws, does not return success, and succeeds on retry as noop', async () => {
    let callCount = 0
    let grantState = 'active'
    const env = await setupEnvironment()

    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: env.compiler,
      onForgetCommitted: async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('grant cleanup transient network failure')
        }
        grantState = 'cleared'
      },
    })

    const sessionId = 'session_cb_fail'
    const { exec: exec1 } = createMockExec(sessionId, env.root, 'call_cb_1', 'mnemosyne_forget')
    const scope = (env.scopeRuntime.observeSession((exec1.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_cb_fail_target',
      title: 'Target Title',
      summary: 'Target Summary',
      body: 'Target Body',
      tags: ['cb'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    // Attempt 1: onForgetCommitted throws -> forget MUST fail and NOT return success
    await expect(runtime.forget({ tier: 'short_term', memory_id: 'mem_cb_fail_target' }, exec1)).rejects.toThrow()
    expect(callCount).toBe(1)
    expect(grantState).toBe('active') // not cleared yet

    // Fact and Generation exist on disk (no rollback / no corruption)
    const forgetFacts = await env.store.listForget()
    expect(forgetFacts).toHaveLength(1)

    // Attempt 2: retry forget -> putForget returns noop, compile runs, onForgetCommitted succeeds, returns noop
    const { exec: exec2 } = createMockExec(sessionId, env.root, 'call_cb_2', 'mnemosyne_forget')
    const res2 = await runtime.forget({ tier: 'short_term', memory_id: 'mem_cb_fail_target' }, exec2)
    expect(res2.status).toBe('noop')
    expect(res2.forget_id).toBe(forgetFacts[0].forget_id)
    expect(callCount).toBe(2)
    expect(grantState).toBe('cleared')

    await env.cleanup()
  })

  it('manages runtime lifecycle: in-flight mutations block dispose, dispose is idempotent, post-dispose calls reject', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_lifecycle'
    const { exec } = createMockExec(sessionId, env.root, 'call_lf_1', 'mnemosyne_promote')
    const scope = (env.scopeRuntime.observeSession((exec.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_lifecycle_target',
      title: 'LF Title',
      summary: 'LF Summary',
      body: 'LF Body',
      tags: ['lf'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    // Create barrier
    let barrierResolve!: () => void
    const barrierPromise = new Promise<void>((resolve) => {
      barrierResolve = resolve
    })

    let compileEntered = false
    const realCompiler = env.compiler
    const wrappedCompiler = {
      ...realCompiler,
      compile: async (params: any) => {
        compileEntered = true
        await barrierPromise
        return realCompiler.compile(params)
      },
    }

    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: wrappedCompiler as any,
    })

    // Start promote in background
    const promotePromise = runtime.promote({ memory_id: 'mem_lifecycle_target' }, exec)

    // Wait until compile is entered
    while (!compileEntered) {
      await new Promise((r) => setImmediate(r))
    }

    // Call dispose while mutation is in flight
    let disposeDone = false
    const disposePromise = runtime.dispose().then(() => {
      disposeDone = true
    })

    // Ensure dispose does not complete before barrier is released
    await new Promise((r) => setImmediate(r))
    expect(disposeDone).toBe(false)

    // Release barrier
    barrierResolve()

    const promoteRes = await promotePromise
    expect(promoteRes.status).toBe('created')

    await disposePromise
    expect(disposeDone).toBe(true)

    // Calling dispose again is idempotent
    await expect(runtime.dispose()).resolves.toBeUndefined()

    // Subsequent calls after dispose must reject immediately
    const { exec: execAfter } = createMockExec(sessionId, env.root, 'call_after', 'mnemosyne_list')
    await expect(runtime.list({}, execAfter)).rejects.toThrow()
    await expect(runtime.promote({ memory_id: 'mem_lifecycle_target' }, execAfter)).rejects.toThrow()
    await expect(runtime.forget({ tier: 'short_term', memory_id: 'mem_lifecycle_target' }, execAfter)).rejects.toThrow()

    await env.cleanup()
  })

  it('compile failure recovery matrix: promote handles compile failure, persists Fact, and converges on retry as noop', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_promote_recover'
    const { exec: exec1 } = createMockExec(sessionId, env.root, 'call_pr_1', 'mnemosyne_promote')
    const scope = (env.scopeRuntime.observeSession((exec1.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_pr_target',
      title: 'PR Title',
      summary: 'PR Summary',
      body: 'PR Body',
      tags: ['pr'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    const initGen = await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    let failCompile = true
    const realCompiler = env.compiler
    const faultCompiler = {
      ...realCompiler,
      compile: async (params: any) => {
        if (failCompile) {
          throw new Error('injected compile disk full')
        }
        return realCompiler.compile(params)
      },
    }

    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: faultCompiler as any,
    })

    // Attempt 1: promote fails at compile step
    await expect(runtime.promote({ memory_id: 'mem_pr_target' }, exec1)).rejects.toThrow()

    // Verify CURRENT is still old generation
    const current1 = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current1?.generation_id).toBe(initGen.generation_id)

    // Verify long-term fact was safely persisted
    const longFacts = await env.store.listLongTerm()
    expect(longFacts).toHaveLength(1)

    // Attempt 2: clear fault and retry
    failCompile = false
    const { exec: exec2 } = createMockExec(sessionId, env.root, 'call_pr_2', 'mnemosyne_promote')
    const res2 = await runtime.promote({ memory_id: 'mem_pr_target' }, exec2)
    expect(res2.status).toBe('noop')
    expect(res2.memory_id).toBe(longFacts[0].memory_id)

    // Verify CURRENT updated to new generation
    const current2 = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current2?.generation_id).toBe(res2.generation_id)
    expect(current2?.generation_id).not.toBe(initGen.generation_id)

    await env.cleanup()
  })

  it('compile failure recovery matrix: forget handles compile failure, persists Fact, and converges on retry as noop', async () => {
    const env = await setupEnvironment()
    const sessionId = 'session_forget_recover'
    const { exec: exec1 } = createMockExec(sessionId, env.root, 'call_fr_1', 'mnemosyne_forget')
    const scope = (env.scopeRuntime.observeSession((exec1.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scope.session_scope_id,
      memory_id: 'mem_fr_target',
      title: 'FR Title',
      summary: 'FR Summary',
      body: 'FR Body',
      tags: ['fr'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scope.session_scope_id, shortFact)

    // Initial compile
    const initGen = await env.compiler.compile({
      project_root: env.root,
      project_scope_id: env.projectScopeId,
      evaluation_at: '2026-08-25T08:05:00.000Z',
      compiler_version: 'dsh-mnemosyne-okf/1',
    })

    let grantCleared = false
    let failCompile = true
    const realCompiler = env.compiler
    const faultCompiler = {
      ...realCompiler,
      compile: async (params: any) => {
        if (failCompile) {
          throw new Error('injected compile transient error')
        }
        return realCompiler.compile(params)
      },
    }

    const runtime = createManagementRuntime({
      scopeRuntime: env.scopeRuntime,
      storeFactory: () => env.store,
      compiler: faultCompiler as any,
      onForgetCommitted: async () => {
        grantCleared = true
      },
    })

    // Attempt 1: forget fails at compile step
    await expect(runtime.forget({ tier: 'short_term', memory_id: 'mem_fr_target' }, exec1)).rejects.toThrow()
    expect(grantCleared).toBe(false)

    // Verify CURRENT is still old generation
    const current1 = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current1?.generation_id).toBe(initGen.generation_id)

    // Verify forget fact was safely persisted
    const forgetFacts = await env.store.listForget()
    expect(forgetFacts).toHaveLength(1)

    // Attempt 2: clear fault and retry
    failCompile = false
    const { exec: exec2 } = createMockExec(sessionId, env.root, 'call_fr_2', 'mnemosyne_forget')
    const res2 = await runtime.forget({ tier: 'short_term', memory_id: 'mem_fr_target' }, exec2)
    expect(res2.status).toBe('noop')
    expect(res2.forget_id).toBe(forgetFacts[0].forget_id)
    expect(grantCleared).toBe(true)

    // Verify CURRENT updated to new generation
    const current2 = await env.compiler.readCurrent(env.root, env.projectScopeId)
    expect(current2?.generation_id).toBe(res2.generation_id)
    expect(current2?.generation_id).not.toBe(initGen.generation_id)

    await env.cleanup()
  })

  describe('Table-driven error code preservation for list()', () => {
    const errorTestCases: {
      name: string
      injectedError: Error
      expectedCode: string
    }[] = [
      {
        name: 'preserves memory_store_symlink_rejected code without rewrapping',
        injectedError: new MemoryStoreError('memory_store_symlink_rejected'),
        expectedCode: 'memory_store_symlink_rejected',
      },
      {
        name: 'preserves memory_store_insecure_permissions code without rewrapping',
        injectedError: new MemoryStoreError('memory_store_insecure_permissions'),
        expectedCode: 'memory_store_insecure_permissions',
      },
      {
        name: 'preserves memory_store_hash_mismatch code without rewrapping',
        injectedError: new MemoryStoreError('memory_store_hash_mismatch'),
        expectedCode: 'memory_store_hash_mismatch',
      },
      {
        name: 'preserves memory_store_noncanonical code without rewrapping',
        injectedError: new MemoryStoreError('memory_store_noncanonical'),
        expectedCode: 'memory_store_noncanonical',
      },
      {
        name: 'maps arbitrary unknown error to memory_store_io_failed',
        injectedError: new Error('unhandled raw filesystem / secret token leak'),
        expectedCode: 'memory_store_io_failed',
      },
    ]

    for (const tc of errorTestCases) {
      it(tc.name, async () => {
        const env = await setupEnvironment()
        const sessionId = 'session_list_err_tc'
        const { exec } = createMockExec(sessionId, env.root, 'call_list_err', 'mnemosyne_list')
        env.scopeRuntime.observeSession((exec.agent as any).session)

        const faultyStore = {
          ...env.store,
          listShortTerm: async () => {
            throw tc.injectedError
          },
        }

        const runtime = createManagementRuntime({
          scopeRuntime: env.scopeRuntime,
          storeFactory: () => faultyStore as any,
          compiler: env.compiler,
        })

        try {
          await runtime.list({}, exec)
          expect.unreachable('list should have thrown')
        } catch (err: any) {
          expect(err.name).toBe('MemoryStoreError')
          expect(err.code).toBe(tc.expectedCode)
          expect(err.message).not.toContain('secret')
          expect(err.message).not.toContain('/Users')
        }

        await env.cleanup()
      })
    }
  })
})
