import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmRuntime, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedScope, ScopeRuntime } from './runtime-scope.js'
import {
  ACQUISITION_SYSTEM_PROMPT,
  buildAcquisitionUserPrompt,
  computeAutoMemoryId,
  computeCandidateSha256,
  computeEventKey,
  validateMemoryCandidate,
  type AcquisitionEvidence,
} from './protocol/acquisition.js'
import { extractAcquisitionEvidence } from './acquisition-evidence.js'
import { openMemoryFactStore, type MemoryFactStore } from './memory-store.js'
import { createOKFCompiler, type OKFCompiler } from './okf-compiler.js'
import { createCandidateWriter, type CandidateWriter } from './candidate-writer.js'

export interface AcquisitionRuntimeOptions {
  scopeRuntime: ScopeRuntime
  llm: LlmRuntime
  storeFactory?: (scope: ResolvedScope) => MemoryFactStore
  compiler?: OKFCompiler
  writer?: CandidateWriter
  autoCapture?: boolean
}

export interface AcquisitionRuntime {
  enqueueTurn(session: Session, turnEndEvent: SessionEvent): boolean
  drain(): Promise<void>
  dispose(): Promise<void>
  clear(): void
}

interface QueuedAcquisitionItem {
  session: Session
  turnEndEvent: SessionEvent
  scope: ResolvedScope
  evidence: AcquisitionEvidence
  eventKey: string
}

const MAX_QUEUE_ITEMS = 32
const MAX_SESSION_PENDING = 8
const MAX_OUTPUT_BYTES = 16384

async function consumeModelStream(
  stream: AsyncIterable<StreamChunk>,
  abortSignal: AbortSignal
): Promise<string> {
  let activeBlockType: 'text' | 'reasoning' | null = null
  let activeBlockIndex: number | null = null
  let completedTextBlockCount = 0
  let completedReasoningBlockCount = 0
  const closedIndices = new Set<number>()
  const openedIndices = new Set<number>()

  let textDeltaAccumulated = ''
  let blockEndText: string | null = null
  let finishCount = 0
  let finishReason: string | null = null
  let hasInvalidChunk = false
  let hasTrailingAfterFinish = false

  const iterator = stream[Symbol.asyncIterator]()

  try {
    while (true) {
      if (abortSignal.aborted) {
        hasInvalidChunk = true
        break
      }

      const { value: chunk, done } = await iterator.next()
      if (done) break

      if (finishCount > 0) {
        hasTrailingAfterFinish = true
        hasInvalidChunk = true
        break
      }

      switch (chunk.type) {
        case 'block-start': {
          // 4. No nested block-start
          if (activeBlockType !== null) {
            hasInvalidChunk = true
            break
          }
          // Cannot reuse an already opened/closed index
          if (openedIndices.has(chunk.index) || closedIndices.has(chunk.index)) {
            hasInvalidChunk = true
            break
          }
          openedIndices.add(chunk.index)

          if (chunk.blockType === 'text') {
            if (completedTextBlockCount > 0) {
              // 8. Exactly one text block allowed
              hasInvalidChunk = true
              break
            }
            activeBlockType = 'text'
            activeBlockIndex = chunk.index
          } else if (chunk.blockType === 'reasoning') {
            activeBlockType = 'reasoning'
            activeBlockIndex = chunk.index
          } else {
            hasInvalidChunk = true
            break
          }
          break
        }
        case 'text-delta': {
          // 1. Must have active text block with matching index
          // 5. No delta without block-start
          // 6. Closed block cannot receive deltas
          if (
            activeBlockType !== 'text' ||
            activeBlockIndex !== chunk.index ||
            closedIndices.has(chunk.index)
          ) {
            hasInvalidChunk = true
            break
          }
          textDeltaAccumulated += chunk.text
          if (Buffer.byteLength(textDeltaAccumulated, 'utf8') > MAX_OUTPUT_BYTES) {
            hasInvalidChunk = true
            break
          }
          break
        }
        case 'reasoning-delta': {
          // 2. Must have active reasoning block with matching index
          // 5. No delta without block-start
          if (
            activeBlockType !== 'reasoning' ||
            activeBlockIndex !== chunk.index ||
            closedIndices.has(chunk.index)
          ) {
            hasInvalidChunk = true
            break
          }
          // Reasoning content is discarded, but lifecycle is strictly validated
          break
        }
        case 'tool-call-delta': {
          hasInvalidChunk = true
          break
        }
        case 'block-end': {
          // 3. Block-end index and type must match active block
          // 5. No block-end without block-start
          if (
            activeBlockType === null ||
            activeBlockIndex !== chunk.index ||
            chunk.block.type !== activeBlockType
          ) {
            hasInvalidChunk = true
            break
          }

          if (chunk.block.type === 'text') {
            if (blockEndText !== null) {
              hasInvalidChunk = true
              break
            }
            blockEndText = chunk.block.text
            if (
              typeof blockEndText !== 'string' ||
              Buffer.byteLength(blockEndText, 'utf8') > MAX_OUTPUT_BYTES
            ) {
              hasInvalidChunk = true
              break
            }
            completedTextBlockCount++
          } else if (chunk.block.type === 'reasoning') {
            completedReasoningBlockCount++
          }

          closedIndices.add(chunk.index)
          activeBlockType = null
          activeBlockIndex = null
          break
        }
        case 'usage': {
          // 10. Usage can only appear on legal block boundaries (when no active block is open)
          if (activeBlockType !== null) {
            hasInvalidChunk = true
            break
          }
          break
        }
        case 'finish': {
          // 7. Finish arrives must NOT have unclosed blocks
          if (activeBlockType !== null) {
            hasInvalidChunk = true
            break
          }
          finishCount++
          finishReason = chunk.reason?.kind ?? null
          break
        }
        default: {
          hasInvalidChunk = true
          break
        }
      }

      if (hasInvalidChunk) {
        break
      }
    }
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {}
    }
  }

  if (
    hasInvalidChunk ||
    hasTrailingAfterFinish ||
    finishCount !== 1 ||
    finishReason !== 'stop' ||
    completedTextBlockCount !== 1 ||
    activeBlockType !== null
  ) {
    throw new Error('invalid_stream')
  }

  if (blockEndText === null) {
    throw new Error('missing_block_end_text')
  }

  if (textDeltaAccumulated.length > 0 && textDeltaAccumulated !== blockEndText) {
    throw new Error('inconsistent_stream_text')
  }

  const finalText = blockEndText
  if (Buffer.byteLength(finalText, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error('output_exceeded_byte_limit')
  }

  return finalText
}

