import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFactHash } from '../src/memory-fact.js'
import {
  createMemoryForgetFact,
  validateMemoryForgetFact,
  computeForgetId,
  computeForgetContentSha256,
  type MemoryForgetFact,
  type MemoryForgetTargetRef,
} from '../src/protocol/management.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'

describe('MVP-06A: MemoryForgetFact protocol and store operations', () => {
  async function setupEnvironment() {
    const base = await realpath(tmpdir())
    const root = await mkdtemp(join(base, 'mnemosyne-m06a-test-'))
    const projectScopeId = computeProjectScopeId(root)
    const store = openMemoryFactStore({
      project_root: root,
      project_scope_id: projectScopeId,
    })

    return {
      root,
      projectScopeId,
      store,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
      },
    }
  }

  it('computes deterministic forget_id and canonical content_sha256 for short_term target', () => {
    const projectScopeId = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
    const target: MemoryForgetTargetRef = {
      tier: 'short_term',
      session_scope_id: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
      memory_id: 'mem_short_123',
      content_sha256: 'sha256_3333333333333333333333333333333333333333333333333333333333333333',
    }

    const forgetId = computeForgetId(projectScopeId, target)
    expect(forgetId).toMatch(/^forget_[0-9a-f]{64}$/)

    const forgetFact = createMemoryForgetFact({
      project_scope_id: projectScopeId,
      target,
    })

    expect(forgetFact.schema_version).toBe(1)
    expect(forgetFact.fact_type).toBe('memory_forget')
    expect(forgetFact.forget_id).toBe(forgetId)
    expect(forgetFact.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)

    const validated = validateMemoryForgetFact(forgetFact)
    expect(validated).toEqual(forgetFact)
  })

  it('computes deterministic forget_id for long_term target with session_scope_id null', () => {
    const projectScopeId = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'
    const target: MemoryForgetTargetRef = {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_long_456',
      content_sha256: 'sha256_4444444444444444444444444444444444444444444444444444444444444444',
    }

    const forgetFact = createMemoryForgetFact({
      project_scope_id: projectScopeId,
      target,
    })

    expect(forgetFact.target.session_scope_id).toBeNull()
    expect(forgetFact.forget_id).toMatch(/^forget_[0-9a-f]{64}$/)
    expect(validateMemoryForgetFact(forgetFact)).toEqual(forgetFact)
  })

  it('rejects invalid targets, extra unknown fields, or mismatched tiers', () => {
    const projectScopeId = 'sha256_1111111111111111111111111111111111111111111111111111111111111111'

    // short_term with null session_scope_id must be rejected
    expect(() =>
      createMemoryForgetFact({
        project_scope_id: projectScopeId,
        target: {
          tier: 'short_term',
          session_scope_id: null as any,
          memory_id: 'mem_1',
          content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
        },
      })
    ).toThrow()

    // long_term with string session_scope_id must be rejected
    expect(() =>
      createMemoryForgetFact({
        project_scope_id: projectScopeId,
        target: {
          tier: 'long_term',
          session_scope_id: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
          memory_id: 'mem_1',
          content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
        },
      })
    ).toThrow()
  })

  it('stores and retrieves ForgetFact via MemoryFactStore with putForget, getForget, listForget', async () => {
    const env = await setupEnvironment()

    // Put short-term fact first
    const sessionScopeId = 'sha256_2222222222222222222222222222222222222222222222222222222222222222'
    const shortFactBase = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      project_scope_id: env.projectScopeId,
      session_scope_id: sessionScopeId,
      memory_id: 'mem_short_01',
      title: 'Short memory 1',
      summary: 'Short summary 1',
      body: 'Short body 1',
      tags: ['test'],
      created_at: '2026-08-25T08:00:00.000Z',
      expires_at: '2026-09-01T08:00:00.000Z',
    }
    const shortFact = {
      ...shortFactBase,
      content_sha256: computeFactHash(shortFactBase),
    }

    const shortFactRes = await env.store.putShortTerm(sessionScopeId, shortFact)
    expect(shortFactRes.status).toBe('created')

    const forgetFact = createMemoryForgetFact({
      project_scope_id: env.projectScopeId,
      target: {
        tier: 'short_term',
        session_scope_id: sessionScopeId,
        memory_id: 'mem_short_01',
        content_sha256: shortFactRes.content_sha256,
      },
    })

    // Store putForget
    const putRes = await (env.store as any).putForget(forgetFact)
    expect(putRes.status).toBe('created')
    expect(putRes.forget_id).toBe(forgetFact.forget_id)

    // Replay putForget is noop
    const replayRes = await (env.store as any).putForget(forgetFact)
    expect(replayRes.status).toBe('noop')

    // getForget
    const fetched = await (env.store as any).getForget(forgetFact.forget_id)
    expect(fetched).toEqual(forgetFact)

    // listForget
    const allForgets = await (env.store as any).listForget()
    expect(allForgets).toHaveLength(1)
    expect(allForgets[0]).toEqual(forgetFact)

    await env.cleanup()
  })

  it('verifies production Tool Schema definitions for mnemosyne_list, mnemosyne_promote, and mnemosyne_forget', async () => {
    const { createListTool, createPromoteTool, createForgetTool } = await import('../src/management-tools.js')
    const mockRuntime: any = {}

    const listTool = createListTool(mockRuntime) as any
    const promoteTool = createPromoteTool(mockRuntime) as any
    const forgetTool = createForgetTool(mockRuntime) as any

    // 1. mnemosyne_list schemas
    expect(listTool.name).toBe('mnemosyne_list')
    expect(listTool.parameters.properties.tier.type).toBe('string')
    expect(listTool.parameters.properties.tier.enum).toEqual(['all', 'short_term', 'long_term'])
    expect(listTool.parameters.properties.include_inactive.type).toBe('boolean')
    expect(listTool.parameters.properties.limit.type).toBe('integer')

    const listOutProps = listTool.output.schema.properties
    expect(listOutProps.params.properties.tier.enum).toEqual(['all', 'short_term', 'long_term'])
    expect(listOutProps.items.items.properties.tier.enum).toEqual(['short_term', 'long_term'])
    expect(listOutProps.items.items.properties.state.enum).toEqual(['active', 'promoted', 'expired', 'forgotten'])

    // 2. mnemosyne_promote schemas
    expect(promoteTool.name).toBe('mnemosyne_promote')
    expect(promoteTool.parameters.properties.memory_id.type).toBe('string')

    // 3. mnemosyne_forget schemas
    expect(forgetTool.name).toBe('mnemosyne_forget')
    expect(forgetTool.parameters.properties.tier.type).toBe('string')
    expect(forgetTool.parameters.properties.tier.enum).toEqual(['short_term', 'long_term'])
    expect(forgetTool.parameters.properties.memory_id.type).toBe('string')

    const forgetOutProps = forgetTool.output.schema.properties
    expect(forgetOutProps.target.properties.tier.enum).toEqual(['short_term', 'long_term'])
  })
})
