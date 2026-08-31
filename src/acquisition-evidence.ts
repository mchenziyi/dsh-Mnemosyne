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
    reason?: { kind?: string } | string
  } | undefined

  const reasonKind = typeof endData?.reason === 'string' ? endData?.reason : endData?.reason?.kind
  if (reasonKind !== 'completed' && reasonKind !== 'stop') {
    return null
  }

  const targetTurn = typeof (turnEndEvent as { turn?: number }).turn === 'number'
    ? (turnEndEvent as { turn?: number }).turn
    : (endData as { turn?: number } | undefined)?.turn

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
      const d = ev.data as { turn?: number; reason?: { kind?: string } | string } | undefined
      const evTurn = typeof (ev as { turn?: number }).turn === 'number' ? (ev as { turn?: number }).turn : d?.turn
      const evTimeIso = new Date(ev.time).toISOString()
      const dReasonKind = typeof d?.reason === 'string' ? d?.reason : d?.reason?.kind
      const matchSeq = turnEndEvent.seq === undefined || ev.seq === turnEndEvent.seq
      if (
        matchSeq &&
        evTimeIso === turnEndTimeIso &&
        evTurn === targetTurn &&
        (dReasonKind === 'completed' || dReasonKind === 'stop')
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

  let currentTurn: number | null = null

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.seq > matchingDurableTurnEnd.seq) {
      break
    }

    if (event.type === 'turn/start') {
      const d = event.data as { turn?: number } | undefined
      currentTurn = (typeof (event as { turn?: number }).turn === 'number' ? (event as { turn?: number }).turn : d?.turn) ?? null
    }

    const eventTurn = typeof (event as { turn?: number }).turn === 'number'
      ? (event as { turn?: number }).turn
      : (event.data as { turn?: number } | undefined)?.turn

    const effectiveTurn = eventTurn ?? currentTurn

    // Collect route: last valid request/header prior to or at turn_end_seq
    if (event.type === 'request/header') {
      const headerData = event.data as any
      const cfg = headerData?.header?.config || headerData?.config || headerData?.header
      const provider = cfg?.provider || headerData?.provider
      const model = cfg?.model || headerData?.model
      if (
        typeof provider === 'string' &&
        typeof model === 'string' &&
        provider.length > 0 &&
        model.length > 0
      ) {
        lastRoute = { provider, model }
      }
    }

    // Only inspect messages for targetTurn
    if (effectiveTurn !== null && effectiveTurn !== undefined && effectiveTurn !== targetTurn) {
      continue
    }

    if (event.type === 'user/message') {
      const userData = event.data as any
      const userMessage = userData?.message || userData
      if (userMessage?.source?.kind !== 'user') continue
      const content = userMessage?.content

      if (Array.isArray(content)) {
        const textParts = content
          .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
          .map((b: any) => b.text)
        if (textParts.length > 0) {
          lastUserText = textParts.join('\n')
        }
      }
    }

    if (event.type === 'assistant/message') {
      const asstData = event.data as any
      const asstMsg = asstData?.message || asstData

      if (!lastRoute && asstMsg?.provider && asstMsg?.model) {
        lastRoute = { provider: asstMsg.provider, model: asstMsg.model }
      }

      if (asstData?.interrupted === true || asstMsg?.interrupted === true) {
        isAssistantInterrupted = true
      } else if (Array.isArray(asstMsg?.content)) {
        isAssistantInterrupted = false
        const textParts = asstMsg.content
          .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
          .map((b: any) => b.text)
        if (textParts.length > 0) {
          lastAssistantText = textParts.join('\n')
        }
      }
    }
  }

  if (!lastRoute || !lastUserText || !lastAssistantText || isAssistantInterrupted) {
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
