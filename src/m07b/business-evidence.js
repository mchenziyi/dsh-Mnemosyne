import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  computeSha256,
} from './canary-protocol.js'
const HASH_REGEX = /^sha256_[0-9a-f]{64}$/

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validateStatusV3Output(output) {
  if (!isPlainObject(output)) throw new Error('invalid_status_output')
  const ver = output.protocol_version ?? output.schema_version
  if (ver !== 3 && ver !== 1) throw new Error('invalid_status_output')
  const avail = output.memory?.availability || output.availability || output.status
  if (!['ready', 'empty', 'unavailable', 'invalid', 'uninitialized', 'disabled'].includes(avail)) throw new Error('invalid_status_output')
  return output
}

function validateListMemoriesParams(params) {
  if (params === undefined || params === null) return {}
  if (!isPlainObject(params)) throw new Error('invalid_list_params')
  return params
}

function validateListMemoriesOutput(output) {
  if (Array.isArray(output)) return output
  if (isPlainObject(output) && Array.isArray(output.items)) return output
  throw new Error('invalid_list_output')
}

function validateSearchInput(input) {
  if (!isPlainObject(input)) throw new Error('invalid_search_input')
  if (typeof input.query !== 'string' || input.query.trim().length === 0) throw new Error('invalid_search_input')
  return input
}

function validateSearchDisclosure(disc) {
  if (!isPlainObject(disc)) throw new Error('invalid_search_disclosure')
  if (disc.schema_version !== 1) throw new Error('invalid_search_disclosure')
  if (typeof disc.retrieval_id !== 'string') throw new Error('invalid_search_disclosure')
  if (typeof disc.content_sha256 !== 'string' || !HASH_REGEX.test(disc.content_sha256)) throw new Error('invalid_search_disclosure')
  if (!Array.isArray(disc.items)) throw new Error('invalid_search_disclosure')
  return disc
}

function validateOpenInput(input) {
  if (!isPlainObject(input)) throw new Error('invalid_open_input')
  if (typeof input.retrieval_id !== 'string' || !input.retrieval_id) throw new Error('invalid_open_input')
  if (typeof input.search_disclosure_sha256 !== 'string' || !HASH_REGEX.test(input.search_disclosure_sha256)) throw new Error('invalid_open_input')
  if (typeof input.memory_id !== 'string' || !input.memory_id) throw new Error('invalid_open_input')
  return input
}

function validateOpenDisclosure(disc) {
  if (!isPlainObject(disc)) {
    throw new Error('invalid_open_disclosure')
  }
  const sv = disc.schema_version ?? disc.protocol_version ?? 1
  if (sv !== 1 && sv !== 3) {
    throw new Error('invalid_open_disclosure')
  }
  if (!isPlainObject(disc.memory_ref)) {
    throw new Error('invalid_open_disclosure')
  }
  if (typeof disc.body !== 'string' && typeof disc.text !== 'string') {
    throw new Error('invalid_open_disclosure')
  }
  return disc
}

function validateRememberArgs(cand) {
  if (!isPlainObject(cand)) throw new Error('invalid_memory_candidate')
  if (typeof cand.title !== 'string' || typeof cand.summary !== 'string' || typeof cand.body !== 'string') {
    throw new Error('invalid_memory_candidate')
  }
  return cand
}

function validateMemoryCandidate(cand) {
  if (!isPlainObject(cand)) throw new Error('invalid_memory_candidate')
  if (cand.schema_version !== 1) throw new Error('invalid_memory_candidate')
  if (!['remember', 'ignore'].includes(cand.decision)) throw new Error('invalid_memory_candidate')
  return cand
}

export const MNEMOSYNE_TOOLS = new Set([
  'mnemosyne_status',
  'mnemosyne_list',
  'mnemosyne_search',
  'mnemosyne_open',
  'mnemosyne_promote',
  'mnemosyne_forget',
  'mnemosyne_remember',
])

const RUN_ID_REGEX = /^run_[1-6]$/

