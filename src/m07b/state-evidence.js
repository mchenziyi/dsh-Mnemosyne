import { computeProjectScopeId, computeSha256, canonicalJson } from './canary-protocol.js'
import { openMemoryFactStore } from '../memory-store.js'
import { readCurrentPointer, verifyAndLoadGenerationWorld } from '../generation-store.js'

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/
const RUN_ID_REGEX = /^run_[1-6]$/

export function computeRunStateSnapshotSha256(snapshot) {
  const { snapshot_sha256, ...rest } = snapshot
  return computeSha256(canonicalJson(rest))
}

export function createRunStateSnapshot(params) {
  const {
    run_id,
    project_scope_id,
    session_id_sha256,
    short_term_refs = [],
    long_term_refs = [],
    forget_refs = [],
    current_ref = null,
    index_memory_refs = [],
  } = params

  const base = {
    run_id,
    project_scope_id,
    session_id_sha256,
    short_term_refs,
    long_term_refs,
    forget_refs,
    current_ref,
    index_memory_refs,
  }

  const snapshot_sha256 = computeRunStateSnapshotSha256(base)
  return {
    ...base,
    snapshot_sha256,
  }
}

export function validateRunStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('invalid_snapshot')
  }

  const expectedTopKeys = new Set([
    'run_id',
    'project_scope_id',
    'session_id_sha256',
    'short_term_refs',
    'long_term_refs',
    'forget_refs',
    'current_ref',
    'index_memory_refs',
    'snapshot_sha256',
  ])

  for (const k of Object.keys(snapshot)) {
    if (!expectedTopKeys.has(k)) {
      throw new Error('invalid_snapshot')
    }
  }

  if (!RUN_ID_REGEX.test(snapshot.run_id)) throw new Error('invalid_snapshot')
  if (!HASH_REGEX.test(snapshot.project_scope_id)) throw new Error('invalid_snapshot')
  if (!HASH_REGEX.test(snapshot.session_id_sha256)) throw new Error('invalid_snapshot')

  if (!Array.isArray(snapshot.short_term_refs)) throw new Error('invalid_snapshot')
  if (!Array.isArray(snapshot.long_term_refs)) throw new Error('invalid_snapshot')
  if (!Array.isArray(snapshot.forget_refs)) throw new Error('invalid_snapshot')
  if (!Array.isArray(snapshot.index_memory_refs)) throw new Error('invalid_snapshot')

  if (snapshot.current_ref !== null && (typeof snapshot.current_ref !== 'object' || Array.isArray(snapshot.current_ref))) {
    throw new Error('invalid_snapshot')
  }

  const computed = computeRunStateSnapshotSha256(snapshot)
  if (snapshot.snapshot_sha256 !== computed) {
    throw new Error('invalid_snapshot_hash')
  }

  return snapshot
}

export async function captureRunStateSnapshot(params) {
  const { runId, projectRoot, sessionId, sessionIdSha256 } = params

  const project_scope_id = computeProjectScopeId(projectRoot)
  const session_id_sha256 = sessionIdSha256 || (sessionId ? computeSha256(sessionId) : null)
  if (!session_id_sha256) {
    throw new Error('missing_session_id_sha256')
  }

  const store = openMemoryFactStore({ project_root: projectRoot, project_scope_id })
  const now = new Date().toISOString()

  const short_term_refs = []
  const sessionScopes = await store.listShortTermSessionScopes()
  for (const s of sessionScopes) {
    const facts = await store.listShortTerm(s, now, { includeExpired: true })
    for (const f of facts) {
      short_term_refs.push({
        tier: 'short_term',
        session_scope_id: f.session_scope_id,
        memory_id: f.memory_id,
        content_sha256: f.content_sha256,
        page_ref: `wiki/memories/${f.memory_id}.md`,
      })
    }
  }

  const long_term_refs = []
  const longFacts = await store.listLongTerm()
  for (const f of longFacts) {
    long_term_refs.push({
      tier: 'long_term',
      session_scope_id: null,
      memory_id: f.memory_id,
      content_sha256: f.content_sha256,
      page_ref: `wiki/memories/${f.memory_id}.md`,
    })
  }

  const forget_refs = []
  const forgetFacts = await store.listForget()
  for (const f of forgetFacts) {
    forget_refs.push({
      forget_id: f.forget_id,
      target_memory_id: f.target?.memory_id || f.target_memory_id || f.memory_id,
      target_tier: f.target?.tier || f.target_tier || 'long_term',
      generation_id: f.generation_id || null,
      content_sha256: f.content_sha256,
    })
  }

  let current_ref = null
  let index_memory_refs = []

  const current = await readCurrentPointer(projectRoot, project_scope_id)
  if (current) {
    const world = await verifyAndLoadGenerationWorld(projectRoot, current.generation_id, project_scope_id)
    if (world) {
      current_ref = {
        generation_id: world.generation.generation_id,
        generation_sha256: world.generation.generation_sha256,
        manifest_id: world.manifest.manifest_id,
        manifest_sha256: world.manifest.manifest_sha256,
        index_sha256: world.index.index_sha256,
      }

      index_memory_refs = (world.index?.entries || []).map((it) => ({
        tier: it.tier,
        session_scope_id: it.session_scope_id ?? null,
        memory_id: it.memory_id,
        content_sha256: it.content_sha256,
        page_ref: it.page_ref,
      }))
    }
  }

  return createRunStateSnapshot({
    run_id: runId,
    project_scope_id,
    session_id_sha256,
    short_term_refs,
    long_term_refs,
    forget_refs,
    current_ref,
    index_memory_refs,
  })
}

