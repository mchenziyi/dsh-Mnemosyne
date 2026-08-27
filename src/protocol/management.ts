import {
  assertExactKeys,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
} from './canonical.js'
import {
  assertUtcTimestamp,
  type ShortTermSourceRef,
} from '../memory-fact.js'
import { MemoryStoreError } from '../memory-store-error.js'
import { validateMemoryId, validateScopeId } from '../memory-store-path.js'

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/
const FORGET_ID_REGEX = /^forget_[0-9a-f]{64}$/
const PROMOTED_MEMORY_ID_REGEX = /^mem_promoted_[0-9a-f]{32}$/

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || 'get' in descriptor || 'set' in descriptor) return false
  }
  return true
}

function safeAssertExactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  try {
    assertExactKeys(value, keys)
  } catch {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
}

export interface MemoryForgetTargetRef {
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  memory_id: string
  content_sha256: string
}

export interface MemoryForgetFact {
  schema_version: 1
  fact_type: 'memory_forget'
  forget_id: string
  project_scope_id: string
  target: MemoryForgetTargetRef
  content_sha256: string
}

const FORGET_FACT_KEYS = [
  'schema_version',
  'fact_type',
  'forget_id',
  'project_scope_id',
  'target',
  'content_sha256',
] as const

const FORGET_TARGET_KEYS = [
  'tier',
  'session_scope_id',
  'memory_id',
  'content_sha256',
] as const

