import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config } from '../src/index.js'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { computeFactHash, type LongTermMemoryFact } from '../src/memory-fact.js'

function makeLongFact(projectScopeId: string, id: string, title = 'Compiler Build System Cache', body = 'Detailed compiler cache body'): LongTermMemoryFact {
  const f: LongTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'long_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    title,
    summary: 'Summary of compiler cache build system',
    body,
    tags: ['compiler', 'component-build'],
    created_at: '2026-08-25T10:00:00.000Z',
    source_short_term_refs: [],
    content_sha256: '',
  }
  f.content_sha256 = computeFactHash(f)
  return f
}

describe('MVP-04 production Tool registry and execution path', () => {
  it('executes search to open through ctx.tools and disposes all three tools', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-tool-reg-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_reg_01'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: '2026-08-25T12:00:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)

      const fiber = await ctx.plugin(
        { name: 'dsh-mnemosyne', Config, inject: ['tools'], apply },
        { enabled: true, projectRoot: realRoot }
      )

      expect(ctx.tools.get('mnemosyne_status')).toBeDefined()
      expect(ctx.tools.get('mnemosyne_search')).toBeDefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeDefined()

      const sessionId = 'session_reg_01'
      const sessionObj = { id: sessionId, header: { cwd: realRoot } }
      const agentContext = { id: sessionId, session: sessionObj }

      // 1. Status
      const statusRes = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('tool-status'),
        name: 'mnemosyne_status',
        arguments: {},
        agent: agentContext,
      } as never)
      expect(statusRes.isError).toBe(false)
      const status = statusRes.value as { protocol_version: number; memory_enabled: boolean; memory: { availability: string } }
      expect(status.protocol_version).toBe(3)
      expect(status.memory_enabled).toBe(true)
      expect(status.memory.availability).toBe('ready')

      // 2. Search
      const searchResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('tool-search'),
        name: 'mnemosyne_search',
        arguments: { query: 'compiler build' },
        agent: agentContext,
      } as never)
      expect(searchResult.isError).toBe(false)
      const search = searchResult.value as {
        retrieval_id: string
        content_sha256: string
        level: number
        items: Array<{ memory_ref: { memory_id: string } }>
      }
      expect(search.level).toBe(2)
      expect(search.items.length).toBeGreaterThan(0)

      // 3. Open
      const openResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('tool-open'),
        name: 'mnemosyne_open',
        arguments: {
          retrieval_id: search.retrieval_id,
          search_disclosure_sha256: search.content_sha256,
          memory_id: search.items[0].memory_ref.memory_id,
        },
        agent: agentContext,
      } as never)
      expect(openResult.isError).toBe(false)
      expect((openResult.value as { level: number; body: string }).level).toBe(3)
      expect((openResult.value as { level: number; body: string }).body).toBe('Detailed compiler cache body')

      // 4. Invalid arguments return safe error without leaking sensitive inputs
      for (const [name, arguments_] of [
        ['mnemosyne_search', { query: 'secret=/Users/private\u0000' }],
        ['mnemosyne_search', { query: 'cache', unexpected: 'password=secret' }],
        ['mnemosyne_open', { retrieval_id: search.retrieval_id, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_ref.memory_id, unexpected: '/private/tmp' }],
      ] as const) {
        const invalid = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId(`tool-invalid-${name}`),
          name,
          arguments: arguments_,
          agent: agentContext,
        } as never)
        expect(invalid.isError).toBe(true)
        expect(JSON.stringify(invalid)).not.toContain('password=secret')
        expect(JSON.stringify(invalid)).not.toContain('/private/tmp')
      }

      await fiber.dispose()
      expect(ctx.tools.get('mnemosyne_status')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_search')).toBeUndefined()
      expect(ctx.tools.get('mnemosyne_open')).toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps disabled and independent instances isolated', async () => {
    const first = new Context()
    const second = new Context()
    for (const ctx of [first, second]) {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
    }
    const firstFiber = await first.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: true })
    const secondFiber = await second.plugin({ name: 'dsh-mnemosyne', Config, inject: ['tools'], apply }, { enabled: false })
    expect(first.tools.get('mnemosyne_search')).toBeDefined()
    expect(second.tools.get('mnemosyne_search')).toBeUndefined()
    expect(second.tools.get('mnemosyne_status')).toBeUndefined()
    expect(second.tools.get('mnemosyne_open')).toBeUndefined()
    await firstFiber.dispose()
    await secondFiber.dispose()
  })
})
