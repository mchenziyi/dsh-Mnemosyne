import { existsSync } from 'node:fs'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'
import {
  computeProjectScopeId,
  computeSessionScopeId,
  createScopeRuntime,
  validateAndNormalizeProjectRoot,
  type ResolvedScope,
  type ScopeResolution,
} from '../src/runtime-scope.js'
import { createStatusTool } from '../src/status.js'

function mockSession(id: string, cwd?: string): Session {
  const header: SessionHeader = {
    version: 0,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
  }
  return {
    id: SessionId(id),
    header,
    events: [],
  } as unknown as Session
}

function mockAgent(agentId: string, session: Session): Agent {
  return {
    id: agentId,
    session,
  } as unknown as Agent
}

function mockToolContext(agent?: Agent): ToolRunContext {
  return {
    callId: CallId('test-call-1'),
    signal: new AbortController().signal,
    name: 'mnemosyne_status',
    arguments: {},
    agent,
  } as unknown as ToolRunContext
}

describe('MVP-01: Runtime & Project/Session Scope TDD Matrix', () => {
  // 9.1 配置与根路径
  describe('9.1 配置与根路径', () => {
    it('1. Header cwd is valid and takes priority over explicit config', () => {
      const runtime = createScopeRuntime({ projectRoot: '/config/path' })
      const session = mockSession('session-1', '/header/path')
      const res = runtime.observeSession(session)
      expect(res.status).toBe('ready')
      if (res.status !== 'ready') throw new Error('expected ready')
      expect(res.scope.source).toBe('session_header')
      expect(res.scope.project_root).toBe('/header/path')
      expect(res.scope.project_scope_id).toBe(computeProjectScopeId('/header/path'))
    })

    it('2. Fallback to explicit absolute config when Header has no cwd', () => {
      const runtime = createScopeRuntime({ projectRoot: '/config/fallback' })
      const session = mockSession('session-1', undefined)
      const res = runtime.observeSession(session)
      expect(res.status).toBe('ready')
      if (res.status !== 'ready') throw new Error('expected ready')
      expect(res.scope.source).toBe('explicit_config')
      expect(res.scope.project_root).toBe('/config/fallback')
      expect(res.scope.project_scope_id).toBe(computeProjectScopeId('/config/fallback'))
    })

    it('3. Returns unavailable (missing_project_root) when both Header cwd and config are missing', () => {
      const runtime = createScopeRuntime({})
      const session = mockSession('session-1', undefined)
      const res = runtime.observeSession(session)
      expect(res.status).toBe('unavailable')
      if (res.status !== 'unavailable') throw new Error('expected unavailable')
      expect(res.reason).toBe('missing_project_root')
    })

    it('4. Rejects relative paths, empty strings, and NUL characters with sanitized error', () => {
      expect(() => validateAndNormalizeProjectRoot('relative/path')).toThrow()
      expect(() => validateAndNormalizeProjectRoot('')).toThrow()
      expect(() => validateAndNormalizeProjectRoot('/path/with\0null')).toThrow()
      expect(() => validateAndNormalizeProjectRoot(123)).toThrow()

      try {
        validateAndNormalizeProjectRoot('/secret/path/with\0null')
      } catch (err: unknown) {
        const msg = (err as Error).message
        expect(msg).not.toContain('/secret/path')
        expect(msg).not.toContain('with\0null')
      }
    })

    it('5. Normalizes redundant separators, dots, and trailing slashes', () => {
      expect(validateAndNormalizeProjectRoot('/a//b/./c/../d/')).toBe('/a/b/d')
      expect(validateAndNormalizeProjectRoot('/var/log/')).toBe('/var/log')
      expect(validateAndNormalizeProjectRoot('/')).toBe('/')
    })

    it('6. Does not use process.cwd() or environment variables', () => {
      const runtime = createScopeRuntime({})
      const session = mockSession('session-1', undefined)
      const res = runtime.observeSession(session)
      expect(res.status).toBe('unavailable')
      if (res.status !== 'unavailable') throw new Error('expected unavailable')
      expect(res.reason).toBe('missing_project_root')
    })
  })

  // 9.2 身份与隔离
  describe('9.2 身份与隔离', () => {
    it('7. Idempotent resolution for identical Project/Session', () => {
      const runtime = createScopeRuntime()
      const session1 = mockSession('sess-1', '/repo/app')
      const res1 = runtime.observeSession(session1)
      const res2 = runtime.observeSession(session1)
      expect(res1).toEqual(res2)
      expect(runtime.snapshot().activeBindingsCount).toBe(1)
    })

    it('8. Same Project, different Sessions share project_scope_id but have distinct session_scope_id', () => {
      const runtime = createScopeRuntime()
      const sessA = mockSession('sess-a', '/repo/app')
      const sessB = mockSession('sess-b', '/repo/app')
      const resA = runtime.observeSession(sessA)
      const resB = runtime.observeSession(sessB)
      expect(resA.status).toBe('ready')
      expect(resB.status).toBe('ready')
      if (resA.status !== 'ready' || resB.status !== 'ready') throw new Error('expected ready')
      expect(resA.scope.project_scope_id).toBe(resB.scope.project_scope_id)
      expect(resA.scope.session_scope_id).not.toBe(resB.scope.session_scope_id)
      expect(runtime.snapshot().activeBindingsCount).toBe(2)
    })

    it('9. Different Projects, different Sessions are completely isolated', () => {
      const runtime = createScopeRuntime()
      const sess1 = mockSession('sess-1', '/repo/app1')
      const sess2 = mockSession('sess-2', '/repo/app2')
      const res1 = runtime.observeSession(sess1)
      const res2 = runtime.observeSession(sess2)
      expect(res1.status).toBe('ready')
      expect(res2.status).toBe('ready')
      if (res1.status !== 'ready' || res2.status !== 'ready') throw new Error('expected ready')
      expect(res1.scope.project_scope_id).not.toBe(res2.scope.project_scope_id)
      expect(res1.scope.session_scope_id).not.toBe(res2.scope.session_scope_id)
    })

    it('10. Same Session ID with different Project root triggers conflict, retains original binding, and does NOT overwrite', () => {
      const runtime = createScopeRuntime()
      const sess1 = mockSession('sess-same', '/repo/project-a')
      const sess2 = mockSession('sess-same', '/repo/project-b')
      const res1 = runtime.observeSession(sess1)
      expect(res1.status).toBe('ready')
      expect(runtime.snapshot().activeBindingsCount).toBe(1)
      expect(runtime.snapshot().conflictedSessionsCount).toBe(0)

      const res2 = runtime.observeSession(sess2)
      expect(res2.status).toBe('conflict')
      if (res2.status !== 'conflict') throw new Error('expected conflict')
      expect(res2.reason).toBe('session_scope_conflict')
      expect(runtime.snapshot().activeBindingsCount).toBe(1)
      expect(runtime.snapshot().conflictedSessionsCount).toBe(1)

      // Subsequent resolution for this session remains in conflict
      const res3 = runtime.observeSession(sess1)
      expect(res3.status).toBe('conflict')
      if (res3.status !== 'conflict') throw new Error('expected conflict')
      expect(res3.reason).toBe('session_scope_conflict')

      const res4 = runtime.observeSession(sess2)
      expect(res4.status).toBe('conflict')
      if (res4.status !== 'conflict') throw new Error('expected conflict')
      expect(res4.reason).toBe('session_scope_conflict')

      runtime.disposeSession(sess1)
      expect(runtime.snapshot().activeBindingsCount).toBe(0)
      expect(runtime.snapshot().conflictedSessionsCount).toBe(0)
    })

    it('11. Agent ID mismatch with Session ID triggers conflict', () => {
      const runtime = createScopeRuntime()
      const session = mockSession('sess-1', '/repo/app')
      const agent = mockAgent('agent-2-mismatch', session)
      const exec = mockToolContext(agent)
      const res = runtime.resolveExecution(exec)
      expect(res.status).toBe('conflict')
      if (res.status !== 'conflict') throw new Error('expected conflict')
      expect(res.reason).toBe('agent_session_identity_mismatch')
    })

    it('12. Missing agent produces unavailable / missing_agent without creating anonymous identity', () => {
      const runtime = createScopeRuntime()
      const exec = mockToolContext(undefined)
      const res = runtime.resolveExecution(exec)
      expect(res.status).toBe('unavailable')
      if (res.status !== 'unavailable') throw new Error('expected unavailable')
      expect(res.reason).toBe('missing_agent')
      expect(runtime.snapshot().activeBindingsCount).toBe(0)
    })
  })

  // 9.3 Event 与生命周期
  describe('9.3 Event 与生命周期', () => {
    it('13. session/event binds scope without retaining event payload', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin({
        name: 'dsh-mnemosyne',
        Config,
        inject: ['tools'],
        apply,
      }, { enabled: true })

      const session = mockSession('sess-evt-1', '/workspace/app')
      ctx.emit('session/event', session, {
        type: 'user/message',
        seq: 1,
        data: { message: { role: 'user', content: 'SECRET_PAYLOAD_DO_NOT_STORE' } },
      } as never)

      const agent = mockAgent('sess-evt-1', session)
      const tool = ctx.tools.get('mnemosyne_status')!
      const statusRes = await tool.execute({}, mockToolContext(agent))
      expect(statusRes).toMatchObject({
        protocol_version: 2,
        scope: {
          status: 'ready',
          source: 'session_header',
          project_scope_id: computeProjectScopeId('/workspace/app'),
          session_scope_id: computeSessionScopeId(computeProjectScopeId('/workspace/app'), 'sess-evt-1'),
          reason: null,
        },
      })
      expect(JSON.stringify(statusRes)).not.toContain('SECRET_PAYLOAD_DO_NOT_STORE')
      await fiber.dispose()
    })

    it('14. Duplicate events do not increase binding count', () => {
      const runtime = createScopeRuntime()
      const session = mockSession('sess-1', '/repo/app')
      runtime.observeSession(session)
      runtime.observeSession(session)
      runtime.observeSession(session)
      expect(runtime.snapshot().activeBindingsCount).toBe(1)
    })

    it('15. session/disposed removes session binding', () => {
      const runtime = createScopeRuntime()
      const session = mockSession('sess-1', '/repo/app')
      runtime.observeSession(session)
      expect(runtime.snapshot().activeBindingsCount).toBe(1)

      runtime.disposeSession(session)
      expect(runtime.snapshot().activeBindingsCount).toBe(0)
    })

    it('16. clear() clears all maps and conflict records to zero', () => {
      const runtime = createScopeRuntime()
      const s1 = mockSession('sess-1', '/repo/app')
      const sConflict1 = mockSession('sess-c', '/repo/a')
      const sConflict2 = mockSession('sess-c', '/repo/b')
      runtime.observeSession(s1)
      runtime.observeSession(sConflict1)
      runtime.observeSession(sConflict2)

      expect(runtime.snapshot().activeBindingsCount).toBe(2)
      expect(runtime.snapshot().conflictedSessionsCount).toBe(1)

      runtime.clear()
      expect(runtime.snapshot().activeBindingsCount).toBe(0)
      expect(runtime.snapshot().conflictedSessionsCount).toBe(0)
    })

    it('17. Config enable -> disable -> enable leaves no duplicate listeners or leaked bindings', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin({
        name: 'dsh-mnemosyne',
        Config,
        inject: ['tools'],
        apply,
      }, { enabled: true })

      expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
      await fiber.update({ enabled: false })
      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      await fiber.update({ enabled: true })
      expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
      await fiber.dispose()
    })

    it('18. Two root Contexts are completely isolated in runtime state', async () => {
      const ctx1 = new Context()
      const ctx2 = new Context()
      for (const ctx of [ctx1, ctx2]) {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
      }

      const fiber1 = await ctx1.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true, projectRoot: '/root/ctx1' })
      const fiber2 = await ctx2.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true, projectRoot: '/root/ctx2' })

      const sess = mockSession('s-isolated', undefined)
      const agent = mockAgent('s-isolated', sess)
      const tool1 = ctx1.tools.get('mnemosyne_status')!
      const tool2 = ctx2.tools.get('mnemosyne_status')!

      const res1 = (await tool1.execute({}, mockToolContext(agent))) as { scope: { project_scope_id: string } }
      const res2 = (await tool2.execute({}, mockToolContext(agent))) as { scope: { project_scope_id: string } }

      expect(res1.scope.project_scope_id).toBe(computeProjectScopeId('/root/ctx1'))
      expect(res2.scope.project_scope_id).toBe(computeProjectScopeId('/root/ctx2'))
      expect(res1.scope.project_scope_id).not.toBe(res2.scope.project_scope_id)

      await fiber1.dispose()
      await fiber2.dispose()
    })

    it('19. Event scope conflict marks session as conflicted; subsequent tool calls fail closed', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true })

      const sess1 = mockSession('drift-sess', '/path/one')
      const sess2 = mockSession('drift-sess', '/path/two')

      ctx.emit('session/event', sess1, { type: 'user/message', seq: 1 } as never)
      ctx.emit('session/event', sess2, { type: 'user/message', seq: 2 } as never)

      const agent = mockAgent('drift-sess', sess1)
      const tool = ctx.tools.get('mnemosyne_status')!
      const result = (await tool.execute({}, mockToolContext(agent))) as { scope: { status: string, reason: string } }

      expect(result.scope.status).toBe('conflict')
      expect(result.scope.reason).toBe('session_scope_conflict')

      await fiber.dispose()
    })

    it('20. Disabled plugin registers zero tools and makes zero contributions', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: false })
      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      await fiber.dispose()
    })
  })

  // 9.4 Status、安全和回归
  describe('9.4 Status、安全和回归', () => {
    it('21. Strict schema output for ready, unavailable, and conflict states', async () => {
      const runtime = createScopeRuntime()
      const tool = createStatusTool(runtime)

      // 1. Ready
      const sess = mockSession('sess-ready', '/repo/test')
      const execReady = mockToolContext(mockAgent('sess-ready', sess))
      const outReady = await tool.execute({}, execReady)
      expect(outReady).toEqual({
        plugin: 'dsh-Mnemosyne',
        version: '0.0.0-dev',
        protocol_version: 2,
        memory_enabled: false,
        status: 'ready',
        scope: {
          status: 'ready',
          source: 'session_header',
          project_scope_id: computeProjectScopeId('/repo/test'),
          session_scope_id: computeSessionScopeId(computeProjectScopeId('/repo/test'), 'sess-ready'),
          reason: null,
        },
      })

      // 2. Unavailable
      const execUnavailable = mockToolContext(undefined)
      const outUnavailable = await tool.execute({}, execUnavailable)
      expect(outUnavailable).toEqual({
        plugin: 'dsh-Mnemosyne',
        version: '0.0.0-dev',
        protocol_version: 2,
        memory_enabled: false,
        status: 'ready',
        scope: {
          status: 'unavailable',
          source: 'none',
          project_scope_id: null,
          session_scope_id: null,
          reason: 'missing_agent',
        },
      })

      // 3. Conflict
      const execConflict = mockToolContext(mockAgent('agent-mismatch', sess))
      const outConflict = await tool.execute({}, execConflict)
      expect(outConflict).toEqual({
        plugin: 'dsh-Mnemosyne',
        version: '0.0.0-dev',
        protocol_version: 2,
        memory_enabled: false,
        status: 'ready',
        scope: {
          status: 'conflict',
          source: 'none',
          project_scope_id: null,
          session_scope_id: null,
          reason: 'agent_session_identity_mismatch',
        },
      })
    })

    it('22. Output does not contain raw project_root or session_id in any string field', async () => {
      const runtime = createScopeRuntime()
      const tool = createStatusTool(runtime)
      const sess = mockSession('sensitive-session-id-999', '/sensitive/user/project/path')
      const exec = mockToolContext(mockAgent('sensitive-session-id-999', sess))
      const out = await tool.execute({}, exec)
      const outJson = JSON.stringify(out)

      expect(outJson).not.toContain('/sensitive/user/project/path')
      expect(outJson).not.toContain('sensitive-session-id-999')
    })

    it('23. Malicious paths and IDs are rejected without leakage into error text', () => {
      const malicious = '/Users/victim/.ssh/id_rsa\0evil'
      try {
        validateAndNormalizeProjectRoot(malicious)
        expect.unreachable('should throw on NUL')
      } catch (err: unknown) {
        expect((err as Error).message).not.toContain(malicious)
        expect((err as Error).message).not.toContain('id_rsa')
      }
    })

    it('24. Hash computation is byte-for-byte deterministic across invocations', () => {
      const p1 = computeProjectScopeId('/repo/my-app')
      const p2 = computeProjectScopeId('/repo/my-app')
      expect(p1).toBe(p2)
      expect(p1).toMatch(/^sha256_[0-9a-f]{64}$/)

      const s1 = computeSessionScopeId(p1, 'sess-100')
      const s2 = computeSessionScopeId(p1, 'sess-100')
      expect(s1).toBe(s2)
      expect(s1).toMatch(/^sha256_[0-9a-f]{64}$/)
    })

    it('25. Synthetic search/open tools remain functional alongside new scope runtime', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true })
      expect(ctx.tools.get('mnemosyne_search')).toBeDefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeDefined()

      const searchTool = ctx.tools.get('mnemosyne_search')!
      const searchRes = (await searchTool.execute({ query: 'compiler cache' }, mockToolContext())) as {
        level: number
        items: Array<{ memory_id: string }>
        retrieval_ref: string
        content_sha256: string
      }
      expect(searchRes.level).toBe(2)
      expect(searchRes.items.length).toBeGreaterThan(0)

      await fiber.dispose()
    })

    it('26. Zero filesystem write side effects during full scope lifecycle', async () => {
      const tempBase = await mkdtemp(join(await realpath(tmpdir()), 'dsh-zero-write-'))
      const nonExistentPath = join(tempBase, 'non-existent-project-root')
      try {
        expect(existsSync(nonExistentPath)).toBe(false)
        const runtime = createScopeRuntime({ projectRoot: nonExistentPath })
        const session = mockSession('sess-1', nonExistentPath)
        runtime.observeSession(session)
        runtime.resolveExecution(mockToolContext(mockAgent('sess-1', session)))
        runtime.disposeSession(session)
        runtime.clear()

        expect(existsSync(nonExistentPath)).toBe(false)
        const createdEntries = await readdir(tempBase)
        expect(createdEntries).toEqual([])
      } finally {
        await rm(tempBase, { recursive: true, force: true })
      }
    })

    it('27. Plugin loading rejects relative projectRoot and cleans up all state', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      await expect(
        ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true, projectRoot: 'relative/path' })
      ).rejects.toThrow()

      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_search')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeUndefined()
    })

    it('28. Plugin loading rejects empty string projectRoot without leaking input in error', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      let thrownError: Error | undefined
      try {
        await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true, projectRoot: '' })
      } catch (err: unknown) {
        thrownError = err as Error
      }
      expect(thrownError).toBeDefined()
      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_search')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeUndefined()
    })

    it('29. Plugin loading rejects projectRoot with NUL character without leaking raw payload', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const evilPath = '/evil/path\0/with-null'
      let thrownError: Error | undefined
      try {
        await ctx.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true, projectRoot: evilPath })
      } catch (err: unknown) {
        thrownError = err as Error
      }
      expect(thrownError).toBeDefined()
      expect(thrownError!.message).not.toContain(evilPath)
      expect(thrownError!.message).not.toContain('with-null')
      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_search')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeUndefined()
    })
  })
})