export function createAcquisitionRuntime(options: AcquisitionRuntimeOptions): AcquisitionRuntime {
  const scopeRuntime = options.scopeRuntime
  const llm = options.llm
  const storeFactory = options.storeFactory ?? ((scope: ResolvedScope) =>
    openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  )
  const compiler = options.compiler ?? createOKFCompiler()
  const writer = options.writer ?? createCandidateWriter({ storeFactory, compiler })
  const autoCapture = options.autoCapture !== false

  let isDisposed = false
  const abortController = new AbortController()

  const seenEventKeys = new Set<string>()
  const seenEvidenceHashes = new Set<string>()
  const queue: QueuedAcquisitionItem[] = []
  const sessionPendingCount = new Map<string, number>()

  let isProcessing = false
  let activeProcessPromise: Promise<void> | null = null
  let drainResolvers: (() => void)[] = []

  function checkDrain(): void {
    if (queue.length === 0 && !isProcessing && !activeProcessPromise) {
      const resolvers = drainResolvers
      drainResolvers = []
      for (let i = 0; i < resolvers.length; i++) {
        resolvers[i]()
      }
    }
  }

  async function processItem(item: QueuedAcquisitionItem): Promise<void> {
    if (isDisposed || abortController.signal.aborted || !llm) {
      return
    }

    try {
      const evidence = item.evidence

      const generateOpts: GenerateOptions = {
        provider: evidence.route.provider,
        model: evidence.route.model,
        system: ACQUISITION_SYSTEM_PROMPT,
        messages: [
          {
            id: 'msg_prompt' as MessageId,
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: buildAcquisitionUserPrompt(evidence) }],
          },
        ],
        tools: [],
        maxTokens: 1024,
        signal: abortController.signal,
      }

      let textOutput: string
      try {
        const stream = llm.stream(generateOpts)
        textOutput = await consumeModelStream(stream, abortController.signal)
      } catch {
        return
      }

      if (isDisposed || abortController.signal.aborted) {
        return
      }

      const trimmed = textOutput.trim()
      if (trimmed.startsWith('```') || trimmed.endsWith('```')) {
        return
      }
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }

      let candidate
      try {
        candidate = validateMemoryCandidate(parsed)
      } catch {
        return
      }

      if (candidate.decision === 'skip') {
        return
      }

      // Delegate candidate check, fact write, and generation compilation to CandidateWriter
      const candidateSha256 = computeCandidateSha256(candidate)
      const memoryId = computeAutoMemoryId(item.eventKey, evidence.evidence_sha256, candidateSha256)

      await writer.write({
        source: 'auto',
        scope: item.scope,
        candidate,
        eventKey: item.eventKey,
        candidateSha256,
        memoryId,
        createdAt: evidence.turn_end_time,
      })
    } catch {
      // Contain all worker failures without leaking to session or caller
    }
  }

  function pump(): void {
    if (isProcessing || queue.length === 0 || isDisposed) {
      checkDrain()
      return
    }

    isProcessing = true
    const item = queue.shift()!

    const p = processItem(item)
    activeProcessPromise = p

    p.finally(() => {
      activeProcessPromise = null
      const currentPending = sessionPendingCount.get(item.session.id) ?? 1
      if (currentPending <= 1) {
        sessionPendingCount.delete(item.session.id)
      } else {
        sessionPendingCount.set(item.session.id, currentPending - 1)
      }
      isProcessing = false
      pump()
    })
  }

  function enqueueTurn(session: Session, turnEndEvent: SessionEvent): boolean {
    if (isDisposed || !autoCapture || !llm) {
      return false
    }

    if (!turnEndEvent || turnEndEvent.type !== 'turn/end') {
      return false
    }

    const endData = turnEndEvent.data as { reason?: { kind?: string } } | undefined
    if (endData?.reason?.kind !== 'completed') {
      return false
    }

    const scopeRes = scopeRuntime.observeSession(session)
    if (scopeRes.status !== 'ready') {
      return false
    }

    const scope = scopeRes.scope
    const turn = typeof (turnEndEvent as { turn?: number }).turn === 'number'
      ? (turnEndEvent as { turn?: number }).turn
      : (turnEndEvent.data as { turn?: number } | undefined)?.turn

    if (typeof turn !== 'number' || turn < 1) {
      return false
    }

    const turnEndTimeIso = new Date(turnEndEvent.time).toISOString()
    let eventKey: string
    try {
      eventKey = computeEventKey({
        schema_version: 1,
        project_scope_id: scope.project_scope_id,
        session_scope_id: scope.session_scope_id,
        turn,
        turn_end_seq: turnEndEvent.seq,
        turn_end_time: turnEndTimeIso,
      })
    } catch {
      return false
    }

    if (seenEventKeys.has(eventKey)) {
      return false
    }

    const pending = sessionPendingCount.get(session.id) ?? 0
    if (queue.length >= MAX_QUEUE_ITEMS || pending >= MAX_SESSION_PENDING) {
      return false
    }

    const evidence = extractAcquisitionEvidence(session, turnEndEvent, scope)
    if (!evidence) {
      return false
    }

    if (seenEvidenceHashes.has(evidence.evidence_sha256)) {
      return false
    }

    seenEventKeys.add(eventKey)
    seenEvidenceHashes.add(evidence.evidence_sha256)
    sessionPendingCount.set(session.id, pending + 1)

    queue.push({
      session,
      turnEndEvent,
      scope,
      evidence,
      eventKey,
    })

    pump()
    return true
  }

  async function drain(): Promise<void> {
    if (queue.length === 0 && !isProcessing && !activeProcessPromise) {
      return
    }
    return new Promise<void>((resolve) => {
      drainResolvers.push(resolve)
    })
  }

  function clear(): void {
    isDisposed = true
    abortController.abort()
    queue.length = 0
    sessionPendingCount.clear()
    seenEventKeys.clear()
    seenEvidenceHashes.clear()
    checkDrain()
  }

  async function dispose(): Promise<void> {
    clear()
    if (activeProcessPromise) {
      try {
        await activeProcessPromise
      } catch {}
    }
    await drain()
  }

  return {
    enqueueTurn,
    drain,
    dispose,
    clear,
  }
}
