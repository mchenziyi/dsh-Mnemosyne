import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedScope } from '../runtime-scope.js'
import { ensureDirectoryChain, checkPathHierarchy } from '../memory-store-path.js'
import { canonicalBytes } from '../protocol/canonical.js'

export type RuntimeLogEventV2 =
  | 'recall_start' | 'recall_layer' | 'recall_no_match' | 'recall_completed' | 'recall_failed'
  | 'consolidation_start' | 'consolidation_skip' | 'consolidation_created' | 'consolidation_noop' | 'consolidation_failed'
  | 'catalog_updated' | 'generation_published' | 'generation_failed'

export interface RuntimeLogRecordV2 {
  event: RuntimeLogEventV2
  timestamp: string
  turn?: number
  result?: string
  reason_code?: string | null
  generation_id?: string
  catalog_id?: string
  memory_refs?: string[]
  index_refs?: string[]
  stage?: string
  expansion_step?: number
  disclosed_count?: number
  selected_count?: number
  elapsed_ms?: number
}

export interface RuntimeLoggerV2 {
  log(scope: ResolvedScope, record: RuntimeLogRecordV2): Promise<void>
  drain(): Promise<void>
  dispose(): Promise<void>
}

const EVENTS = new Set<RuntimeLogEventV2>([
  'recall_start', 'recall_layer', 'recall_no_match', 'recall_completed', 'recall_failed',
  'consolidation_start', 'consolidation_skip', 'consolidation_created', 'consolidation_noop', 'consolidation_failed',
  'catalog_updated', 'generation_published', 'generation_failed',
])
const REASON = /^[a-z][a-z0-9_]{0,63}$/
const REF = /^(?:sha256|gen|catalog|mem|node)_[a-z0-9._-]{1,64}$/

function validateRecord(record: RuntimeLogRecordV2): RuntimeLogRecordV2 {
  if (!EVENTS.has(record.event) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp)) throw new Error('runtime_log_invalid')
  if (record.reason_code !== undefined && record.reason_code !== null && !REASON.test(record.reason_code)) throw new Error('runtime_log_invalid')
  if (record.elapsed_ms !== undefined && (!Number.isInteger(record.elapsed_ms) || record.elapsed_ms < 0 || record.elapsed_ms > 86_400_000)) throw new Error('runtime_log_invalid')
  for (const value of [record.generation_id, record.catalog_id, ...(record.memory_refs ?? []), ...(record.index_refs ?? [])]) {
    if (value !== undefined && !REF.test(value)) throw new Error('runtime_log_invalid')
  }
  return structuredClone(record)
}

export function createRuntimeLoggerV2(): RuntimeLoggerV2 {
  let queue = Promise.resolve()
  let disposed = false

  const log = async (scope: ResolvedScope, raw: RuntimeLogRecordV2): Promise<void> => {
    if (disposed) return
    const record = validateRecord(raw)
    const line = `${canonicalBytes({
      schema_version: 1,
      project_scope_id: scope.project_scope_id,
      session_scope_id: scope.session_scope_id,
      ...record,
    })}\n`
    const operation = queue.then(async () => {
      const debugRoot = join(scope.project_root, '.dsh-mnemosyne', 'debug')
      const path = join(debugRoot, 'runtime.jsonl')
      await ensureDirectoryChain(scope.project_root, debugRoot)
      await checkPathHierarchy(scope.project_root, debugRoot, false)
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('runtime_log_invalid')
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    queue = operation.catch(() => undefined)
    return operation
  }

  return {
    log,
    async drain(): Promise<void> { await queue },
    async dispose(): Promise<void> { disposed = true; await queue },
  }
}
