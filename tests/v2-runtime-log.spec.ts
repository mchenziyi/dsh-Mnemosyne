import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { computeProjectScopeId, computeSessionScopeId, type ResolvedScope } from '../src/runtime-scope.js'
import { createRuntimeLoggerV2 } from '../src/v2/runtime-log.js'

describe('v2 runtime JSONL diagnostics', () => {
  it('persists structured diagnostics without prompts or memory content', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-log-')))
    try {
      const project = computeProjectScopeId(root)
      const scope: ResolvedScope = {
        schema_version: 1, session_id: 'session_log', project_root: root, source: 'session_header',
        project_scope_id: project, session_scope_id: computeSessionScopeId(project, 'session_log'),
      }
      const logger = createRuntimeLoggerV2()
      await logger.log(scope, {
        event: 'recall_layer', timestamp: '2026-08-28T05:00:00.000Z', turn: 3, stage: 'memory_summaries',
        expansion_step: 4, disclosed_count: 2, selected_count: 1, memory_refs: ['mem_safe'], result: 'selected',
      })
      await logger.log(scope, { event: 'consolidation_skip', timestamp: '2026-08-28T05:00:01.000Z', turn: 3, result: 'skipped', reason_code: 'no_reusable_knowledge' })
      await logger.dispose()
      const text = await readFile(join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')
      const rows = text.trim().split('\n').map((line) => JSON.parse(line))
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ event: 'recall_layer', disclosed_count: 2, selected_count: 1 })
      expect(text).not.toContain('user_text')
      expect(text).not.toContain('memory_content')
      expect(text).not.toContain('/Users/')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked log file without writing to its target', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-log-link-')))
    const external = join(root, 'external.txt')
    try {
      const project = computeProjectScopeId(root)
      const scope: ResolvedScope = {
        schema_version: 1, session_id: 'session_log', project_root: root, source: 'session_header',
        project_scope_id: project, session_scope_id: computeSessionScopeId(project, 'session_log'),
      }
      const logger = createRuntimeLoggerV2()
      await writeFile(external, 'unchanged', { mode: 0o600 })
      await logger.log(scope, { event: 'recall_start', timestamp: '2026-08-28T05:00:00.000Z', result: 'started' })
      await rm(join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'))
      await symlink(external, join(root, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'))
      await expect(logger.log(scope, { event: 'recall_start', timestamp: '2026-08-28T05:00:01.000Z', result: 'started' })).rejects.toThrow()
      expect(await readFile(external, 'utf8')).toBe('unchanged')
      await logger.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