export function computeFactDiff(beforeSnapshot, afterSnapshot) {
  const beforeShortIds = new Set(beforeSnapshot.short_term_refs.map((r) => r.memory_id))
  const afterShortIds = new Set(afterSnapshot.short_term_refs.map((r) => r.memory_id))

  const added_short_term = afterSnapshot.short_term_refs.filter((r) => !beforeShortIds.has(r.memory_id))
  const removed_short_term = beforeSnapshot.short_term_refs.filter((r) => !afterShortIds.has(r.memory_id))

  const beforeLongIds = new Set(beforeSnapshot.long_term_refs.map((r) => r.memory_id))
  const afterLongIds = new Set(afterSnapshot.long_term_refs.map((r) => r.memory_id))

  const added_long_term = afterSnapshot.long_term_refs.filter((r) => !beforeLongIds.has(r.memory_id))
  const removed_long_term = beforeSnapshot.long_term_refs.filter((r) => !afterLongIds.has(r.memory_id))

  const beforeForgetIds = new Set(beforeSnapshot.forget_refs.map((r) => r.forget_id))
  const added_forget = afterSnapshot.forget_refs.filter((r) => !beforeForgetIds.has(r.forget_id))

  const current_changed = beforeSnapshot.current_ref?.generation_id !== afterSnapshot.current_ref?.generation_id

  return {
    added_short_term,
    removed_short_term,
    added_long_term,
    removed_long_term,
    added_forget,
    current_changed,
  }
}

export function computeLedgerSha256(ledger) {
  const { ledger_sha256, ...rest } = ledger
  return computeSha256(canonicalJson(rest))
}

export function createCanaryIdentityLedger(params) {
  const { project_scope_a, project_scope_b } = params

  const base = {
    schema_version: 1,
    project_scope_a,
    project_scope_b,
    session_a1_sha256: null,
    run_1_short_term_ref: null,
    run_2_retrieval_id: null,
    run_2_search_disclosure_sha256: null,
    run_2_open_body_sha256: null,
    run_3_promoted_long_term_ref: null,
    session_a3_sha256: null,
    run_5_forget_ref: null,
    run_6_project_b_isolated: false,
  }

  const ledger_sha256 = computeLedgerSha256(base)
  return {
    ...base,
    ledger_sha256,
  }
}

function hasExactKeys(value, keys) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isMemoryRef(value, expectedTier) {
  return hasExactKeys(value, ['tier', 'session_scope_id', 'memory_id', 'content_sha256', 'page_ref']) &&
    value.tier === expectedTier &&
    (expectedTier === 'short_term' ? HASH_REGEX.test(value.session_scope_id) : value.session_scope_id === null) &&
    typeof value.memory_id === 'string' && value.memory_id.length > 0 &&
    HASH_REGEX.test(value.content_sha256) &&
    typeof value.page_ref === 'string' && value.page_ref.length > 0
}

function isForgetRef(value) {
  const hasBaseKeys = hasExactKeys(value, ['forget_id', 'target_memory_id', 'target_tier', 'generation_id'])
  const hasContentHash = hasExactKeys(value, ['forget_id', 'target_memory_id', 'target_tier', 'generation_id', 'content_sha256']) &&
    HASH_REGEX.test(value.content_sha256)
  return (hasBaseKeys || hasContentHash) &&
    typeof value.forget_id === 'string' && value.forget_id.length > 0 &&
    typeof value.target_memory_id === 'string' && value.target_memory_id.length > 0 &&
    (value.target_tier === 'short_term' || value.target_tier === 'long_term') &&
    (value.generation_id === null || (typeof value.generation_id === 'string' && value.generation_id.length > 0))
}

