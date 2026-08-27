import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, computeSha256 } from './canary-protocol.js'

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/
const STRICT_ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const VALID_SIDECAR_RUN_IDS = new Set(['run_1', 'run_2', 'run_3', 'run_4', 'run_5', 'run_6'])
const VALID_RESUME_RUN_IDS = new Set(['run_2', 'run_3'])

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

export function createSidecarLoadedReceipt(params) {
  const {
    run_id,
    module_sha256,
    loaded_at = new Date().toISOString(),
  } = params || {}

  if (!VALID_SIDECAR_RUN_IDS.has(run_id)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (typeof module_sha256 !== 'string' || !HASH_REGEX.test(module_sha256)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (!isValidStrictIsoUtc(loaded_at)) {
    throw new Error('invalid_wiring_receipt')
  }

  const base = {
    schema_version: 1,
    receipt_type: 'sidecar_loaded',
    run_id,
    module_role: 'audit_sidecar',
    module_sha256,
    loaded_at,
  }

  const receipt_sha256 = computeSha256(canonicalJson(base))

  return {
    ...base,
    receipt_sha256,
  }
}

export function validateSidecarLoadedReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('invalid_wiring_receipt')
  }

  const expectedKeys = new Set([
    'schema_version',
    'receipt_type',
    'run_id',
    'module_role',
    'module_sha256',
    'loaded_at',
    'receipt_sha256',
  ])

  for (const k of Object.keys(receipt)) {
    if (!expectedKeys.has(k)) {
      throw new Error('invalid_wiring_receipt')
    }
  }

  if (receipt.schema_version !== 1) throw new Error('invalid_wiring_receipt')
  if (receipt.receipt_type !== 'sidecar_loaded') throw new Error('invalid_wiring_receipt')
  if (!VALID_SIDECAR_RUN_IDS.has(receipt.run_id)) throw new Error('invalid_wiring_receipt')
  if (receipt.module_role !== 'audit_sidecar') throw new Error('invalid_wiring_receipt')
  if (typeof receipt.module_sha256 !== 'string' || !HASH_REGEX.test(receipt.module_sha256)) throw new Error('invalid_wiring_receipt')
  if (!isValidStrictIsoUtc(receipt.loaded_at)) throw new Error('invalid_wiring_receipt')
  if (typeof receipt.receipt_sha256 !== 'string' || !HASH_REGEX.test(receipt.receipt_sha256)) throw new Error('invalid_wiring_receipt')

  const base = {
    schema_version: receipt.schema_version,
    receipt_type: receipt.receipt_type,
    run_id: receipt.run_id,
    module_role: receipt.module_role,
    module_sha256: receipt.module_sha256,
    loaded_at: receipt.loaded_at,
  }

  const computedHash = computeSha256(canonicalJson(base))
  if (receipt.receipt_sha256 !== computedHash) {
    throw new Error('invalid_wiring_receipt')
  }

  return receipt
}

