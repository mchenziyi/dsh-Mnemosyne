import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createProjectConsolidationBarrierV2 } from '../src/v2/project-consolidation-barrier.js'
import { createRecallPreStepHandlerV2 } from '../src/v2/recall-runtime.js'
import type { ResolvedScope, ScopeRuntime } from '../src/runtime-scope.js'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const projectA = `sha256_${'a'.repeat(64)}`
const projectB = `sha256_${'b'.repeat(64)}`

function scope(project_scope_id: string): ResolvedScope {
  return {
    schema_version: 1,
    session_id: `session_${project_scope_id.slice(-1)}`,
    project_root: `/project-${project_scope_id.slice(-1)}`,
    source: 'session_header',
    project_scope_id,
    session_scope_id: `sha256_${'c'.repeat(64)}`,
  }
}

describe('v0.2 project consolidation visibility', () => {
  it('waits for already-started consolidation in the same project without blocking another project', async () => {
    const barrier = createProjectConsolidationBarrierV2()
    const operation = deferred()
    barrier.track(projectA, operation.promise)
    let projectAReady = false
    let projectBReady = false
    const waitingA = barrier.wait(projectA).then(() => { projectAReady = true })
    const waitingB = barrier.wait(projectB).then(() => { projectBReady = true })

    await waitingB
    expect(projectBReady).toBe(true)
    expect(projectAReady).toBe(false)
    operation.resolve()
    await waitingA
    expect(projectAReady).toBe(true)
  })

  it('runs Recall only after the same-project visibility barrier settles', async () => {
    const gate = deferred()
    const resolved = scope(projectA)
    let recallCalls = 0
    const handler = createRecallPreStepHandlerV2({
      runtime: {
        recall: async () => {
          recallCalls++
          return { status: 'empty' as const, reason_code: 'memory_empty' as const, selected_memory_refs: [], expansion_steps: 0 }
        },
      },
      scopeRuntime: { observeSession: () => ({ status: 'ready' as const, scope: resolved }) } as unknown as ScopeRuntime,
      beforeRecall: async () => gate.promise,
    })
    const user = createUserMessage({ content: [{ type: 'text', text: 'next task' }], source: { kind: 'user' } }) as UserMessage
    const operation = handler({
      agent: { options: { provider: 'p', model: 'm' }, session: { id: resolved.session_id } },
      messages: [user], turn: 2, step: 1, signal: new AbortController().signal,
    } as never, async () => ({ kind: 'enter', messages: [user] }))

    await Promise.resolve()
    expect(recallCalls).toBe(0)
    gate.resolve()
    await operation
    expect(recallCalls).toBe(1)
  })
})
