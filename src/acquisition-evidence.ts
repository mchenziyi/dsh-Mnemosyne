import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedScope } from './runtime-scope.js'
import {
  createAcquisitionEvidence,
  hasControlChars,
  type AcquisitionEvidence,
} from './protocol/acquisition.js'
import { isValidIsoUtc } from './memory-fact.js'

export function truncateByCodePoints(text: string, maxLimit: number, headCount: number, tailCount: number): string {
  const codePoints = Array.from(text)
  if (codePoints.length <= maxLimit) {
    return text
  }
  return codePoints.slice(0, headCount).join('') + codePoints.slice(-tailCount).join('')
}

export function extractAcquisitionEvidence(
  session: Session,
  turnEndEvent: SessionEvent,
  scope: ResolvedScope
): AcquisitionEvidence | null {
  if (!turnEndEvent || turnEndEvent.type !== 'turn/end') {
    return null
  }

  const endData = turnEndEvent.data as {
    turn?: number
    reason?: { kind?: string }
  } | undefined

  if (endData?.reason?.kind !== 'completed') {
    return null
  }

  const targetTurn = typeof (turnEndEvent as { turn?: number }).turn === 'number'
    ? (turnEndEvent as { turn?: number }).turn
    : endData?.turn

  if (typeof targetTurn !== 'number' || targetTurn < 1) {
    return null
  }

  const events = session?.events
  if (!Array.isArray(events) || events.length === 0) {
    return null
  }

  // 1. Verify strict monotonic seq ordering of session.events
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev || typeof ev.seq !== 'number' || typeof ev.type !== 'string' || !ev.time) {
      return null
    }
    if (i > 0 && ev.seq <= events[i - 1].seq) {
      return null
    }
  }

  const turnEndTimeIso = new Date(turnEndEvent.time).toISOString()
  if (!isValidIsoUtc(turnEndTimeIso)) {
    return null
  }

  // 2. Find unique and exact matching durable turn/end in session.events
  let matchingDurableTurnEnd: SessionEvent | null = null
  let matchCount = 0

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev.type === 'turn/end') {
      const d = ev.data as { turn?: number; reason?: { kind?: string } } | undefined
      const evTurn = typeof (ev as { turn?: number }).turn === 'number' ? (ev as { turn?: number }).turn : d?.turn
      const evTimeIso = new Date(ev.time).toISOString()
      if (
        ev.seq === turnEndEvent.seq &&
        evTimeIso === turnEndTimeIso &&
        evTurn === targetTurn &&
        d?.reason?.kind === 'completed'
      ) {
        matchingDurableTurnEnd = ev
        matchCount++
      }
    }
  }

  if (matchCount !== 1 || !matchingDurableTurnEnd) {
    return null
  }

  // 3. Scan events with seq <= matchingDurableTurnEnd.seq (frozen event world)
  let lastUserText: string | null = null
  let lastAssistantText: string | null = null
  let isAssistantInterrupted = false
  let lastRoute: { provider: string; model: string } | null = null

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.seq > matchingDurableTurnEnd.seq) {
      break
    }

    const eventTurn = typeof (event as { turn?: number }).turn === 'number'
      ? (event as { turn?: number }).turn
      : (event.data as { turn?: number } | undefined)?.turn

    // Collect route: last valid request/header prior to or at turn_end_seq
    if (event.type === 'request/header') {
      const headerData = event.data as {
        header?: {
          config?: {
            provider?: unknown
            model?: unknown
          }
        }
      } | undefined
      const cfg = headerData?.header?.config
      if (
        typeof cfg?.provider === 'string' &&
        typeof cfg?.model === 'string' &&
        cfg.provider.length > 0 &&
        cfg.model.length > 0
      ) {
        lastRoute = { provider: cfg.provider, model: cfg.model }
      }
    }

    // Only inspect messages for targetTurn
    if (eventTurn !== targetTurn) {
      continue
    }

    if (event.type === 'user/message') {
      const userData = event.data as {
        source?: { kind?: string }
        content?: ContentBlock[]
      } | undefined

      if (userData?.source?.kind === 'user' && Array.isArray(userData.content)) {
        const textParts = userData.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map((b) => b.text)
        if (textParts.length > 0) {
          lastUserText = textParts.join('\n')
        }
      }
    }

    if (event.type === 'assistant/message') {
      const asstData = event.data as {
        interrupted?: boolean
        message?: {
          content?: ContentBlock[]
        }
      } | undefined

      if (asstData?.interrupted === true) {
        isAssistantInterrupted = true
      } else if (asstData?.message && Array.isArray(asstData.message.content)) {
        isAssistantInterrupted = false
        const textParts = asstData.message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map((b) => b.text)
        if (textParts.length > 0) {
          lastAssistantText = textParts.join('\n')
        }
      }
    }
  }

  if (!lastUserText || !lastAssistantText || !lastRoute || isAssistantInterrupted) {
    return null
  }

  if (hasControlChars(lastUserText) || hasControlChars(lastAssistantText)) {
    return null
  }

  const boundedUserText = truncateByCodePoints(lastUserText, 4000, 2000, 2000)
  const boundedAssistantText = truncateByCodePoints(lastAssistantText, 6000, 3000, 3000)

  if (boundedUserText.length === 0 || boundedAssistantText.length === 0) {
    return null
  }

  try {
    return createAcquisitionEvidence({
      schema_version: 1,
      project_scope_id: scope.project_scope_id,
      session_scope_id: scope.session_scope_id,
      turn: targetTurn,
      turn_end_seq: matchingDurableTurnEnd.seq,
      turn_end_time: turnEndTimeIso,
      route: lastRoute,
      user_text: boundedUserText,
      assistant_text: boundedAssistantText,
    })
  } catch {
    return null
  }
}