function parseToolMessageJson(messageOrData) {
  if (!messageOrData) throw new Error('invalid_tool_result_format')

  function extractPayloadFromBlocks(blocks) {
    if (!Array.isArray(blocks)) return null
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.value !== undefined && b.value !== null) {
        if (typeof b.value === 'string') {
          try { return JSON.parse(b.value) } catch {}
        } else if (typeof b.value === 'object') {
          return b.value
        }
      }
      if (b.result !== undefined && b.result !== null) {
        if (typeof b.result === 'string') {
          try { return JSON.parse(b.result) } catch {}
        } else if (typeof b.result === 'object') {
          return b.result
        }
      }
      if (typeof b.text === 'string') {
        const trimmed = b.text.trim()
        const unquoted = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        try { return JSON.parse(unquoted) } catch {}
      }
      if (Array.isArray(b.content)) {
        const nested = extractPayloadFromBlocks(b.content)
        if (nested) return nested
      }
    }
    return null
  }

  if (typeof messageOrData === 'string') {
    const trimmed = messageOrData.trim()
    const unquoted = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try {
      return JSON.parse(unquoted)
    } catch {
      throw new Error('invalid_tool_result_format')
    }
  }

  if (typeof messageOrData === 'object') {
    if (Array.isArray(messageOrData.content)) {
      const fromBlocks = extractPayloadFromBlocks(messageOrData.content)
      if (fromBlocks) return fromBlocks
      throw new Error('invalid_tool_result_format')
    }
    if (messageOrData.value !== undefined && messageOrData.value !== null) {
      if (typeof messageOrData.value === 'string') {
        try { return JSON.parse(messageOrData.value) } catch {}
      } else if (typeof messageOrData.value === 'object') {
        return messageOrData.value
      }
    }
    if (messageOrData.result !== undefined && messageOrData.result !== null) {
      if (typeof messageOrData.result === 'string') {
        try { return JSON.parse(messageOrData.result) } catch {}
      } else if (typeof messageOrData.result === 'object') {
        return messageOrData.result
      }
    }
    if (messageOrData.data !== undefined && typeof messageOrData.data === 'object' && messageOrData.data !== null) {
      return messageOrData.data
    }
    return messageOrData
  }

  throw new Error('invalid_tool_result_format')
}

