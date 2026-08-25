import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { STATUS_OUTPUT, createStatusTool } from '../src/status.js'
import { computeProjectScopeId, computeSessionScopeId, createScopeRuntime } from '../src/runtime-scope.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { computeFactHash, type LongTermMemoryFact, type ShortTermMemoryFact } from '../src/memory-fact.js'
import type { StatusV3Output } from '../src/protocol/okf-retrieval.js'

function makeShortFact(projectScopeId: string, sessionScopeId: string, id: string, title: string): ShortTermMemoryFact {
  const f: ShortTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'short_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    session_scope_id: sessionScopeId,
    title,
    summary: `Summary of ${title}`,
    body: `Body of ${title}`,
    tags: ['test'],
    created_at: '2026-08-25T10:00:00.000Z',
    expires_at: '2026-08-25T14:00:00.000Z',
    content_sha256: '',
  }
  f.content_sha256 = computeFactHash(f)
  return f
}

function makeLongFact(projectScopeId: string, id: string, title: string): LongTermMemoryFact {
  const f: LongTermMemoryFact = {
    schema_version: 1 as const,
    tier: 'long_term' as const,
    memory_id: id,
    project_scope_id: projectScopeId,
    title,
    summary: `Summary of ${title}`,
    body: `Body of ${title}`,
    tags: ['test'],
    created_at: '2026-08-25T10:00:00.000Z',
    source_short_term_refs: [],
    content_sha256: '',
  }
  f.content_sha256 = computeFactHash(f)
  return f
}

describe('MVP-04 status v3 tool contract', () => {
  it('returns the fixed status object without inputs or runtime', async () => {
    const tool = createStatusTool()
    expect(await tool.execute({}, {} as never)).toEqual(STATUS_OUTPUT)
    expect(JSON.stringify(await tool.execute({}, {} as never))).toBe(JSON.stringify(STATUS_OUTPUT))
  })

  it('declares a closed protocol_version 3 output schema and no input parameters', () => {
    const tool = createStatusTool()
    expect(tool.parameters).toEqual({ type: 'object', properties: {} })
    expect(tool.output.schema).toMatchObject({ type: 'object', additionalProperties: false })
    if (tool.output.schema.type !== 'object') throw new Error('status schema must be an object')
    expect(tool.output.schema.required).toEqual([
      'plugin',
      'version',
      'protocol_version',
      'memory_enabled',
      'status',
      'scope',
      'memory',
    ])
    expect((tool.output.schema.properties as Record<string, { const?: unknown }>).protocol_version.const).toBe(3)
    expect((tool.output.schema.properties as Record<string, { const?: unknown }>).memory_enabled.const).toBe(true)
  })

  it('short_term_count counts ONLY current session short-term memories', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-status-scope-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const sessionScopeIdA = computeSessionScopeId(projectScopeId, 'session_A')
      const sessionScopeIdB = computeSessionScopeId(projectScopeId, 'session_B')

      const store = openMemoryFactStore({ project_root: realRoot, project_scope_id: projectScopeId })
      await store.putLongTerm(makeLongFact(projectScopeId, 'mem_long_1', 'Long Term Fact'))
      await store.putShortTerm(sessionScopeIdA, makeShortFact(projectScopeId, sessionScopeIdA, 'mem_short_a1', 'Short Term A1'))
      await store.putShortTerm(sessionScopeIdB, makeShortFact(projectScopeId, sessionScopeIdB, 'mem_short_b1', 'Short Term B1'))
      await store.putShortTerm(sessionScopeIdB, makeShortFact(projectScopeId, sessionScopeIdB, 'mem_short_b2', 'Short Term B2'))

      const compiler = createOKFCompiler()
      await compiler.compile({
        project_root: realRoot,
        project_scope_id: projectScopeId,
        evaluation_at: '2026-08-25T12:00:00.000Z',
        compiler_version: 'dsh-mnemosyne-okf/1',
      })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const tool = createStatusTool(scopeRuntime)

      const execA = {
        agent: {
          id: 'session_A',
          session: { id: 'session_A', header: { cwd: realRoot } },
        },
      } as never

      const statusA = (await tool.execute({}, execA)) as {
        memory: { short_term_count: number; long_term_count: number; total_count: number }
      }
      expect(statusA.memory.short_term_count).toBe(1)
      expect(statusA.memory.long_term_count).toBe(1)
      expect(statusA.memory.total_count).toBe(2)

      const execB = {
        agent: {
          id: 'session_B',
          session: { id: 'session_B', header: { cwd: realRoot } },
        },
      } as never

      const statusB = (await tool.execute({}, execB)) as {
        memory: { short_term_count: number; long_term_count: number; total_count: number }
      }
      expect(statusB.memory.short_term_count).toBe(2)
      expect(statusB.memory.long_term_count).toBe(1)
      expect(statusB.memory.total_count).toBe(3)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('scrubs sensitive error messages and paths to stable reason codes in status', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-status-scrub-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const memDir = join(realRoot, '.dsh-mnemosyne')
      await mkdir(memDir, { recursive: true, mode: 0o700 })
      // Write corrupted non-json CURRENT file
      await writeFile(join(memDir, 'CURRENT'), 'CORRUPTED_SECRET_PATH=/Users/victim/.ssh/id_rsa\n', { mode: 0o600 })

      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const tool = createStatusTool(scopeRuntime)
      const exec = {
        agent: {
          id: 'sess_scrub',
          session: { id: 'sess_scrub', header: { cwd: realRoot } },
        },
      } as never

      const status = (await tool.execute({}, exec)) as StatusV3Output
      const statusJson = JSON.stringify(status)

      expect(statusJson).not.toContain('victim')
      expect(statusJson).not.toContain('id_rsa')
      expect(status.memory.availability).toBe('invalid')
      expect(status.memory.reason).toBe('memory_compile_decode_failed')
      expect(status.memory.generation_id).toBeNull()
      expect(status.memory.short_term_count).toBe(0)
      expect(status.memory.long_term_count).toBe(0)
      expect(status.memory.total_count).toBe(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('strictly validates the status state matrix invariants', async () => {
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-status-matrix-'))
    try {
      const realRoot = await realpath(tempDir)
      const projectScopeId = computeProjectScopeId(realRoot)
      const scopeRuntime = createScopeRuntime({ projectRoot: realRoot })
      const tool = createStatusTool(scopeRuntime)

      // 1. Empty state (no compiled generation)
      const execEmpty = {
        agent: {
          id: 'sess_mat',
          session: { id: 'sess_mat', header: { cwd: realRoot } },
        },
      } as never
      const emptyStatus = (await tool.execute({}, execEmpty)) as StatusV3Output
      expect(emptyStatus.memory.availability).toBe('empty')
      expect(emptyStatus.memory.generation_id).toBeNull()
      expect(emptyStatus.memory.short_term_count).toBe(0)
      expect(emptyStatus.memory.long_term_count).toBe(0)
      expect(emptyStatus.memory.total_count).toBe(0)
      expect(emptyStatus.memory.reason).toBeNull()

      // 2. Unavailable state (missing agent)
      const unavailStatus = (await tool.execute({}, {} as never)) as StatusV3Output
      expect(unavailStatus.memory.availability).toBe('unavailable')
      expect(unavailStatus.memory.generation_id).toBeNull()
      expect(unavailStatus.memory.short_term_count).toBe(0)
      expect(unavailStatus.memory.long_term_count).toBe(0)
      expect(unavailStatus.memory.total_count).toBe(0)
      expect(unavailStatus.memory.reason).toBe('missing_agent')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