export function validateForgetTargetRef(target: unknown): MemoryForgetTargetRef {
  if (!isPlainObject(target)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  safeAssertExactKeys(target, FORGET_TARGET_KEYS)

  const { tier, session_scope_id, memory_id, content_sha256 } = target

  if (tier !== 'short_term' && tier !== 'long_term') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (tier === 'short_term') {
    if (typeof session_scope_id !== 'string') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    validateScopeId(session_scope_id)
  } else {
    if (session_scope_id !== null) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
  }

  if (typeof memory_id !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  validateMemoryId(memory_id)

  if (typeof content_sha256 !== 'string' || !HASH_REGEX.test(content_sha256)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  return {
    tier,
    session_scope_id,
    memory_id,
    content_sha256,
  }
}

export function computeForgetId(projectScopeId: string, target: MemoryForgetTargetRef): string {
  validateScopeId(projectScopeId)
  const validatedTarget = validateForgetTargetRef(target)
  const payload = {
    schema_version: 1,
    project_scope_id: projectScopeId,
    target: validatedTarget,
  }
  const hash = canonicalHash(payload)
  const hex64 = hash.slice(7) // remove 'sha256_'
  return `forget_${hex64}`
}

export function computeForgetContentSha256(
  factWithoutHash: Omit<MemoryForgetFact, 'content_sha256'>
): string {
  const canonicalPayload = {
    schema_version: 1,
    fact_type: 'memory_forget',
    forget_id: factWithoutHash.forget_id,
    project_scope_id: factWithoutHash.project_scope_id,
    target: factWithoutHash.target,
  }
  return canonicalHash(canonicalPayload)
}

export function createMemoryForgetFact(params: {
  project_scope_id: string
  target: MemoryForgetTargetRef
}): MemoryForgetFact {
  validateScopeId(params.project_scope_id)
  const validatedTarget = validateForgetTargetRef(params.target)
  const forgetId = computeForgetId(params.project_scope_id, validatedTarget)

  const preFact: Omit<MemoryForgetFact, 'content_sha256'> = {
    schema_version: 1,
    fact_type: 'memory_forget',
    forget_id: forgetId,
    project_scope_id: params.project_scope_id,
    target: validatedTarget,
  }

  const contentSha256 = computeForgetContentSha256(preFact)

  return {
    ...preFact,
    content_sha256: contentSha256,
  }
}

export function validateMemoryForgetFact(input: unknown): MemoryForgetFact {
  if (!isPlainObject(input)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  safeAssertExactKeys(input, FORGET_FACT_KEYS)

  if (input.schema_version !== 1) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  if (input.fact_type !== 'memory_forget') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.project_scope_id !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  validateScopeId(input.project_scope_id)

  const target = validateForgetTargetRef(input.target)

  if (typeof input.forget_id !== 'string' || !FORGET_ID_REGEX.test(input.forget_id)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const expectedForgetId = computeForgetId(input.project_scope_id, target)
  if (input.forget_id !== expectedForgetId) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.content_sha256 !== 'string' || !HASH_REGEX.test(input.content_sha256)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const preFact: Omit<MemoryForgetFact, 'content_sha256'> = {
    schema_version: 1,
    fact_type: 'memory_forget',
    forget_id: input.forget_id,
    project_scope_id: input.project_scope_id,
    target,
  }

  const expectedContentSha = computeForgetContentSha256(preFact)
  if (input.content_sha256 !== expectedContentSha) {
    throw new MemoryStoreError('memory_store_hash_mismatch')
  }

  return {
    schema_version: 1,
    fact_type: 'memory_forget',
    forget_id: input.forget_id,
    project_scope_id: input.project_scope_id,
    target,
    content_sha256: input.content_sha256,
  }
}

// ----------------------------------------------------
// Promotion Deterministic Helpers
// ----------------------------------------------------

export function computePromotedMemoryId(sourceRef: ShortTermSourceRef): string {
  const payload = {
    schema_version: 1,
    source_short_term_ref: sourceRef,
  }
  const hash = canonicalHash(payload)
  const first32Hex = hash.slice(7, 39) // first 32 hex chars
  return `mem_promoted_${first32Hex}`
}

// ----------------------------------------------------
// List Protocol Types & Helpers
// ----------------------------------------------------

export type MemoryFactState = 'active' | 'promoted' | 'expired' | 'forgotten'

export interface ListMemoriesParams {
  tier?: 'all' | 'short_term' | 'long_term'
  include_inactive?: boolean
  limit?: number
}

export interface ListMemoriesItem {
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  memory_id: string
  title: string
  summary: string
  tags: string[]
  created_at: string
  expires_at: string | null
  state: MemoryFactState
  content_sha256: string
}

export interface ListMemoriesOutput {
  schema_version: 1
  project_scope_id: string
  session_scope_id: string
  evaluation_at: string
  params: {
    tier: 'all' | 'short_term' | 'long_term'
    include_inactive: boolean
    limit: number
  }
  total_count: number
  truncated: boolean
  items: ListMemoriesItem[]
  content_sha256: string
}

export function validateListMemoriesParams(input: unknown): {
  tier: 'all' | 'short_term' | 'long_term'
  include_inactive: boolean
  limit: number
} {
  if (input === undefined || input === null) {
    return { tier: 'all', include_inactive: false, limit: 50 }
  }
  if (!isPlainObject(input)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  for (const key of Object.keys(input)) {
    if (key !== 'tier' && key !== 'include_inactive' && key !== 'limit') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
  }

  let tier: 'all' | 'short_term' | 'long_term' = 'all'
  if (input.tier !== undefined) {
    if (input.tier !== 'all' && input.tier !== 'short_term' && input.tier !== 'long_term') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    tier = input.tier
  }

  let include_inactive = false
  if (input.include_inactive !== undefined) {
    if (typeof input.include_inactive !== 'boolean') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    include_inactive = input.include_inactive
  }

  let limit = 50
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    limit = input.limit
  }

  return { tier, include_inactive, limit }
}

const LIST_OUTPUT_KEYS = [
  'schema_version',
  'project_scope_id',
  'session_scope_id',
  'evaluation_at',
  'params',
  'total_count',
  'truncated',
  'items',
  'content_sha256',
] as const

const LIST_ITEM_KEYS = [
  'tier',
  'session_scope_id',
  'memory_id',
  'title',
  'summary',
  'tags',
  'created_at',
  'expires_at',
  'state',
  'content_sha256',
] as const

export function validateListMemoriesItem(input: unknown): ListMemoriesItem {
  if (!isPlainObject(input)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  safeAssertExactKeys(input, LIST_ITEM_KEYS)

  if (input.tier !== 'short_term' && input.tier !== 'long_term') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (input.tier === 'short_term') {
    if (typeof input.session_scope_id !== 'string') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    validateScopeId(input.session_scope_id)
  } else {
    if (input.session_scope_id !== null) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
  }

  if (typeof input.memory_id !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  validateMemoryId(input.memory_id)

  if (typeof input.title !== 'string' || typeof input.summary !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (!Array.isArray(input.tags) || !input.tags.every((t) => typeof t === 'string')) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.created_at !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  assertUtcTimestamp(input.created_at)

  if (input.expires_at !== null) {
    if (typeof input.expires_at !== 'string') {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    assertUtcTimestamp(input.expires_at)
  }

  if (input.state !== 'active' && input.state !== 'promoted' && input.state !== 'expired' && input.state !== 'forgotten') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.content_sha256 !== 'string' || !HASH_REGEX.test(input.content_sha256)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  return {
    tier: input.tier,
    session_scope_id: input.session_scope_id,
    memory_id: input.memory_id,
    title: input.title,
    summary: input.summary,
    tags: [...input.tags],
    created_at: input.created_at,
    expires_at: input.expires_at,
    state: input.state,
    content_sha256: input.content_sha256,
  }
}

export function validateListMemoriesOutput(input: unknown): ListMemoriesOutput {
  if (!isPlainObject(input)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  safeAssertExactKeys(input, LIST_OUTPUT_KEYS)

  if (input.schema_version !== 1) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.project_scope_id !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  validateScopeId(input.project_scope_id)

  if (typeof input.session_scope_id !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  validateScopeId(input.session_scope_id)

  if (typeof input.evaluation_at !== 'string') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  assertUtcTimestamp(input.evaluation_at)

  const validatedParams = validateListMemoriesParams(input.params)

  if (typeof input.total_count !== 'number' || !Number.isInteger(input.total_count) || input.total_count < 0) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (typeof input.truncated !== 'boolean') {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  if (!Array.isArray(input.items)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  const items = input.items.map(validateListMemoriesItem)

  if (typeof input.content_sha256 !== 'string' || !HASH_REGEX.test(input.content_sha256)) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  return {
    schema_version: 1,
    project_scope_id: input.project_scope_id,
    session_scope_id: input.session_scope_id,
    evaluation_at: input.evaluation_at,
    params: validatedParams,
    total_count: input.total_count,
    truncated: input.truncated,
    items,
    content_sha256: input.content_sha256,
  }
}
