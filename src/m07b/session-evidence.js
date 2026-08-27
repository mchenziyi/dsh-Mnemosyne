import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function extractStatusFromMessage(message) {
  if (!message || typeof message !== 'object') return 'unknown'
  if (message.isError) return 'error'

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text)
          if (parsed && typeof parsed === 'object') {
            if (parsed.is_error || parsed.error) return 'error'
            if (typeof parsed.status === 'string') {
              const s = parsed.status.toLowerCase()
              if (['pass', 'created', 'promoted', 'forgotten', 'noop', 'opened', 'found'].includes(s)) {
                return s
              }
            }
            if (parsed.disclosure_id || parsed.retrieval_id || parsed.schema_version || parsed.generation || parsed.items || parsed.short_term || parsed.long_term || parsed.results) {
              return 'pass'
            }
          }
        } catch {}

        const text = block.text.toLowerCase()
        if (text.includes('"is_error":true') || text.includes('error:')) return 'error'
        if (text.includes('status: created')) return 'created'
        if (text.includes('status: promoted')) return 'promoted'
        if (text.includes('status: forgotten')) return 'forgotten'
        if (text.includes('status: noop') || text.includes('noop')) return 'noop'
        if (text.includes('status: opened') || text.includes('opened')) return 'opened'
        if (text.includes('status: pass') || text.includes('search_disclosure: pass') || text.includes('generation') || text.includes('mnemosyne')) {
          return 'pass'
        }
        if (text.trim().length > 0) {
          return 'pass'
        }
      }
    }
  }

  return 'unknown'
}

export function extractToolEventSummary(sessionEvents) {
  if (!Array.isArray(sessionEvents)) {
    return {
      tool_calls: [],
      tool_results: [],
      completed_turns: 0,
    }
  }

  const tool_calls = []
  const tool_results = []
  let completed_turns = 0

  for (const ev of sessionEvents) {
    if (!ev || typeof ev !== 'object') continue

    if (ev.type === 'tool/call') {
      const data = ev.data || ev
      const call_id = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : ''
      const tool_name = typeof data.name === 'string' ? data.name : typeof data.tool_name === 'string' ? data.tool_name : ''
      const turn = typeof data.turn === 'number' ? data.turn : 1
      const step = typeof data.step === 'number' ? data.step : 1

      tool_calls.push({
        call_id,
        tool_name,
        turn,
        step,
      })
    } else if (ev.type === 'tool/result') {
      const data = ev.data || ev
      let call_id = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : ''
      let is_error = Boolean(data.isError || data.is_error || (data.message && data.message.isError))
      let status = 'unknown'

      if (data.message && typeof data.message === 'object') {
        if (!call_id) call_id = typeof data.message.callId === 'string' ? data.message.callId : ''
        status = extractStatusFromMessage(data.message)
      } else if (data.content) {
        status = extractStatusFromMessage({ content: data.content, isError: is_error })
      } else if (typeof data.result === 'string' || typeof data.value === 'string' || (data.data && typeof data.data === 'string')) {
        const textStr = typeof data.result === 'string' ? data.result : typeof data.value === 'string' ? data.value : data.data
        status = extractStatusFromMessage({ content: [{ type: 'text', text: textStr }], isError: is_error })
      } else if (data.data && typeof data.data === 'object') {
        status = extractStatusFromMessage({ content: [{ type: 'text', text: JSON.stringify(data.data) }], isError: is_error })
      } else {
        status = !is_error ? 'pass' : 'error'
      }

      if (status === 'unknown' && !is_error) {
        status = 'pass'
      }

      tool_results.push({
        call_id,
        is_error,
        status,
      })
    } else if (ev.type === 'turn/end') {
      const data = ev.data || ev
      if (data.reason && typeof data.reason === 'object' && data.reason.kind === 'completed') {
        completed_turns++
      } else if (data.status === 'completed') {
        completed_turns++
      }
    }
  }

  return {
    tool_calls,
    tool_results,
    completed_turns,
  }
}

export async function writeSessionEvidence(evidenceDir, runId, summary) {
  const sessionEventsDir = join(evidenceDir, 'session-events')
  await mkdir(sessionEventsDir, { recursive: true, mode: 0o700 })

  const filePath = join(sessionEventsDir, `${runId}.json`)
  const payload = JSON.stringify(
    {
      schema_version: 1,
      run_id: runId,
      summary,
      recorded_at: new Date().toISOString(),
    },
    null,
    2
  )

  await writeFile(filePath, payload, { mode: 0o600 })
}

export async function readSessionEvidence(evidenceDir, runId) {
  const filePath = join(evidenceDir, 'session-events', `${runId}.json`)
  try {
    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    return data.summary || null
  } catch {
    return null
  }
}
