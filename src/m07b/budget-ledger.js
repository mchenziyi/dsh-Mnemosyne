import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_MODEL_REQUESTS = 18
export const MAX_HEADLESS_RUNS = 6
export const CONSECUTIVE_ERROR_THRESHOLD = 2

export const VALID_CANARY_RUN_IDS = new Set(['run_1', 'run_2', 'run_3', 'run_4', 'run_5', 'run_6'])
const STRICT_ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CLAIM_FILE_REGEX = /^(0[1-9]|1[0-8])\.json$/

export function isValidStrictIsoUtc(value) {
  if (typeof value !== 'string' || !STRICT_ISO_UTC_REGEX.test(value)) {
    return false
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }
  return parsed.toISOString() === value
}

export function validateLlmClaim(claim, expectedSeq = undefined, expectedRunId = undefined) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Object.prototype.toString.call(claim) !== '[object Object]') {
    throw new Error('invalid_llm_claim')
  }

  const expectedKeys = new Set(['schema_version', 'seq', 'run_id', 'claimed_at'])
  const actualKeys = Object.keys(claim)
  if (actualKeys.length !== 4) {
    throw new Error('invalid_llm_claim')
  }
  for (const k of actualKeys) {
    if (!expectedKeys.has(k)) {
      throw new Error('invalid_llm_claim')
    }
  }

  if (claim.schema_version !== 1) {
    throw new Error('invalid_llm_claim')
  }

  if (!Number.isInteger(claim.seq) || claim.seq < 1 || claim.seq > MAX_MODEL_REQUESTS) {
    throw new Error('invalid_llm_claim')
  }

  if (expectedSeq !== undefined && claim.seq !== expectedSeq) {
    throw new Error('invalid_llm_claim')
  }

  if (!VALID_CANARY_RUN_IDS.has(claim.run_id)) {
    throw new Error('invalid_llm_claim')
  }

  if (expectedRunId !== undefined && claim.run_id !== expectedRunId) {
    throw new Error('invalid_llm_claim')
  }

  if (!isValidStrictIsoUtc(claim.claimed_at)) {
    throw new Error('invalid_llm_claim')
  }

  return claim
}

export async function readValidLlmClaims(evidenceDir) {
  const claimsDir = join(evidenceDir, 'llm-claims')
  let files = []
  try {
    files = await readdir(claimsDir)
  } catch {
    return []
  }

  // Any non-empty directory with invalid filenames fails closed
  for (const f of files) {
    if (!CLAIM_FILE_REGEX.test(f)) {
      throw new Error('invalid_llm_claim')
    }
  }

  const sortedFiles = [...files].sort()
  const claims = []
  const seenSeqs = new Set()

  for (let i = 0; i < sortedFiles.length; i++) {
    const f = sortedFiles[i]
    const expectedSeq = Number.parseInt(f.slice(0, 2), 10)
    let rawContent
    try {
      rawContent = await readFile(join(claimsDir, f), 'utf8')
    } catch {
      throw new Error('invalid_llm_claim')
    }

    let parsed
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      throw new Error('invalid_llm_claim')
    }

    const validated = validateLlmClaim(parsed, expectedSeq)
    if (validated.seq !== i + 1) {
      throw new Error('invalid_llm_claim')
    }
    if (seenSeqs.has(validated.seq)) {
      throw new Error('invalid_llm_claim')
    }
    seenSeqs.add(validated.seq)
    claims.push(validated)
  }

  return claims
}