export function advanceCanaryIdentityLedger(ledger, runId, update) {
  validateCanaryIdentityLedger(ledger)
  const next = { ...ledger }

  switch (runId) {
    case 'run_1': {
      if (!hasExactKeys(update, ['session_id_sha256', 'short_term_ref']) ||
          !HASH_REGEX.test(update.session_id_sha256) ||
          !isMemoryRef(update.short_term_ref, 'short_term')) {
        throw new Error('invalid_ledger_update')
      }
      next.session_a1_sha256 = update.session_id_sha256
      next.run_1_short_term_ref = update.short_term_ref
      break
    }
    case 'run_2': {
      if (!hasExactKeys(update, ['search_retrieval_id', 'search_disclosure_sha256', 'open_body_sha256']) ||
          typeof update.search_retrieval_id !== 'string' || update.search_retrieval_id.length === 0 ||
          !HASH_REGEX.test(update.search_disclosure_sha256) ||
          !HASH_REGEX.test(update.open_body_sha256)) {
        throw new Error('invalid_ledger_update')
      }
      next.run_2_retrieval_id = update.search_retrieval_id
      next.run_2_search_disclosure_sha256 = update.search_disclosure_sha256
      next.run_2_open_body_sha256 = update.open_body_sha256
      break
    }
    case 'run_3': {
      if (!hasExactKeys(update, ['promoted_long_term_ref']) || !isMemoryRef(update.promoted_long_term_ref, 'long_term')) {
        throw new Error('invalid_ledger_update')
      }
      next.run_3_promoted_long_term_ref = update.promoted_long_term_ref
      break
    }
    case 'run_4': {
      if (!hasExactKeys(update, ['session_a3_sha256']) || !HASH_REGEX.test(update.session_a3_sha256)) {
        throw new Error('invalid_ledger_update')
      }
      next.session_a3_sha256 = update.session_a3_sha256
      break
    }
    case 'run_5': {
      if (!hasExactKeys(update, ['forget_ref']) || !isForgetRef(update.forget_ref)) {
        throw new Error('invalid_ledger_update')
      }
      next.run_5_forget_ref = update.forget_ref
      break
    }
    case 'run_6': {
      if (!hasExactKeys(update, ['project_b_isolated']) || update.project_b_isolated !== true) {
        throw new Error('invalid_ledger_update')
      }
      next.run_6_project_b_isolated = true
      break
    }
    default:
      throw new Error('invalid_run_id_for_ledger')
  }

  const ledger_sha256 = computeLedgerSha256(next)
  return {
    ...next,
    ledger_sha256,
  }
}

export function validateCanaryIdentityLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('invalid_ledger')
  }

  const expectedTopKeys = new Set([
    'schema_version',
    'project_scope_a',
    'project_scope_b',
    'session_a1_sha256',
    'run_1_short_term_ref',
    'run_2_retrieval_id',
    'run_2_search_disclosure_sha256',
    'run_2_open_body_sha256',
    'run_3_promoted_long_term_ref',
    'session_a3_sha256',
    'run_5_forget_ref',
    'run_6_project_b_isolated',
    'ledger_sha256',
  ])

  for (const k of Object.keys(ledger)) {
    if (!expectedTopKeys.has(k)) {
      throw new Error('invalid_ledger')
    }
  }

  if (ledger.schema_version !== 1) throw new Error('invalid_ledger')
  if (!HASH_REGEX.test(ledger.project_scope_a)) throw new Error('invalid_ledger')
  if (!HASH_REGEX.test(ledger.project_scope_b)) throw new Error('invalid_ledger')

  const computed = computeLedgerSha256(ledger)
  if (ledger.ledger_sha256 !== computed) {
    throw new Error('invalid_ledger_hash')
  }

  return ledger
}

export async function inspectFactStoreState(projectRoot) {
  const project_scope_id = computeProjectScopeId(projectRoot)
  const store = openMemoryFactStore({ project_root: projectRoot, project_scope_id })

  const sessions = await store.listShortTermSessionScopes()
  const now = new Date().toISOString()
  const shortTerm = []
  for (const s of sessions) {
    const facts = await store.listShortTerm(s, now)
    shortTerm.push(...facts)
  }
  const longTerm = await store.listLongTerm()
  const forget = await store.listForget()

  return {
    project_scope_id,
    shortTerm,
    longTerm,
    forget,
  }
}

export async function inspectCurrentGeneration(projectRoot) {
  const project_scope_id = computeProjectScopeId(projectRoot)
  const current = await readCurrentPointer(projectRoot, project_scope_id)
  if (!current) {
    return null
  }

  const world = await verifyAndLoadGenerationWorld(projectRoot, current.generation_id, project_scope_id)
  return {
    current,
    world,
  }
}