export function projectToolExecution(toolName, rawArgs, rawResult) {
  const args = rawArgs || {}
  const parsedResult = parseToolMessageJson(rawResult)

  switch (toolName) {
      case 'mnemosyne_status': {
        const validated = validateStatusV3Output(parsedResult)
        const memory = validated.memory || validated
        const availability = memory.availability || validated.status || 'ready'
        return {
          argument_binding: {},
          result_status: availability,
          result_binding: {
            availability,
            generation_id: memory.generation_id ?? null,
            short_term_count: typeof memory.short_term_count === 'number' ? memory.short_term_count : 0,
            long_term_count: typeof memory.long_term_count === 'number' ? memory.long_term_count : 0,
            total_count: typeof memory.total_count === 'number' ? memory.total_count : 0,
          },
        }
      }

    case 'mnemosyne_list': {
      const validatedParams = validateListMemoriesParams(args)
      const validatedResult = validateListMemoriesOutput(parsedResult)
      const rawList = Array.isArray(validatedResult) ? validatedResult : (validatedResult.items || [])
      const safeRefs = rawList.map((it) => ({
        tier: it.tier,
        session_scope_id: it.session_scope_id ?? null,
        memory_id: it.memory_id,
        content_sha256: it.content_sha256,
      }))

      return {
        argument_binding: {
          tier: validatedParams.tier || 'all',
          include_inactive: validatedParams.include_inactive ?? false,
          limit: typeof validatedParams.limit === 'number' ? validatedParams.limit : 50,
        },
        result_status: 'pass',
        result_binding: {
          memory_refs: safeRefs,
          total_count: typeof validatedResult.total_count === 'number' ? validatedResult.total_count : safeRefs.length,
          truncated: typeof validatedResult.truncated === 'boolean' ? validatedResult.truncated : false,
          result_sha256: (validatedResult.content_sha256 && HASH_REGEX.test(validatedResult.content_sha256))
            ? validatedResult.content_sha256
            : computeSha256(canonicalJson(safeRefs)),
        },
      }
    }

    case 'mnemosyne_search': {
      const validatedInput = validateSearchInput(args)
      const validatedResult = validateSearchDisclosure(parsedResult)
      const rawItems = Array.isArray(validatedResult.items) ? validatedResult.items : []
      const safeRefs = rawItems.map((it) => {
        const ref = it.memory_ref || it
        return {
          tier: ref.tier,
          session_scope_id: ref.session_scope_id ?? null,
          memory_id: ref.memory_id,
          content_sha256: ref.content_sha256,
        }
      })

      return {
        argument_binding: {
          query_sha256: computeSha256(validatedInput.query.trim()),
          component_hint: validatedInput.component_hint ?? null,
          top_k: typeof validatedInput.top_k === 'number' ? validatedInput.top_k : 10,
        },
        result_status: 'pass',
        result_binding: {
          retrieval_id: validatedResult.retrieval_id,
          search_disclosure_sha256: validatedResult.content_sha256,
          generation_ref: validatedResult.generation_ref
            ? {
                generation_id: validatedResult.generation_ref.generation_id,
                generation_sha256: validatedResult.generation_ref.generation_sha256,
                manifest_id: validatedResult.generation_ref.manifest_id,
                manifest_sha256: validatedResult.generation_ref.manifest_sha256,
                index_sha256: validatedResult.generation_ref.index_sha256,
              }
            : null,
          memory_refs: safeRefs,
          contains_body: false,
        },
      }
    }

    case 'mnemosyne_open': {
      const validatedInput = validateOpenInput(args)
      const validatedResult = validateOpenDisclosure(parsedResult)
      const ref = validatedResult.memory_ref || {}

      return {
        argument_binding: {
          retrieval_id: validatedInput.retrieval_id,
          search_disclosure_sha256: validatedInput.search_disclosure_sha256,
          memory_id: validatedInput.memory_id,
        },
        result_status: 'pass',
        result_binding: {
          open_disclosure_sha256: validatedResult.content_sha256,
          parent_disclosure_sha256: validatedResult.parent_disclosure_sha256,
          memory_ref: {
            tier: ref.tier,
            session_scope_id: ref.session_scope_id ?? null,
            memory_id: ref.memory_id,
            content_sha256: ref.content_sha256,
          },
          body_sha256: computeSha256(validatedResult.body || validatedResult.text || ''),
          body_present: true,
        },
      }
    }

    case 'mnemosyne_promote': {
      if (!args || typeof args !== 'object' || typeof args.memory_id !== 'string') {
        throw new Error('invalid_tool_arguments')
      }
      if (!parsedResult || typeof parsedResult !== 'object' || !['created', 'noop'].includes(parsedResult.status) || typeof parsedResult.memory_id !== 'string') {
        throw new Error('invalid_tool_result_format')
      }
      const isPromoted = parsedResult.status === 'created'
      return {
        argument_binding: {
          memory_id: args.memory_id,
        },
        result_status: isPromoted ? 'promoted' : 'noop',
        result_binding: {
          status: isPromoted ? 'promoted' : 'noop',
          source_memory_id: parsedResult.source_short_term_ref?.memory_id || args.memory_id,
          promoted_memory_id: parsedResult.memory_id,
          generation_id: parsedResult.generation_id,
        },
      }
    }

    case 'mnemosyne_forget': {
      if (!args || typeof args !== 'object' || typeof args.memory_id !== 'string' || !['short_term', 'long_term'].includes(args.tier)) {
        throw new Error('invalid_tool_arguments')
      }
      if (!parsedResult || typeof parsedResult !== 'object' || !['created', 'noop'].includes(parsedResult.status)) {
        throw new Error('invalid_tool_result_format')
      }
      const isForgotten = parsedResult.status === 'created'
      return {
        argument_binding: {
          tier: args.tier,
          memory_id: args.memory_id,
        },
        result_status: isForgotten ? 'forgotten' : 'noop',
        result_binding: {
          status: isForgotten ? 'forgotten' : 'noop',
          forget_id: parsedResult.forget_id || null,
          target_tier: parsedResult.target?.tier || args.tier,
          target_memory_id: parsedResult.target?.memory_id || args.memory_id,
          generation_id: parsedResult.generation_id,
        },
      }
    }

    case 'mnemosyne_remember': {
      const validatedCandidate = validateRememberArgs(args)
      if (!parsedResult || typeof parsedResult !== 'object' || !['created', 'noop'].includes(parsedResult.status)) {
        throw new Error('invalid_tool_result_format')
      }
      return {
        argument_binding: {
          title_sha256: computeSha256(validatedCandidate.title),
          summary_sha256: computeSha256(validatedCandidate.summary),
          body_sha256: computeSha256(validatedCandidate.body),
          tag_count: Array.isArray(validatedCandidate.tags) ? validatedCandidate.tags.length : 0,
        },
        result_status: parsedResult.status,
        result_binding: {
          status: parsedResult.status,
          memory_id: parsedResult.memory_id,
          content_sha256: parsedResult.content_sha256,
          generation_id: parsedResult.generation_id,
        },
      }
    }

      default:
        throw new Error('unknown_mnemosyne_tool')
    }
}