export function createResumeCompletedReceipt(params) {
  const {
    run_id,
    module_sha256,
    resumed_session_id_sha256,
    run_1_session_id_sha256,
    same_session = true,
    completed_at = new Date().toISOString(),
  } = params || {}

  if (!VALID_RESUME_RUN_IDS.has(run_id)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (typeof module_sha256 !== 'string' || !HASH_REGEX.test(module_sha256)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (typeof resumed_session_id_sha256 !== 'string' || !HASH_REGEX.test(resumed_session_id_sha256)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (typeof run_1_session_id_sha256 !== 'string' || !HASH_REGEX.test(run_1_session_id_sha256)) {
    throw new Error('invalid_wiring_receipt')
  }
  if (same_session !== true) {
    throw new Error('invalid_wiring_receipt')
  }
  if (!isValidStrictIsoUtc(completed_at)) {
    throw new Error('invalid_wiring_receipt')
  }

  const base = {
    schema_version: 1,
    receipt_type: 'resume_completed',
    run_id,
    module_role: 'resume_driver',
    module_sha256,
    resumed_session_id_sha256,
    run_1_session_id_sha256,
    same_session: true,
    completed_at,
  }

  const receipt_sha256 = computeSha256(canonicalJson(base))

  return {
    ...base,
    receipt_sha256,
  }
}

export function validateResumeCompletedReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('invalid_wiring_receipt')
  }

  const expectedKeys = new Set([
    'schema_version',
    'receipt_type',
    'run_id',
    'module_role',
    'module_sha256',
    'resumed_session_id_sha256',
    'run_1_session_id_sha256',
    'same_session',
    'completed_at',
    'receipt_sha256',
  ])

  for (const k of Object.keys(receipt)) {
    if (!expectedKeys.has(k)) {
      throw new Error('invalid_wiring_receipt')
    }
  }

  if (receipt.schema_version !== 1) throw new Error('invalid_wiring_receipt')
  if (receipt.receipt_type !== 'resume_completed') throw new Error('invalid_wiring_receipt')
  if (!VALID_RESUME_RUN_IDS.has(receipt.run_id)) throw new Error('invalid_wiring_receipt')
  if (receipt.module_role !== 'resume_driver') throw new Error('invalid_wiring_receipt')
  if (typeof receipt.module_sha256 !== 'string' || !HASH_REGEX.test(receipt.module_sha256)) throw new Error('invalid_wiring_receipt')
  if (typeof receipt.resumed_session_id_sha256 !== 'string' || !HASH_REGEX.test(receipt.resumed_session_id_sha256)) throw new Error('invalid_wiring_receipt')
  if (typeof receipt.run_1_session_id_sha256 !== 'string' || !HASH_REGEX.test(receipt.run_1_session_id_sha256)) throw new Error('invalid_wiring_receipt')
  if (receipt.same_session !== true) throw new Error('invalid_wiring_receipt')
  if (!isValidStrictIsoUtc(receipt.completed_at)) throw new Error('invalid_wiring_receipt')
  if (typeof receipt.receipt_sha256 !== 'string' || !HASH_REGEX.test(receipt.receipt_sha256)) throw new Error('invalid_wiring_receipt')

  const base = {
    schema_version: receipt.schema_version,
    receipt_type: receipt.receipt_type,
    run_id: receipt.run_id,
    module_role: receipt.module_role,
    module_sha256: receipt.module_sha256,
    resumed_session_id_sha256: receipt.resumed_session_id_sha256,
    run_1_session_id_sha256: receipt.run_1_session_id_sha256,
    same_session: true,
    completed_at: receipt.completed_at,
  }

  const computedHash = computeSha256(canonicalJson(base))
  if (receipt.receipt_sha256 !== computedHash) {
    throw new Error('invalid_wiring_receipt')
  }

  return receipt
}

export async function writeSidecarLoadedReceipt(evidenceDir, receipt) {
  const validated = validateSidecarLoadedReceipt(receipt)
  const dir = join(evidenceDir, 'wiring')
  await mkdir(dir, { recursive: true })
  const target = join(dir, `sidecar-loaded-${validated.run_id}.json`)
  try {
    await writeFile(target, JSON.stringify(validated, null, 2), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    throw new Error('wiring_receipt_write_failed')
  }
}

export function writeSidecarLoadedReceiptSync(evidenceDir, receipt) {
  const validated = validateSidecarLoadedReceipt(receipt)
  const dir = join(evidenceDir, 'wiring')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `sidecar-loaded-${validated.run_id}.json`)
  try {
    writeFileSync(target, JSON.stringify(validated, null, 2), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    throw new Error('wiring_receipt_write_failed')
  }
}

export async function writeResumeCompletedReceipt(evidenceDir, receipt) {
  const validated = validateResumeCompletedReceipt(receipt)
  const dir = join(evidenceDir, 'wiring')
  await mkdir(dir, { recursive: true })
  const target = join(dir, `resume-completed-${validated.run_id}.json`)
  try {
    await writeFile(target, JSON.stringify(validated, null, 2), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    throw new Error('wiring_receipt_write_failed')
  }
}

export function writeResumeCompletedReceiptSync(evidenceDir, receipt) {
  const validated = validateResumeCompletedReceipt(receipt)
  const dir = join(evidenceDir, 'wiring')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `resume-completed-${validated.run_id}.json`)
  try {
    writeFileSync(target, JSON.stringify(validated, null, 2), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    throw new Error('wiring_receipt_write_failed')
  }
}

export async function readSidecarLoadedReceipt(evidenceDir, runId) {
  const target = join(evidenceDir, 'wiring', `sidecar-loaded-${runId}.json`)
  const content = await readFile(target, 'utf8')
  const parsed = JSON.parse(content)
  return validateSidecarLoadedReceipt(parsed)
}

export async function readResumeCompletedReceipt(evidenceDir, runId) {
  const target = join(evidenceDir, 'wiring', `resume-completed-${runId}.json`)
  const content = await readFile(target, 'utf8')
  const parsed = JSON.parse(content)
  return validateResumeCompletedReceipt(parsed)
}
