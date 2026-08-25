import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedScope, ScopeRuntime } from './runtime-scope.js'
import {
  computeCandidateSha256,
  computeManualEventKey,
  computeManualMemoryId,
  validateMemoryCandidate,
} from './protocol/acquisition.js'
import { openMemoryFactStore, type MemoryFactStore } from './memory-store.js'
import { createOKFCompiler, type OKFCompiler } from './okf-compiler.js'
import { createCandidateWriter, type CandidateWriter } from './candidate-writer.js'
import { MemoryStoreError } from './memory-store-error.js'

export interface RememberRuntimeOptions {
  scopeRuntime: ScopeRuntime
  storeFactory?: (scope: ResolvedScope) => MemoryFactStore
  compiler?: OKFCompiler
  writer?: CandidateWriter
}

export interface RememberOutput {
  status: 'created' | 'noop'
  memory_id: string
  content_sha256: string
  generation_id: string
}

export interface RememberRuntime {
  remember(rawArgs: unknown, exec?: ToolRunContext): Promise<RememberOutput>
}

const REMEMBER_PARAMETERS = {
  title: { type: 'string', required: true },
  summary: { type: 'string', required: true },
  body: { type: 'string', required: true },
  tags: {
    type: 'array',
    items: { type: 'string' },
  },
} as const

const REMEMBER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['created', 'noop'] },
    memory_id: { type: 'string', required: true },
    content_sha256: { type: 'string', required: true },
    generation_id: { type: 'string', required: true },
  },
} as const

export function createRememberTool(options: RememberRuntimeOptions): ReturnType<typeof defineTool> {
  const scopeRuntime = options.scopeRuntime
  const storeFactory = options.storeFactory ?? ((scope: ResolvedScope) =>
    openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  )
  const compiler = options.compiler ?? createOKFCompiler()
  const writer = options.writer ?? createCandidateWriter({ storeFactory, compiler })

  return defineTool({
    name: 'mnemosyne_remember',
    description: 'Manually record durable engineering knowledge into short-term project memory.',
    parameters: REMEMBER_PARAMETERS,
    output: {
      schema: REMEMBER_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown, exec?: ToolRunContext): Promise<RememberOutput> => {
      if (!exec || !exec.agent || !exec.callId) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }

      const scopeRes = scopeRuntime.resolveExecution(exec)
      if (scopeRes.status !== 'ready') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      const scope = scopeRes.scope

      const events = exec.agent.session?.events
      if (!Array.isArray(events)) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }

      let matchingToolCall: SessionEvent | null = null
      let matchCount = 0
      let hasConflictingCallId = false

      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        if (ev?.type === 'tool/call') {
          const d = ev.data as { callId?: string; name?: string } | undefined
          if (d?.callId === exec.callId) {
            if (
              d?.name === 'mnemosyne_remember' &&
              typeof ev.seq === 'number' &&
              ev.time
            ) {
              matchingToolCall = ev
              matchCount++
            } else {
              hasConflictingCallId = true
            }
          }
        }
      }

      if (hasConflictingCallId || matchCount !== 1 || !matchingToolCall) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }

      if (!args || typeof args !== 'object') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }

      const raw = args as Record<string, unknown>
      const allowedKeys = ['title', 'summary', 'body', 'tags']
      for (const k of Object.keys(raw)) {
        if (!allowedKeys.includes(k)) {
          throw new MemoryStoreError('memory_store_invalid_input')
        }
      }

      let candidate
      try {
        candidate = validateMemoryCandidate({
          schema_version: 1,
          decision: 'remember',
          title: raw.title,
          summary: raw.summary,
          body: raw.body,
          tags: raw.tags ?? [],
        })
      } catch (err: unknown) {
        throw new MemoryStoreError('memory_store_invalid_input', err)
      }

      if (candidate.decision !== 'remember') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }

      const toolCallTime = new Date(matchingToolCall.time).toISOString()
      const manualEventKey = computeManualEventKey({
        schema_version: 1,
        project_scope_id: scope.project_scope_id,
        session_scope_id: scope.session_scope_id,
        call_id: String(exec.callId),
        tool_call_seq: matchingToolCall.seq,
        tool_call_time: toolCallTime,
      })

      const candidateSha256 = computeCandidateSha256(candidate)
      const memoryId = computeManualMemoryId(manualEventKey, candidateSha256)

      // Use unified CandidateWriter
      const writeRes = await writer.write({
        source: 'manual',
        scope,
        candidate,
        eventKey: manualEventKey,
        candidateSha256,
        memoryId,
        createdAt: toolCallTime,
      })

      return writeRes
    },
  } as never)
}