export function extractStrictSessionEvidence(params) {
  const { runId, projectScopeId, sessionId, sessionEvents } = params

  if (!runId || !RUN_ID_REGEX.test(runId)) throw new Error('invalid_run_id')
  if (!projectScopeId || !HASH_REGEX.test(projectScopeId)) throw new Error('invalid_project_scope_id')
  if (!sessionId || typeof sessionId !== 'string') throw new Error('invalid_session_id')

  const sessionIdHash = computeSha256(sessionId)

  const pendingCalls = new Map()
  const completedCalls = new Set()
  const toolExecutions = []
  let completedTurns = 0
  let currentTurn = 1

  if (Array.isArray(sessionEvents)) {
    for (const ev of sessionEvents) {
      if (!ev || typeof ev !== 'object') continue

      if (ev.type === 'assistant/message') {
        const msg = ev.data?.message || ev.data || ev
        const content = Array.isArray(msg.content) ? msg.content : []
        for (const block of content) {
          if (block && block.type === 'tool-call') {
            const callId = typeof block.id === 'string' ? block.id : typeof block.callId === 'string' ? block.callId : ''
            if (!callId) throw new Error('invalid_call_id')

            const toolName = typeof block.name === 'string' ? block.name : typeof block.tool_name === 'string' ? block.tool_name : ''
            if (!MNEMOSYNE_TOOLS.has(toolName)) {
              throw new Error('unknown_mnemosyne_tool')
            }

            if (completedCalls.has(callId)) {
              throw new Error('duplicate_call_id')
            }

            let args = block.arguments || block.args || block.parameters || {}
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args)
              } catch {}
            }

            pendingCalls.set(callId, {
              callId,
              toolName,
              args,
              turn: typeof ev.turn === 'number' ? ev.turn : currentTurn,
              step: typeof ev.step === 'number' ? ev.step : 1,
            })
          }
        }
      } else if (ev.type === 'tool/call') {
        const data = ev.data || ev
        const callId = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : ''
        if (!callId) throw new Error('invalid_call_id')

        const toolName = typeof data.name === 'string' ? data.name : typeof data.tool_name === 'string' ? data.tool_name : ''
        if (!MNEMOSYNE_TOOLS.has(toolName)) {
          throw new Error('unknown_mnemosyne_tool')
        }

        if (completedCalls.has(callId)) {
          throw new Error('duplicate_call_id')
        }

        let args = data.args || data.arguments || data.parameters || {}
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {}
        }

        pendingCalls.set(callId, {
          callId,
          toolName,
          args,
          turn: typeof data.turn === 'number' ? data.turn : currentTurn,
          step: typeof data.step === 'number' ? data.step : 1,
        })
      } else if (ev.type === 'tool/result') {
        const data = ev.data || ev
        let callId = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : ''
        if (!callId && data.message && typeof data.message === 'object') {
          if (typeof data.message.callId === 'string') callId = data.message.callId
          else if (data.message.source && typeof data.message.source.callId === 'string') callId = data.message.source.callId
          else if (Array.isArray(data.message.content)) {
            const tr = data.message.content.find((c) => c && typeof c.toolCallId === 'string')
            if (tr) callId = tr.toolCallId
          }
        }

        if (!callId || !pendingCalls.has(callId)) {
          if (completedCalls.has(callId)) {
            throw new Error('duplicate_tool_result')
          }
          throw new Error('orphan_tool_result')
        }

        const callInfo = pendingCalls.get(callId)
        pendingCalls.delete(callId)
        completedCalls.add(callId)

        const rawResultPayload = data.message || data.result || data.value || data.data || data

        const projection = projectToolExecution(callInfo.toolName, callInfo.args, rawResultPayload)
        const resultSha256 = computeSha256(canonicalJson(projection.result_binding))

        const execution = {
          ordinal: toolExecutions.length + 1,
          call_id_sha256: computeSha256(callId),
          tool_name: callInfo.toolName,
          argument_binding: projection.argument_binding,
          result_status: projection.result_status,
          result_binding: projection.result_binding,
          result_sha256: resultSha256,
        }

        toolExecutions.push(execution)
      } else if (ev.type === 'turn/end') {
        const data = ev.data || ev
        if (data.reason && typeof data.reason === 'object' && (data.reason.kind === 'completed' || data.reason.kind === 'stop' || data.reason.kind === 'tool-calls')) {
          completedTurns++
        } else if (data.status === 'completed' || data.status === 'success' || !data.error) {
          completedTurns++
        }
        currentTurn++
      }
    }
  }

  if (pendingCalls.size > 0) {
    throw new Error('unresolved_tool_call')
  }

  return createStrictSessionEvidence({
    run_id: runId,
    project_scope_id: projectScopeId,
    session_id_sha256: sessionIdHash,
    completed_turns: completedTurns,
    tool_executions: toolExecutions,
    recorded_at: new Date().toISOString(),
  })
}