export async function claimLlmRequest(evidenceDir, runId) {
  if (!VALID_CANARY_RUN_IDS.has(runId)) {
    throw new Error('invalid_llm_claim')
  }

  const claimsDir = join(evidenceDir, 'llm-claims')
  const outcomesDir = join(evidenceDir, 'llm-outcomes')

  await mkdir(claimsDir, { recursive: true, mode: 0o700 })
  await mkdir(outcomesDir, { recursive: true, mode: 0o700 })

  // Check circuit breaker first
  const summary = await summarizeLlmBudget(evidenceDir)
  if (summary.circuit_broken) {
    throw new Error('circuit_breaker_tripped')
  }

  // Attempt atomic reservation for seq 1..12
  for (let seq = 1; seq <= MAX_MODEL_REQUESTS; seq++) {
    const fileName = `${String(seq).padStart(2, '0')}.json`
    const claimPath = join(claimsDir, fileName)
    const payload = JSON.stringify(
      {
        schema_version: 1,
        seq,
        run_id: runId,
        claimed_at: new Date().toISOString(),
      },
      null,
      2
    )

    try {
      await writeFile(claimPath, payload, { flag: 'wx', mode: 0o600 })
      return {
        seq,
        run_id: runId,
        claimPath,
      }
    } catch (err) {
      if (err && typeof err === 'object' && (err.code === 'EEXIST' || err.message?.includes('EEXIST'))) {
        continue
      }
      throw err
    }
  }

  throw new Error('budget_exhausted')
}

export async function recordLlmOutcome(evidenceDir, seq, status) {
  const outcomesDir = join(evidenceDir, 'llm-outcomes')
  await mkdir(outcomesDir, { recursive: true, mode: 0o700 })

  const validStatuses = ['completed', 'provider_error', 'protocol_error', 'aborted']
  if (!validStatuses.includes(status)) {
    throw new Error(`invalid_outcome_status_${status}`)
  }

  const fileName = `${String(seq).padStart(2, '0')}.json`
  const outcomePath = join(outcomesDir, fileName)
  const payload = JSON.stringify(
    {
      schema_version: 1,
      seq,
      status,
      recorded_at: new Date().toISOString(),
    },
    null,
    2
  )

  try {
    await writeFile(outcomePath, payload, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if (err && typeof err === 'object' && (err.code === 'EEXIST' || err.message?.includes('EEXIST'))) {
      throw new Error('outcome_already_recorded')
    }
    throw err
  }
}

export async function summarizeLlmBudget(evidenceDir) {
  const claims = await readValidLlmClaims(evidenceDir)
  const outcomesDir = join(evidenceDir, 'llm-outcomes')

  let outcomeFiles = []
  try {
    outcomeFiles = (await readdir(outcomesDir)).filter((f) => f.endsWith('.json')).sort()
  } catch {}

  const total_claimed = claims.length
  let completed_count = 0
  let provider_error_count = 0
  let protocol_error_count = 0
  let aborted_count = 0

  const outcomesBySeq = new Map()
  for (const f of outcomeFiles) {
    try {
      const data = JSON.parse(await readFile(join(outcomesDir, f), 'utf8'))
      outcomesBySeq.set(data.seq, data.status)
    } catch {}
  }

  // Iterate over all claimed sequences in order
  for (const claim of claims) {
    const status = outcomesBySeq.get(claim.seq)
    if (!status) {
      // Claimed but no outcome recorded (e.g. process crash/timeout)
      aborted_count++
    } else if (status === 'completed') {
      completed_count++
    } else if (status === 'provider_error') {
      provider_error_count++
    } else if (status === 'protocol_error') {
      protocol_error_count++
    } else if (status === 'aborted') {
      aborted_count++
    }
  }

  // Check for 2 consecutive errors in recorded outcomes
  let consecutiveErrors = 0
  let circuit_broken = false
  let circuit_broken_reason = null

  for (let s = 1; s <= total_claimed; s++) {
    const st = outcomesBySeq.get(s)
    if (st === 'provider_error' || st === 'protocol_error') {
      consecutiveErrors++
      if (consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
        circuit_broken = true
        circuit_broken_reason = 'consecutive_errors_threshold_exceeded'
        break
      }
    } else if (st === 'completed') {
      consecutiveErrors = 0
    }
  }

  return {
    total_claimed,
    completed_count,
    provider_error_count,
    protocol_error_count,
    aborted_count,
    circuit_broken,
    circuit_broken_reason,
  }
}
