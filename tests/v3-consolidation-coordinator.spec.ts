import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMutationCoordinator, type MutationCoordinator } from '../src/mutation-coordinator.js'
import { computeProjectScopeId, type ResolvedScope } from '../src/runtime-scope.js'
import { createConsolidationRuntimeV2 } from '../src/v2/consolidation-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('v3 shared consolidation coordination', () => {
  it('uses one injected coordinator across per-agent runtimes for the same project', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v3-coordinator-')))
    roots.push(root)
    const scope: ResolvedScope = {
      schema_version: 1,
      session_id: 'v3_coordinator',
      project_root: root,
      project_scope_id: computeProjectScopeId(root),
      session_scope_id: 'sha256_' + 'a'.repeat(64),
      source: 'explicit_config',
    }
    const underlying = createMutationCoordinator()
    const events: string[] = []
    let active = 0
    let maxActive = 0
    const coordinator: MutationCoordinator = {
      run: (projectScopeId, operation) => {
        events.push('requested')
        return underlying.run(projectScopeId, async () => {
          events.push('entered')
          active++
          maxActive = Math.max(maxActive, active)
          try { return await operation() } finally { active--; events.push('exited') }
        })
      },
    }
    const model = async () => ({ decision: 'skip', reason_code: 'no_reusable_knowledge' } as const)
    const first = createConsolidationRuntimeV2({ model, coordinator } as any)
    const second = createConsolidationRuntimeV2({ model, coordinator } as any)
    const base = { scope, used_memory_refs: [], provider: 'p', model: 'm', signal: new AbortController().signal }

    await Promise.all([
      first.consolidate({ ...base, evidence: { task: 'A', outcome: 'done' }, now: '2026-09-01T05:00:00.000Z' }),
      second.consolidate({ ...base, evidence: { task: 'B', outcome: 'done' }, now: '2026-09-01T05:00:01.000Z' }),
    ])

    expect(events).toEqual(['requested', 'requested', 'entered', 'exited', 'entered', 'exited'])
    expect(maxActive).toBe(1)
  })
})