export function computeSessionEvidenceSha256(evidence) {
  const { content_sha256, ...rest } = evidence
  return computeSha256(canonicalJson(rest))
}

export function createStrictSessionEvidence(params) {
  const {
    run_id,
    project_scope_id,
    session_id_sha256,
    completed_turns,
    tool_executions,
    recorded_at = new Date().toISOString(),
  } = params

  const base = {
    schema_version: 2,
    run_id,
    project_scope_id,
    session_id_sha256,
    completed_turns,
    tool_executions,
    recorded_at,
  }

  const content_sha256 = computeSessionEvidenceSha256(base)
  return {
    ...base,
    content_sha256,
  }
}

function assertExactObjectKeys(obj, allowedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('invalid_tool_execution')
  }
  const allowedSet = new Set(allowedKeys)
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) {
      throw new Error('invalid_tool_execution')
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj)) {
      throw new Error('invalid_tool_execution')
    }
  }
}

function validateToolExecution(exec, index) {
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) {
    throw new Error('invalid_tool_execution')
  }
  assertExactObjectKeys(exec, [
    'ordinal',
    'call_id_sha256',
    'tool_name',
    'argument_binding',
    'result_status',
    'result_binding',
    'result_sha256',
  ])

  if (exec.ordinal !== index + 1) throw new Error('invalid_tool_execution')
  if (!HASH_REGEX.test(exec.call_id_sha256)) throw new Error('invalid_tool_execution')
  if (!MNEMOSYNE_TOOLS.has(exec.tool_name)) throw new Error('invalid_tool_execution')
  if (!HASH_REGEX.test(exec.result_sha256)) throw new Error('invalid_tool_execution')

  const expectedResultSha256 = computeSha256(canonicalJson(exec.result_binding))
  if (exec.result_sha256 !== expectedResultSha256) {
    throw new Error('invalid_tool_result_hash')
  }

  const arg = exec.argument_binding
  const res = exec.result_binding

  switch (exec.tool_name) {
    case 'mnemosyne_status': {
      assertExactObjectKeys(arg, [])
      if (!['ready', 'degraded', 'unavailable', 'empty', 'uninitialized', 'disabled', 'invalid'].includes(exec.result_status)) {
        throw new Error('invalid_tool_execution')
      }
      assertExactObjectKeys(res, [
        'availability',
        'generation_id',
        'short_term_count',
        'long_term_count',
        'total_count',
      ])
      if (!['ready', 'degraded', 'unavailable', 'empty', 'uninitialized', 'disabled', 'invalid'].includes(res.availability)) throw new Error('invalid_tool_execution')
      if (res.generation_id !== null && typeof res.generation_id !== 'string') throw new Error('invalid_tool_execution')
      if (typeof res.short_term_count !== 'number' || !Number.isInteger(res.short_term_count) || res.short_term_count < 0) throw new Error('invalid_tool_execution')
      if (typeof res.long_term_count !== 'number' || !Number.isInteger(res.long_term_count) || res.long_term_count < 0) throw new Error('invalid_tool_execution')
      if (typeof res.total_count !== 'number' || !Number.isInteger(res.total_count) || res.total_count < 0) throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_list': {
      assertExactObjectKeys(arg, ['tier', 'include_inactive', 'limit'])
      if (!['all', 'short_term', 'long_term'].includes(arg.tier)) throw new Error('invalid_tool_execution')
      if (typeof arg.include_inactive !== 'boolean') throw new Error('invalid_tool_execution')
      if (typeof arg.limit !== 'number' || !Number.isInteger(arg.limit) || arg.limit < 1 || arg.limit > 100) throw new Error('invalid_tool_execution')
      if (exec.result_status !== 'pass') throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['memory_refs', 'total_count', 'truncated', 'result_sha256'])
      if (!Array.isArray(res.memory_refs)) throw new Error('invalid_tool_execution')
      for (const r of res.memory_refs) {
        assertExactObjectKeys(r, ['tier', 'session_scope_id', 'memory_id', 'content_sha256'])
        if (!['short_term', 'long_term'].includes(r.tier)) throw new Error('invalid_tool_execution')
        if (r.tier === 'short_term' && typeof r.session_scope_id !== 'string') throw new Error('invalid_tool_execution')
        if (r.tier === 'long_term' && r.session_scope_id !== null) throw new Error('invalid_tool_execution')
        if (typeof r.memory_id !== 'string') throw new Error('invalid_tool_execution')
        if (!HASH_REGEX.test(r.content_sha256)) throw new Error('invalid_tool_execution')
      }
      if (typeof res.total_count !== 'number' || !Number.isInteger(res.total_count) || res.total_count < 0) throw new Error('invalid_tool_execution')
      if (typeof res.truncated !== 'boolean') throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.result_sha256)) throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_search': {
      assertExactObjectKeys(arg, ['query_sha256', 'component_hint', 'top_k'])
      if (!HASH_REGEX.test(arg.query_sha256)) throw new Error('invalid_tool_execution')
      if (arg.component_hint !== null && typeof arg.component_hint !== 'string') throw new Error('invalid_tool_execution')
      if (typeof arg.top_k !== 'number' || !Number.isInteger(arg.top_k) || arg.top_k < 1 || arg.top_k > 100) throw new Error('invalid_tool_execution')
      if (exec.result_status !== 'pass') throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['retrieval_id', 'search_disclosure_sha256', 'generation_ref', 'memory_refs', 'contains_body'])
      if (typeof res.retrieval_id !== 'string') throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.search_disclosure_sha256)) throw new Error('invalid_tool_execution')
      if (res.generation_ref !== null) {
        assertExactObjectKeys(res.generation_ref, ['generation_id', 'generation_sha256', 'manifest_id', 'manifest_sha256', 'index_sha256'])
        if (typeof res.generation_ref.generation_id !== 'string') throw new Error('invalid_tool_execution')
        if (!HASH_REGEX.test(res.generation_ref.generation_sha256)) throw new Error('invalid_tool_execution')
        if (typeof res.generation_ref.manifest_id !== 'string') throw new Error('invalid_tool_execution')
        if (!HASH_REGEX.test(res.generation_ref.manifest_sha256)) throw new Error('invalid_tool_execution')
        if (!HASH_REGEX.test(res.generation_ref.index_sha256)) throw new Error('invalid_tool_execution')
      }
      if (!Array.isArray(res.memory_refs)) throw new Error('invalid_tool_execution')
      for (const r of res.memory_refs) {
        assertExactObjectKeys(r, ['tier', 'session_scope_id', 'memory_id', 'content_sha256'])
        if (!['short_term', 'long_term'].includes(r.tier)) throw new Error('invalid_tool_execution')
        if (r.tier === 'short_term' && typeof r.session_scope_id !== 'string') throw new Error('invalid_tool_execution')
        if (r.tier === 'long_term' && r.session_scope_id !== null) throw new Error('invalid_tool_execution')
        if (typeof r.memory_id !== 'string') throw new Error('invalid_tool_execution')
        if (!HASH_REGEX.test(r.content_sha256)) throw new Error('invalid_tool_execution')
      }
      if (res.contains_body !== false) throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_open': {
      assertExactObjectKeys(arg, ['retrieval_id', 'search_disclosure_sha256', 'memory_id'])
      if (typeof arg.retrieval_id !== 'string') throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(arg.search_disclosure_sha256)) throw new Error('invalid_tool_execution')
      if (typeof arg.memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (exec.result_status !== 'pass') throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['open_disclosure_sha256', 'parent_disclosure_sha256', 'memory_ref', 'body_sha256', 'body_present'])
      if (!HASH_REGEX.test(res.open_disclosure_sha256)) throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.parent_disclosure_sha256)) throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res.memory_ref, ['tier', 'session_scope_id', 'memory_id', 'content_sha256'])
      if (!['short_term', 'long_term'].includes(res.memory_ref.tier)) throw new Error('invalid_tool_execution')
      if (res.memory_ref.tier === 'short_term' && typeof res.memory_ref.session_scope_id !== 'string') throw new Error('invalid_tool_execution')
      if (res.memory_ref.tier === 'long_term' && res.memory_ref.session_scope_id !== null) throw new Error('invalid_tool_execution')
      if (typeof res.memory_ref.memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.memory_ref.content_sha256)) throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.body_sha256)) throw new Error('invalid_tool_execution')
      if (res.body_present !== true) throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_promote': {
      assertExactObjectKeys(arg, ['memory_id'])
      if (typeof arg.memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (!['promoted', 'noop'].includes(exec.result_status)) throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['status', 'source_memory_id', 'promoted_memory_id', 'generation_id'])
      if (!['promoted', 'noop'].includes(res.status)) throw new Error('invalid_tool_execution')
      if (typeof res.source_memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (typeof res.promoted_memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (typeof res.generation_id !== 'string') throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_forget': {
      assertExactObjectKeys(arg, ['tier', 'memory_id'])
      if (!['short_term', 'long_term'].includes(arg.tier)) throw new Error('invalid_tool_execution')
      if (typeof arg.memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (!['forgotten', 'noop'].includes(exec.result_status)) throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['status', 'forget_id', 'target_tier', 'target_memory_id', 'generation_id'])
      if (!['forgotten', 'noop'].includes(res.status)) throw new Error('invalid_tool_execution')
      if (res.forget_id !== null && typeof res.forget_id !== 'string') throw new Error('invalid_tool_execution')
      if (!['short_term', 'long_term'].includes(res.target_tier)) throw new Error('invalid_tool_execution')
      if (typeof res.target_memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (typeof res.generation_id !== 'string') throw new Error('invalid_tool_execution')
      break
    }
    case 'mnemosyne_remember': {
      assertExactObjectKeys(arg, ['title_sha256', 'summary_sha256', 'body_sha256', 'tag_count'])
      if (!HASH_REGEX.test(arg.title_sha256)) throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(arg.summary_sha256)) throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(arg.body_sha256)) throw new Error('invalid_tool_execution')
      if (typeof arg.tag_count !== 'number' || !Number.isInteger(arg.tag_count) || arg.tag_count < 0) throw new Error('invalid_tool_execution')
      if (!['created', 'noop'].includes(exec.result_status)) throw new Error('invalid_tool_execution')
      assertExactObjectKeys(res, ['status', 'memory_id', 'content_sha256', 'generation_id'])
      if (!['created', 'noop'].includes(res.status)) throw new Error('invalid_tool_execution')
      if (typeof res.memory_id !== 'string') throw new Error('invalid_tool_execution')
      if (!HASH_REGEX.test(res.content_sha256)) throw new Error('invalid_tool_execution')
      if (typeof res.generation_id !== 'string') throw new Error('invalid_tool_execution')
      break
    }
    default:
      throw new Error('invalid_tool_execution')
  }
}

