import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedScope } from '../src/runtime-scope.js'
import { extractAcquisitionEvidence } from '../src/acquisition-evidence.js'

describe('MVP-05 acquisition evidence extraction', () => {
  const dummyScope: ResolvedScope = {
    schema_version: 1,
    session_id: 'session_test_1',
    project_root: '/Users/czy/Desktop/demo/test-project',
    source: 'explicit_config',
    project_scope_id: 'sha256_' + '1'.repeat(64),
    session_scope_id: 'sha256_' + '2'.repeat(64),
  }

  function createMockSession(events: SessionEvent[]): Session {
    return {
      id: 'session_test_1' as never,
      events,
    } as unknown as Session
  }

  it('rejects missing completion reason and missing route, while accepting explicit rc.2 stop', () => {
    const makeEvents = (reason: unknown, includeRoute = true): SessionEvent[] => {
      const events: SessionEvent[] = []
      if (includeRoute) {
        events.push({
          seq: 0,
          time: '2026-08-25T07:59:50.000Z',
          type: 'request/header',
          turn: 1,
          data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } },
        } as never)
      }
      events.push(
        {
          seq: 1,
          time: '2026-08-25T07:59:51.000Z',
          type: 'user/message',
          turn: 1,
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'User text' }] },
        } as never,
        {
          seq: 2,
          time: '2026-08-25T07:59:52.000Z',
          type: 'assistant/message',
          turn: 1,
          data: {
            message: {
              source: { kind: 'model' },
              content: [{ type: 'text', text: 'Assistant text' }],
            },
          },
        } as never,
        {
          seq: 3,
          time: '2026-08-25T08:00:00.000Z',
          type: 'turn/end',
          turn: 1,
          data: reason === undefined ? { turn: 1 } : { turn: 1, reason },
        } as never,
      )
      return events
    }

    const missingReason = makeEvents(undefined)
    expect(extractAcquisitionEvidence(createMockSession(missingReason), missingReason.at(-1)!, dummyScope)).toBeNull()

    const missingRoute = makeEvents('stop', false)
    expect(extractAcquisitionEvidence(createMockSession(missingRoute), missingRoute.at(-1)!, dummyScope)).toBeNull()

    const explicitStop = makeEvents('stop')
    expect(extractAcquisitionEvidence(createMockSession(explicitStop), explicitStop.at(-1)!, dummyScope)).not.toBeNull()
  })

  it('extracts valid evidence from a completed turn with user message, assistant message, and route', () => {
    const turnEndEvent: SessionEvent = {
      seq: 5,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: {
        turn: 1,
        reason: { kind: 'completed' },
      },
    } as never

    const events: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'turn/start',
        turn: 1,
        data: { turn: 1 },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:51.000Z',
        type: 'request/header',
        turn: 1,
        data: {
          header: {
            config: {
              provider: 'deepseek',
              model: 'deepseek-chat',
            },
          },
          reason: 'initial',
        },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: {
          id: 'msg_user_1',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'How should we handle caching?' }],
        },
      } as never,
      {
        seq: 3,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_asst_1',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [{ type: 'text', text: 'Always keep the targeted compiler cache.' }],
          },
        },
      } as never,
      turnEndEvent,
    ]

    const session = createMockSession(events)
    const evidence = extractAcquisitionEvidence(session, turnEndEvent, dummyScope)
    expect(evidence).not.toBeNull()
    expect(evidence!.schema_version).toBe(1)
    expect(evidence!.project_scope_id).toBe(dummyScope.project_scope_id)
    expect(evidence!.session_scope_id).toBe(dummyScope.session_scope_id)
    expect(evidence!.turn).toBe(1)
    expect(evidence!.turn_end_seq).toBe(5)
    expect(evidence!.turn_end_time).toBe('2026-08-25T08:00:00.000Z')
    expect(evidence!.route).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(evidence!.user_text).toBe('How should we handle caching?')
    expect(evidence!.assistant_text).toBe('Always keep the targeted compiler cache.')
    expect(evidence!.evidence_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
  })

  it('excludes reasoning blocks, tool calls, tool results, plugin injections, images, and system prompts', () => {
    const turnEndEvent: SessionEvent = {
      seq: 8,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: {
        turn: 1,
        reason: { kind: 'completed' },
      },
    } as never

    const events: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: {
          header: {
            system: 'SECRET SYSTEM PROMPT DO NOT LEAK',
            config: { provider: 'deepseek', model: 'deepseek-chat' },
          },
          reason: 'initial',
        },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:51.000Z',
        type: 'user/message',
        turn: 1,
        data: {
          id: 'msg_plugin_1',
          source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
          content: [{ type: 'text', text: 'Plugin recall notice: injected memory' }],
        },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: {
          id: 'msg_user_direct',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'Direct user question about build optimization' },
            { type: 'image', attachment: { id: 'att_1', mimeType: 'image/png' } },
          ],
        },
      } as never,
      {
        seq: 3,
        time: '2026-08-25T07:59:53.000Z',
        type: 'assistant/message',
        turn: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_asst_step1',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [
              { type: 'reasoning', text: 'Internal thinking: examine files in /etc/secret' },
              { type: 'tool-call', id: 'call_1', name: 'fs_read', arguments: '{"path":"/tmp/secret"}' },
            ],
          },
        },
      } as never,
      {
        seq: 4,
        time: '2026-08-25T07:59:54.000Z',
        type: 'tool/call',
        turn: 1,
        step: 1,
        data: { turn: 1, step: 1, callId: 'call_1', name: 'fs_read', arguments: '{"path":"/tmp/secret"}' },
      } as never,
      {
        seq: 5,
        time: '2026-08-25T07:59:55.000Z',
        type: 'tool/result',
        turn: 1,
        step: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_tool_res',
            source: { kind: 'tool', callId: 'call_1' },
            content: [{ type: 'text', text: 'sensitive tool output' }],
          },
        },
      } as never,
      {
        seq: 6,
        time: '2026-08-25T07:59:56.000Z',
        type: 'assistant/message',
        turn: 1,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'msg_asst_step2',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [
              { type: 'reasoning', text: 'Hidden thoughts 2' },
              { type: 'text', text: 'Final visible solution: Use incremental rebuild.' },
            ],
          },
        },
      } as never,
      turnEndEvent,
    ]

    const session = createMockSession(events)
    const evidence = extractAcquisitionEvidence(session, turnEndEvent, dummyScope)
    expect(evidence).not.toBeNull()
    expect(evidence!.user_text).toBe('Direct user question about build optimization')
    expect(evidence!.assistant_text).toBe('Final visible solution: Use incremental rebuild.')

    // Ensure zero leakage of sensitive components in evidence
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain('SECRET SYSTEM PROMPT')
    expect(serialized).not.toContain('Plugin recall notice')
    expect(serialized).not.toContain('Internal thinking')
    expect(serialized).not.toContain('Hidden thoughts')
    expect(serialized).not.toContain('/tmp/secret')
    expect(serialized).not.toContain('sensitive tool output')
  })

  it('does not let a plugin message after the user overwrite consolidation evidence', () => {
    const events = [
      { seq: 0, time: '2026-08-25T07:59:50.000Z', type: 'request/header', turn: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
      { seq: 1, time: '2026-08-25T07:59:51.000Z', type: 'user/message', turn: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real user task' }] } },
      { seq: 2, time: '2026-08-25T07:59:52.000Z', type: 'user/message', turn: 1, data: { source: { kind: 'plugin', plugin: 'system', form: 'context' }, content: [{ type: 'text', text: 'plugin context must not become the task' }] } },
      { seq: 3, time: '2026-08-25T07:59:53.000Z', type: 'assistant/message', turn: 1, data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'completed result' }] } } },
      { seq: 4, time: '2026-08-25T08:00:00.000Z', type: 'turn/end', turn: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const evidence = extractAcquisitionEvidence(createMockSession(events), events[4]!, dummyScope)
    expect(evidence?.user_text).toBe('real user task')
  })

  it('correctly isolates multi-turn sessions and ignores previous turns or seed history', () => {
    const turnEndEvent2: SessionEvent = {
      seq: 10,
      time: '2026-08-25T08:10:00.000Z',
      type: 'turn/end',
      turn: 2,
      data: {
        turn: 2,
        reason: { kind: 'completed' },
      },
    } as never

    const events: SessionEvent[] = [
      // Turn 1
      {
        seq: 0,
        time: '2026-08-25T08:00:00.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 1 User Text' }] },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T08:00:05.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a1', source: { kind: 'model', provider: 'p1', model: 'm1' }, content: [{ type: 'text', text: 'Turn 1 Asst Text' }] } },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T08:00:10.000Z',
        type: 'turn/end',
        turn: 1,
        data: { turn: 1, reason: { kind: 'completed' } },
      } as never,
      // Turn 2
      {
        seq: 3,
        time: '2026-08-25T08:05:00.000Z',
        type: 'request/header',
        turn: 2,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'change' },
      } as never,
      {
        seq: 4,
        time: '2026-08-25T08:05:01.000Z',
        type: 'user/message',
        turn: 2,
        data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 2 User Text' }] },
      } as never,
      {
        seq: 5,
        time: '2026-08-25T08:05:05.000Z',
        type: 'assistant/message',
        turn: 2,
        data: { turn: 2, step: 1, message: { id: 'a2', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Turn 2 Asst Text' }] } },
      } as never,
      turnEndEvent2,
    ]

    const session = createMockSession(events)
    const evidence = extractAcquisitionEvidence(session, turnEndEvent2, dummyScope)
    expect(evidence).not.toBeNull()
    expect(evidence!.turn).toBe(2)
    expect(evidence!.user_text).toBe('Turn 2 User Text')
    expect(evidence!.assistant_text).toBe('Turn 2 Asst Text')
    expect(evidence!.route).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('safely skips (returns null) for incomplete or non-completed turns', () => {
    // Non-completed turn reason
    const abortedTurnEnd: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    } as never
    const session = createMockSession([abortedTurnEnd])
    expect(extractAcquisitionEvidence(session, abortedTurnEnd, dummyScope)).toBeNull()

    // Missing user text
    const noUserTurnEnd: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never
    const noUserSession = createMockSession([
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'text' }] } },
      } as never,
      noUserTurnEnd,
    ])
    expect(extractAcquisitionEvidence(noUserSession, noUserTurnEnd, dummyScope)).toBeNull()

    // Interrupted assistant message
    const interruptedSession = createMockSession([
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'user' }] },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: {
          turn: 1,
          step: 1,
          interrupted: true,
          message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'cut off' }] },
        },
      } as never,
      noUserTurnEnd,
    ])
    expect(extractAcquisitionEvidence(interruptedSession, noUserTurnEnd, dummyScope)).toBeNull()
  })

  it('bounds text lengths by Unicode code points (user: 4000 -> 2000+2000, assistant: 6000 -> 3000+3000)', () => {
    const longUser = 'U'.repeat(2500) + '中间部分' + 'Z'.repeat(2500) // 5004 code points
    const longAsst = 'A'.repeat(3500) + '中间助手' + 'B'.repeat(3500) // 7004 code points

    const turnEndEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const session = createMockSession([
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: longUser }] },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: longAsst }] } },
      } as never,
      turnEndEvent,
    ])

    const evidence = extractAcquisitionEvidence(session, turnEndEvent, dummyScope)
    expect(evidence).not.toBeNull()

    const userCodePoints = Array.from(evidence!.user_text)
    expect(userCodePoints.length).toBe(4000)
    expect(evidence!.user_text.startsWith('U'.repeat(2000))).toBe(true)
    expect(evidence!.user_text.endsWith('Z'.repeat(2000))).toBe(true)

    const asstCodePoints = Array.from(evidence!.assistant_text)
    expect(asstCodePoints.length).toBe(6000)
    expect(evidence!.assistant_text.startsWith('A'.repeat(3000))).toBe(true)
    expect(evidence!.assistant_text.endsWith('B'.repeat(3000))).toBe(true)
  })

  it('rejects text containing control characters by returning null', () => {
    const turnEndEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const session = createMockSession([
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Null byte \0 in text' }] },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'asst text' }] } },
      } as never,
      turnEndEvent,
    ])

    expect(extractAcquisitionEvidence(session, turnEndEvent, dummyScope)).toBeNull()
  })

  it('maintains frozen event world: appends after turn/end do not affect route or evidence text', () => {
    const turnEndEvent: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never

    const events: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original User Text' }] },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a1', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Original Asst Text' }] } },
      } as never,
      turnEndEvent,
      // Subsequent events appended after turn/end
      {
        seq: 4,
        time: '2026-08-25T08:00:05.000Z',
        type: 'request/header',
        turn: 2,
        data: { header: { config: { provider: 'other-provider', model: 'other-model' } }, reason: 'change' },
      } as never,
      {
        seq: 5,
        time: '2026-08-25T08:00:06.000Z',
        type: 'user/message',
        turn: 2,
        data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'SENSITIVE SECRET TEXT IN NEXT TURN' }] },
      } as never,
      {
        seq: 6,
        time: '2026-08-25T08:00:07.000Z',
        type: 'assistant/message',
        turn: 2,
        data: { turn: 2, step: 1, message: { id: 'a2', source: { kind: 'model', provider: 'other-provider', model: 'other-model' }, content: [{ type: 'text', text: 'SENSITIVE ASST OUTPUT' }] } },
      } as never,
    ]

    const session = createMockSession(events)
    const evidence = extractAcquisitionEvidence(session, turnEndEvent, dummyScope)
    expect(evidence).not.toBeNull()
    expect(evidence!.turn).toBe(1)
    expect(evidence!.turn_end_seq).toBe(3)
    expect(evidence!.route).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(evidence!.user_text).toBe('Original User Text')
    expect(evidence!.assistant_text).toBe('Original Asst Text')

    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain('other-provider')
    expect(serialized).not.toContain('other-model')
    expect(serialized).not.toContain('SENSITIVE')
  })

  it('fails closed (returns null) for missing, fabricated, duplicate, or mismatched turn/end events', () => {
    const validTurnEnd = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent

    const baseEvents: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'user' }] },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'asst' }] } },
      } as never,
      validTurnEnd,
    ]

    // 1. Missing in session.events entirely (fabricated turnEndEvent)
    const fabricatedTurnEnd: SessionEvent = {
      seq: 99,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent
    expect(extractAcquisitionEvidence(createMockSession(baseEvents), fabricatedTurnEnd, dummyScope)).toBeNull()

    // 2. Identity mismatch: passed event has different time than durable event with same seq
    const mismatchedTimeTurnEnd: SessionEvent = {
      ...validTurnEnd,
      time: '2026-08-25T08:05:00.000Z',
    } as unknown as SessionEvent
    expect(extractAcquisitionEvidence(createMockSession(baseEvents), mismatchedTimeTurnEnd, dummyScope)).toBeNull()

    // 3. Duplicate matching turn/end with identical seq
    const duplicateEvents = [...baseEvents, { ...validTurnEnd }]
    expect(extractAcquisitionEvidence(createMockSession(duplicateEvents), validTurnEnd, dummyScope)).toBeNull()
  })

  it('fails closed when session events seq is out-of-order or corrupt', () => {
    const validTurnEnd: SessionEvent = {
      seq: 3,
      time: '2026-08-25T08:00:00.000Z',
      type: 'turn/end',
      turn: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent

    // Out of order seq: 0, 2, 1, 3
    const outOfOrderEvents: SessionEvent[] = [
      {
        seq: 0,
        time: '2026-08-25T07:59:50.000Z',
        type: 'request/header',
        turn: 1,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
      } as never,
      {
        seq: 2,
        time: '2026-08-25T07:59:55.000Z',
        type: 'assistant/message',
        turn: 1,
        data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'asst' }] } },
      } as never,
      {
        seq: 1,
        time: '2026-08-25T07:59:52.000Z',
        type: 'user/message',
        turn: 1,
        data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'user' }] },
      } as never,
      validTurnEnd,
    ]

    expect(extractAcquisitionEvidence(createMockSession(outOfOrderEvents), validTurnEnd, dummyScope)).toBeNull()
  })
})
