import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
import { createMemoryForgetFact } from '../src/protocol/management.js'

describe('MVP-06E: Memory Management Security and Isolation', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-m06-sec-'))
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

  it('rejects cross-session promote attempts (Session B cannot promote Session A memory)', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const sessionB = 'session_beta'

    const { exec: execA } = createMockExec(sessionA, env.root, 'call_a', 'mnemosyne_promote')
    const scopeA = (env.scopeRuntime.observeSession((execA.agent as any).session) as any).scope

    // Write a short-term fact in Session A
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_secret_a',
      title: 'Secret Memory in A',
      summary: 'Summary A',
      body: 'Body text in A',
      tags: ['confidential'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortFact)

    // Session B tries to promote Session A's memory
    const { exec: execB } = createMockExec(sessionB, env.root, 'call_b', 'mnemosyne_promote')
    env.scopeRuntime.observeSession((execB.agent as any).session)

    await expect(env.runtime.promote({ memory_id: 'mem_secret_a' }, execB)).rejects.toThrow()

    await env.cleanup()
  })

  it('rejects cross-session forget attempts for short_term memories', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const sessionB = 'session_beta'

    const { exec: execA } = createMockExec(sessionA, env.root, 'call_a', 'mnemosyne_forget')
    const scopeA = (env.scopeRuntime.observeSession((execA.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_in_a',
      title: 'Memory in A',
      summary: 'Summary in A',
      body: 'Body in A',
      tags: ['tag'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortFact)

    const { exec: execB } = createMockExec(sessionB, env.root, 'call_b', 'mnemosyne_forget')
    env.scopeRuntime.observeSession((execB.agent as any).session)

    // Session B cannot forget Session A's short-term memory
    await expect(env.runtime.forget({ tier: 'short_term', memory_id: 'mem_in_a' }, execB)).rejects.toThrow()

    await env.cleanup()
  })

  it('never leaks body, internal store paths, or forget metadata in list output', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const { exec } = createMockExec(sessionA, env.root, 'call_list', 'mnemosyne_list')
    const scopeA = (env.scopeRuntime.observeSession((exec.agent as any).session) as any).scope

    const secretBody = 'HIGHLY_CONFIDENTIAL_TOKEN_XYZ_123'
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_secret',
      title: 'Secret Title',
      summary: 'Secret Summary',
      body: secretBody,
      tags: ['secret'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortFact)

    const listRes = await env.runtime.list({ include_inactive: true }, exec)
    const jsonStr = JSON.stringify(listRes)

    expect(jsonStr).not.toContain(secretBody)
    expect(jsonStr).not.toContain('.dsh-mnemosyne')
    expect(jsonStr).not.toContain('facts/short-term')
    expect(jsonStr).not.toContain('facts/forget')

    for (const item of listRes.items) {
      expect((item as any).body).toBeUndefined()
      expect((item as any).path).toBeUndefined()
      expect((item as any).reason).toBeUndefined()
    }

    await env.cleanup()
  })

  it('rejects symlink creation inside facts/forget directory', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const { exec } = createMockExec(sessionA, env.root, 'call_f', 'mnemosyne_forget')
    const scopeA = (env.scopeRuntime.observeSession((exec.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_target',
      title: 'Target Title',
      summary: 'Target Summary',
      body: 'Target Body',
      tags: ['target'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortFact)

    // Put a valid forget fact first so directory exists
    await env.runtime.forget({ tier: 'short_term', memory_id: 'mem_target' }, exec)

    // Attempt to inject a symlink into facts/forget
    const forgetDir = join(env.root, '.dsh-mnemosyne', 'facts', 'forget')
    const symlinkPath = join(forgetDir, 'forget_symlink_fake.json')
    const targetFile = join(env.root, 'outside.txt')
    await writeFile(targetFile, 'malicious')
    await symlink(targetFile, symlinkPath)

    // listForget should reject the store layout with symlink
    await expect(env.store.listForget()).rejects.toThrow()

    await env.cleanup()
  })

  it('fails closed when a Forget Fact targets a corrupted / tampered Fact during compile', async () => {
    const env = await setupEnvironment()
    const sessionA = 'session_alpha'
    const { exec } = createMockExec(sessionA, env.root, 'call_f', 'mnemosyne_forget')
    const scopeA = (env.scopeRuntime.observeSession((exec.agent as any).session) as any).scope

    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: scopeA.session_scope_id,
      memory_id: 'mem_corrupted_target',
      title: 'Corrupted Target',
      summary: 'Summary',
      body: 'Body',
      tags: ['tag'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = { ...shortFactBase, content_sha256: computeFactHash(shortFactBase) }
    await env.store.putShortTerm(scopeA.session_scope_id, shortFact)

    // Create a forget fact pointing to wrong content_sha256
    const tamperedForgetFact = createMemoryForgetFact({
      project_scope_id: env.projectScopeId,
      target: {
        tier: 'short_term',
        session_scope_id: scopeA.session_scope_id,
        memory_id: 'mem_corrupted_target',
        content_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
      },
    })
    await env.store.putForget(tamperedForgetFact)

    // Compiler MUST fail closed because target content_sha256 does not match actual Fact
    await expect(
      env.compiler.compile({
        project_root: env.root,
        project_scope_id: env.projectScopeId,
        evaluation_at: '2026-08-25T08:10:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })
    ).rejects.toThrow()

    await env.cleanup()
  })

  describe('Strict parameter closure and no echo', () => {
    it('rejects unknown fields, symbol keys, getters, arrays, and non-plain objects in promote', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_closure_promote'
      const { exec } = createMockExec(sessionId, env.root, 'call_p', 'mnemosyne_promote')
      env.scopeRuntime.observeSession((exec.agent as any).session)

      const cases: unknown[] = [
        { memory_id: 'mem_test', body: 'secret_leak' },
        { memory_id: 'mem_test', extra: 123 },
        { memory_id: 'mem_test', [Symbol('secret_sym')]: 'hidden' },
        (() => {
          const obj = { memory_id: 'mem_test' }
          Object.defineProperty(obj, 'getter_prop', { get: () => 'leak', enumerable: true })
          return obj
        })(),
        ['mem_test'],
        'mem_test',
        null,
        undefined,
      ]

      for (const badInput of cases) {
        try {
          await env.runtime.promote(badInput, exec)
          expect.unreachable('should have rejected bad input')
        } catch (err: any) {
          expect(err.name).toBe('MemoryStoreError')
          expect(err.code).toBe('memory_store_invalid_input')
          expect(err.message).not.toContain('secret_leak')
          expect(err.message).not.toContain('extra')
          expect(err.message).not.toContain('getter_prop')
        }
      }

      await env.cleanup()
    })

    it('rejects unknown fields, symbol keys, getters, arrays, and non-plain objects in forget', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_closure_forget'
      const { exec } = createMockExec(sessionId, env.root, 'call_f', 'mnemosyne_forget')
      env.scopeRuntime.observeSession((exec.agent as any).session)

      const cases: unknown[] = [
        { tier: 'short_term', memory_id: 'mem_test', reason: 'confidential_reason' },
        { tier: 'short_term', memory_id: 'mem_test', prompt: 'user_prompt_secret' },
        { tier: 'short_term', memory_id: 'mem_test', [Symbol('secret_sym')]: 'hidden' },
        (() => {
          const obj = { tier: 'short_term', memory_id: 'mem_test' }
          Object.defineProperty(obj, 'evil_getter', { get: () => 'evil', enumerable: true })
          return obj
        })(),
        ['short_term', 'mem_test'],
        null,
        undefined,
      ]

      for (const badInput of cases) {
        try {
          await env.runtime.forget(badInput, exec)
          expect.unreachable('should have rejected bad input')
        } catch (err: any) {
          expect(err.name).toBe('MemoryStoreError')
          expect(err.code).toBe('memory_store_invalid_input')
          expect(err.message).not.toContain('confidential_reason')
          expect(err.message).not.toContain('user_prompt_secret')
          expect(err.message).not.toContain('evil_getter')
        }
      }

      await env.cleanup()
    })

    it('rejects unknown fields, symbol keys, getters, and arrays in list', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_closure_list'
      const { exec } = createMockExec(sessionId, env.root, 'call_l', 'mnemosyne_list')
      env.scopeRuntime.observeSession((exec.agent as any).session)

      const cases: unknown[] = [
        { tier: 'all', unknown_extra: 'secret_query' },
        { [Symbol('sym')]: 'secret' },
        (() => {
          const obj = { tier: 'all' }
          Object.defineProperty(obj, 'bad_get', { get: () => 'bad', enumerable: true })
          return obj
        })(),
        ['all'],
      ]

      for (const badInput of cases) {
        try {
          await env.runtime.list(badInput, exec)
          expect.unreachable('should have rejected bad input')
        } catch (err: any) {
          expect(err.name).toBe('MemoryStoreError')
          expect(err.code).toBe('memory_store_invalid_input')
          expect(err.message).not.toContain('secret_query')
          expect(err.message).not.toContain('unknown_extra')
          expect(err.message).not.toContain('bad_get')
        }
      }

      await env.cleanup()
    })
  })

  describe('Strict tool/call.time in resolveBoundToolCall', () => {
    it('rejects invalid dates, non-UTC dates, offset strings, paths, and secrets without echoing', async () => {
      const env = await setupEnvironment()
      const sessionId = 'session_time_sec'

      const badTimes = [
        'invalid-date',
        '2026-08-25',
        '2026-08-25T08:00:00+08:00',
        '2026-08-25T08:00:00Z', // missing milliseconds .sss
        '2026-02-30T08:00:00.000Z', // impossible calendar date
        '/Users/victim/secret/path',
        'sk-secret-key-1234567890',
        '',
      ]

      for (const badTime of badTimes) {
        const { exec } = createMockExec(sessionId, env.root, `call_${badTime}`, 'mnemosyne_list', badTime)
        env.scopeRuntime.observeSession((exec.agent as any).session)

        try {
          await env.runtime.list({}, exec)
          expect.unreachable(`should have rejected bad time: ${badTime}`)
        } catch (err: any) {
          expect(err.name).toBe('MemoryStoreError')
          expect(err.code).toBe('memory_store_invalid_input')
          if (badTime) {
            expect(err.message).not.toContain(badTime)
          }
          expect(err.message).not.toContain('victim')
          expect(err.message).not.toContain('sk-secret')
        }
      }

      // Valid millisecond UTC must succeed and return exact time without reformatting
      const validTime = '2026-08-25T08:30:15.123Z'
      const { exec: validExec } = createMockExec(sessionId, env.root, 'call_valid_time', 'mnemosyne_list', validTime)
      env.scopeRuntime.observeSession((validExec.agent as any).session)

      const result = await env.runtime.list({}, validExec)
      expect(result.evaluation_at).toBe(validTime)

      await env.cleanup()
    })
  })
})