export function validateStrictSessionEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('invalid_session_evidence')
  }

  const expectedTopKeys = new Set([
    'schema_version',
    'run_id',
    'project_scope_id',
    'session_id_sha256',
    'completed_turns',
    'tool_executions',
    'recorded_at',
    'content_sha256',
  ])

  for (const k of Object.keys(evidence)) {
    if (!expectedTopKeys.has(k)) {
      throw new Error('invalid_session_evidence')
    }
  }

  if (evidence.schema_version !== 2) throw new Error('invalid_session_evidence')
  if (!RUN_ID_REGEX.test(evidence.run_id)) throw new Error('invalid_session_evidence')
  if (!HASH_REGEX.test(evidence.project_scope_id)) throw new Error('invalid_session_evidence')
  if (!HASH_REGEX.test(evidence.session_id_sha256)) throw new Error('invalid_session_evidence')
  if (typeof evidence.completed_turns !== 'number' || !Number.isInteger(evidence.completed_turns) || evidence.completed_turns < 0) {
    throw new Error('invalid_session_evidence')
  }

  if (!Array.isArray(evidence.tool_executions)) throw new Error('invalid_session_evidence')

  const seenCallHashes = new Set()
  for (let i = 0; i < evidence.tool_executions.length; i++) {
    const exec = evidence.tool_executions[i]
    validateToolExecution(exec, i)
    if (seenCallHashes.has(exec.call_id_sha256)) throw new Error('duplicate_call_id')
    seenCallHashes.add(exec.call_id_sha256)
  }

  const computed = computeSessionEvidenceSha256(evidence)
  if (evidence.content_sha256 !== computed) {
    throw new Error('invalid_evidence_hash')
  }

  return evidence
}

