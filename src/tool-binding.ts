import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedScope, ScopeRuntime } from './runtime-scope.js'
import { MemoryStoreError } from './memory-store-error.js'
import { isValidIsoUtc } from './memory-fact.js'

export interface BoundToolCall {
  scope: ResolvedScope
  toolCall: SessionEvent
  evaluationAt: string
}

export function resolveBoundToolCall(
  exec: ToolRunContext,
  expectedToolName: string,
  scopeRuntime: ScopeRuntime
): BoundToolCall {
  if (!exec || typeof exec !== 'object') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const { callId } = exec
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const resolved = scopeRuntime.resolveExecution(exec)
  if (resolved.status !== 'ready') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  const scope = resolved.scope
  const session = exec.agent?.session

  const events = session?.events
  if (!Array.isArray(events) || events.length === 0) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  // Verify strict monotonic seq ordering
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev || typeof ev.seq !== 'number' || typeof ev.type !== 'string' || !ev.time) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    if (i > 0 && ev.seq <= events[i - 1].seq) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
  }

  let matchingToolCall: SessionEvent | null = null
  let matchCount = 0

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev.type === 'tool/call') {
      const data = ev.data as { callId?: string; name?: string } | undefined
      if (data?.callId === callId) {
        if (data.name !== expectedToolName) {
          throw new MemoryStoreError('memory_store_invalid_input')
        }
        matchingToolCall = ev
        matchCount++
      }
    }
  }

  if (matchCount !== 1 || !matchingToolCall) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (!isValidIsoUtc(matchingToolCall.time)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const evaluationAt = matchingToolCall.time

  return {
    scope,
    toolCall: matchingToolCall,
    evaluationAt,
  }
}