export function validateSearchOpenBinding(searchExec, openExec) {
  if (searchExec.tool_name !== 'mnemosyne_search') {
    throw new Error('invalid_search_execution')
  }
  if (openExec.tool_name !== 'mnemosyne_open') {
    throw new Error('invalid_open_execution')
  }

  const searchRes = searchExec.result_binding
  const openArg = openExec.argument_binding
  const openRes = openExec.result_binding

  if (openArg.retrieval_id !== searchRes.retrieval_id) {
    throw new Error('search_open_retrieval_id_mismatch')
  }

  if (openArg.search_disclosure_sha256 !== searchRes.search_disclosure_sha256) {
    throw new Error('search_open_disclosure_hash_mismatch')
  }

  const allowedMemoryIds = (searchRes.memory_refs || []).map((r) => r.memory_id)
  if (!allowedMemoryIds.includes(openArg.memory_id)) {
    throw new Error('search_open_memory_id_not_found')
  }

  if (openRes.parent_disclosure_sha256 !== searchRes.search_disclosure_sha256) {
    throw new Error('search_open_parent_hash_mismatch')
  }
}

export async function writeStrictSessionEvidence(evidenceDir, evidence, options = {}) {
  const validated = validateStrictSessionEvidence(evidence)
  const sessionEventsDir = join(evidenceDir, 'session-events')
  await mkdir(sessionEventsDir, { recursive: true, mode: 0o700 })

  const filePath = join(sessionEventsDir, `${validated.run_id}.json`)
  const payload = JSON.stringify(validated, null, 2) + '\n'

  if (options.allowOverwrite || options.overwrite) {
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await writeFile(tempPath, payload, { mode: 0o600 })
    await rename(tempPath, filePath)
  } else {
    await writeFile(filePath, payload, { flag: 'wx', mode: 0o600 })
  }
}

export async function readStrictSessionEvidence(evidenceDir, runId) {
  const filePath = join(evidenceDir, 'session-events', `${runId}.json`)
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  return validateStrictSessionEvidence(data)
}

