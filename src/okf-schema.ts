import {
  assertExactKeys,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
} from './protocol/canonical.js'
import { assertUtcTimestamp, type LongTermMemoryFact, type ShortTermMemoryFact } from './memory-fact.js'
import { MemoryStoreError } from './memory-store-error.js'
import { validateMemoryId, validateScopeId } from './memory-store-path.js'
import { deriveComponentSlug } from './okf-render.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || 'get' in descriptor || 'set' in descriptor) return false
  }
  return true
}
function safeAssertExactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  try {
    assertExactKeys(value, keys)
  } catch {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
}

export const COMPILER_VERSION = 'dsh-mnemosyne-okf/1' as const
export type CompilerVersion = typeof COMPILER_VERSION

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/
const GENERATION_ID_REGEX = /^gen_[0-9a-f]{64}$/
const MANIFEST_ID_REGEX = /^manifest_[0-9a-f]{64}$/
const COMPONENT_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,23}$/

export interface OKFInputFactRef {
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  memory_id: string
  content_sha256: string
}

export interface OKFOutputFileRef {
  relative_path: string
  byte_length: number
  content_sha256: string
}

export interface OKFInputManifest {
  schema_version: 1
  manifest_id: string
  generation_id: string
  project_scope_id: string
  compiler_version: CompilerVersion
  canonicalization_version: 1
  evaluation_at: string
  inputs: OKFInputFactRef[]
  outputs: OKFOutputFileRef[]
  compiled_output_sha256: string
  content_sha256: string
}

export interface OKFIndexEntry {
  memory_id: string
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  component: string | null
  title: string
  summary: string
  tags: string[]
  created_at: string
  expires_at: string | null
  content_sha256: string
  page_ref: string
}

export interface OKFIndex {
  schema_version: 1
  generation_id: string
  project_scope_id: string
  compiler_version: CompilerVersion
  evaluation_at: string
  entries: OKFIndexEntry[]
  content_sha256: string
}

export interface OKFGenerationMetadata {
  schema_version: 1
  generation_id: string
  manifest_id: string
  manifest_sha256: string
  project_scope_id: string
  compiler_version: CompilerVersion
  evaluation_at: string
  compiled_output_sha256: string
  status: 'complete'
  content_sha256: string
}

export interface OKFCurrentPointer {
  schema_version: 1
  generation_id: string
  generation_sha256: string
  manifest_id: string
  manifest_sha256: string
  project_scope_id: string
  content_sha256: string
}

export interface CompileOKFRequest {
  project_root: string
  project_scope_id: string
  evaluation_at: string
  compiler_version: CompilerVersion
}

export interface CompileOKFResult {
  status: 'created' | 'noop'
  generation_id: string
  manifest_id: string
  current: OKFCurrentPointer
}

export function validateHash(hash: unknown): string {
  if (typeof hash !== 'string' || !HASH_REGEX.test(hash)) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  return hash
}

export function validateGenerationId(id: unknown): string {
  if (typeof id !== 'string' || !GENERATION_ID_REGEX.test(id)) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  return id
}

export function validateManifestId(id: unknown): string {
  if (typeof id !== 'string' || !MANIFEST_ID_REGEX.test(id)) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  return id
}

export function validateRelativePath(p: unknown): string {
  if (typeof p !== 'string' || p.includes('\\') || p.includes('\0') || p.includes('..') || p.startsWith('/')) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  // Allowed whitelist patterns:
  // wiki/ROOT.md
  // wiki/short-term/<session-id>.md
  // wiki/components/<slug>.md
  // wiki/memories/<memory-id>.md
  // index.json
  if (p === 'wiki/ROOT.md' || p === 'index.json') {
    return p
  }

  if (p.startsWith('wiki/short-term/') && p.endsWith('.md')) {
    const scopeId = p.slice('wiki/short-term/'.length, -3)
    validateScopeId(scopeId)
    return p
  }

  if (p.startsWith('wiki/components/') && p.endsWith('.md')) {
    const slug = p.slice('wiki/components/'.length, -3)
    if (!COMPONENT_SLUG_REGEX.test(slug)) {
      throw new MemoryStoreError('memory_compile_invalid_input')
    }
    return p
  }

  if (p.startsWith('wiki/memories/') && p.endsWith('.md')) {
    const memId = p.slice('wiki/memories/'.length, -3)
    validateMemoryId(memId)
    return p
  }

  throw new MemoryStoreError('memory_compile_invalid_input')
}

export function validateInputFactRef(input: unknown): OKFInputFactRef {
  if (!isPlainObject(input)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(input, ['tier', 'session_scope_id', 'memory_id', 'content_sha256'])

  const tier = input.tier
  if (tier !== 'short_term' && tier !== 'long_term') {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const memoryId = validateMemoryId(input.memory_id)
  const contentSha256 = validateHash(input.content_sha256)

  let sessionScopeId: string | null = null
  if (tier === 'short_term') {
    if (typeof input.session_scope_id !== 'string') throw new MemoryStoreError('memory_compile_invalid_input')
    sessionScopeId = validateScopeId(input.session_scope_id)
  } else {
    if (input.session_scope_id !== null) throw new MemoryStoreError('memory_compile_invalid_input')
  }

  return {
    tier,
    session_scope_id: sessionScopeId,
    memory_id: memoryId,
    content_sha256: contentSha256,
  }
}

export function validateOutputFileRef(output: unknown): OKFOutputFileRef {
  if (!isPlainObject(output)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(output, ['relative_path', 'byte_length', 'content_sha256'])

  const relativePath = validateRelativePath(output.relative_path)
  if (typeof output.byte_length !== 'number' || !Number.isInteger(output.byte_length) || output.byte_length < 0) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  const contentSha256 = validateHash(output.content_sha256)

  return {
    relative_path: relativePath,
    byte_length: output.byte_length,
    content_sha256: contentSha256,
  }
}

export function compareInputFactRefs(a: OKFInputFactRef, b: OKFInputFactRef): number {
  if (a.tier !== b.tier) {
    return compareCodePoints(a.tier, b.tier)
  }
  const sA = a.session_scope_id ?? ''
  const sB = b.session_scope_id ?? ''
  if (sA !== sB) {
    return compareCodePoints(sA, sB)
  }
  if (a.memory_id !== b.memory_id) {
    return compareCodePoints(a.memory_id, b.memory_id)
  }
  return compareCodePoints(a.content_sha256, b.content_sha256)
}

export function compareOutputFileRefs(a: OKFOutputFileRef, b: OKFOutputFileRef): number {
  if (a.relative_path !== b.relative_path) {
    return compareCodePoints(a.relative_path, b.relative_path)
  }
  if (a.byte_length !== b.byte_length) {
    return a.byte_length - b.byte_length
  }
  return compareCodePoints(a.content_sha256, b.content_sha256)
}

export function computeInputSetHash(params: {
  project_scope_id: string
  compiler_version: CompilerVersion
  canonicalization_version: 1
  evaluation_at: string
  inputs: OKFInputFactRef[]
}): string {
  const sortedInputs = [...params.inputs].sort(compareInputFactRefs)
  return canonicalHash({
    project_scope_id: params.project_scope_id,
    compiler_version: params.compiler_version,
    canonicalization_version: params.canonicalization_version,
    evaluation_at: params.evaluation_at,
    inputs: sortedInputs,
  })
}

export function computeGenerationId(inputSetHash: string): string {
  return `gen_${inputSetHash.slice('sha256_'.length)}`
}

export function computeManifestId(generationId: string): string {
  return `manifest_${generationId.slice('gen_'.length)}`
}

export function computeCompiledOutputHash(outputs: OKFOutputFileRef[]): string {
  const sortedOutputs = [...outputs].sort(compareOutputFileRefs)
  return canonicalHash({
    outputs: sortedOutputs,
  })
}

export function canonicalizeManifest(manifest: OKFInputManifest): string {
  const validated = validateManifest(manifest)
  const canonicalPayload = {
    schema_version: 1,
    manifest_id: validated.manifest_id,
    generation_id: validated.generation_id,
    project_scope_id: validated.project_scope_id,
    compiler_version: validated.compiler_version,
    canonicalization_version: 1,
    evaluation_at: validated.evaluation_at,
    inputs: [...validated.inputs].sort(compareInputFactRefs),
    outputs: [...validated.outputs].sort(compareOutputFileRefs),
    compiled_output_sha256: validated.compiled_output_sha256,
    content_sha256: validated.content_sha256,
  }
  return canonicalBytes(canonicalPayload)
}

export function validateManifest(input: unknown): OKFInputManifest {
  if (!isPlainObject(input)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(input, [
    'schema_version',
    'manifest_id',
    'generation_id',
    'project_scope_id',
    'compiler_version',
    'canonicalization_version',
    'evaluation_at',
    'inputs',
    'outputs',
    'compiled_output_sha256',
    'content_sha256',
  ])

  if (input.schema_version !== 1 || input.canonicalization_version !== 1) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  if (input.compiler_version !== COMPILER_VERSION) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const manifestId = validateManifestId(input.manifest_id)
  const generationId = validateGenerationId(input.generation_id)
  const projectScopeId = validateScopeId(input.project_scope_id)
  assertUtcTimestamp(input.evaluation_at)

  if (!Array.isArray(input.inputs) || !Array.isArray(input.outputs)) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const inputs = input.inputs.map(validateInputFactRef)
  const outputs = input.outputs.map(validateOutputFileRef)

  // Verify inputs sort order and uniqueness
  for (let i = 0; i < inputs.length; i++) {
    if (i > 0) {
      const cmp = compareInputFactRefs(inputs[i - 1], inputs[i])
      if (cmp >= 0) {
        throw new MemoryStoreError('memory_compile_invalid_input')
      }
    }
  }

  // Verify outputs sort order and uniqueness
  for (let i = 0; i < outputs.length; i++) {
    if (i > 0) {
      const cmp = compareOutputFileRefs(outputs[i - 1], outputs[i])
      if (cmp >= 0) {
        throw new MemoryStoreError('memory_compile_invalid_input')
      }
    }
  }

  const compiledOutputHash = validateHash(input.compiled_output_sha256)
  const computedCompiledOutputHash = computeCompiledOutputHash(outputs)
  if (compiledOutputHash !== computedCompiledOutputHash) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  const expectedInputSetHash = computeInputSetHash({
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    canonicalization_version: 1,
    evaluation_at: input.evaluation_at,
    inputs,
  })
  const expectedGenId = computeGenerationId(expectedInputSetHash)
  if (generationId !== expectedGenId) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }
  const expectedManifestId = computeManifestId(expectedGenId)
  if (manifestId !== expectedManifestId) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }

  const payloadForHash = {
    schema_version: 1,
    manifest_id: manifestId,
    generation_id: generationId,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    canonicalization_version: 1,
    evaluation_at: input.evaluation_at,
    inputs,
    outputs,
    compiled_output_sha256: compiledOutputHash,
  }
  const expectedContentHash = canonicalHash(payloadForHash)

  if (typeof input.content_sha256 === 'string' && input.content_sha256.length > 0) {
    if (input.content_sha256 !== expectedContentHash) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  return {
    schema_version: 1,
    manifest_id: manifestId,
    generation_id: generationId,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    canonicalization_version: 1,
    evaluation_at: input.evaluation_at,
    inputs,
    outputs,
    compiled_output_sha256: compiledOutputHash,
    content_sha256: expectedContentHash,
  }
}

export function validateIndexEntry(entry: unknown): OKFIndexEntry {
  if (!isPlainObject(entry)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(entry, [
    'memory_id',
    'tier',
    'session_scope_id',
    'component',
    'title',
    'summary',
    'tags',
    'created_at',
    'expires_at',
    'content_sha256',
    'page_ref',
  ])

  const memoryId = validateMemoryId(entry.memory_id)
  const tier = entry.tier
  if (tier !== 'short_term' && tier !== 'long_term') throw new MemoryStoreError('memory_compile_invalid_input')

  let sessionScopeId: string | null = null
  if (tier === 'short_term') {
    if (typeof entry.session_scope_id !== 'string') throw new MemoryStoreError('memory_compile_invalid_input')
    sessionScopeId = validateScopeId(entry.session_scope_id)
  } else {
    if (entry.session_scope_id !== null) throw new MemoryStoreError('memory_compile_invalid_input')
  }

  let component: string | null = null
  if (entry.component !== null) {
    if (typeof entry.component !== 'string' || !COMPONENT_SLUG_REGEX.test(entry.component)) {
      throw new MemoryStoreError('memory_compile_invalid_input')
    }
    component = entry.component
  }

  if (typeof entry.title !== 'string' || typeof entry.summary !== 'string') {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  if (!Array.isArray(entry.tags) || !entry.tags.every((t) => typeof t === 'string')) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  assertUtcTimestamp(entry.created_at)
  if (entry.expires_at !== null) {
    assertUtcTimestamp(entry.expires_at)
  }

  const contentSha256 = validateHash(entry.content_sha256)
  const pageRef = validateRelativePath(entry.page_ref)

  return {
    memory_id: memoryId,
    tier,
    session_scope_id: sessionScopeId,
    component,
    title: entry.title,
    summary: entry.summary,
    tags: [...entry.tags],
    created_at: entry.created_at,
    expires_at: entry.expires_at,
    content_sha256: contentSha256,
    page_ref: pageRef,
  }
}

export function canonicalizeIndex(index: OKFIndex): string {
  const validated = validateIndex(index)
  const canonicalPayload = {
    schema_version: 1,
    generation_id: validated.generation_id,
    project_scope_id: validated.project_scope_id,
    compiler_version: validated.compiler_version,
    evaluation_at: validated.evaluation_at,
    entries: [...validated.entries].sort((a, b) => compareCodePoints(a.memory_id, b.memory_id)),
    content_sha256: validated.content_sha256,
  }
  return canonicalBytes(canonicalPayload)
}

export function validateIndex(input: unknown): OKFIndex {
  if (!isPlainObject(input)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(input, ['schema_version', 'generation_id', 'project_scope_id', 'compiler_version', 'evaluation_at', 'entries', 'content_sha256'])

  if (input.schema_version !== 1 || input.compiler_version !== COMPILER_VERSION) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const generationId = validateGenerationId(input.generation_id)
  const projectScopeId = validateScopeId(input.project_scope_id)
  assertUtcTimestamp(input.evaluation_at)

  if (!Array.isArray(input.entries)) throw new MemoryStoreError('memory_compile_invalid_input')
  const entries = input.entries.map(validateIndexEntry)

  // Verify memory_id sorting and uniqueness
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      const cmp = compareCodePoints(entries[i - 1].memory_id, entries[i].memory_id)
      if (cmp >= 0) {
        throw new MemoryStoreError('memory_compile_invalid_input')
      }
    }
  }

  const payloadForHash = {
    schema_version: 1,
    generation_id: generationId,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    evaluation_at: input.evaluation_at,
    entries,
  }
  const expectedContentHash = canonicalHash(payloadForHash)

  if (typeof input.content_sha256 === 'string' && input.content_sha256.length > 0) {
    if (input.content_sha256 !== expectedContentHash) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  return {
    schema_version: 1,
    generation_id: generationId,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    evaluation_at: input.evaluation_at,
    entries,
    content_sha256: expectedContentHash,
  }
}

export function canonicalizeGenerationMetadata(metadata: OKFGenerationMetadata): string {
  const validated = validateGenerationMetadata(metadata)
  const canonicalPayload = {
    schema_version: 1,
    generation_id: validated.generation_id,
    manifest_id: validated.manifest_id,
    manifest_sha256: validated.manifest_sha256,
    project_scope_id: validated.project_scope_id,
    compiler_version: validated.compiler_version,
    evaluation_at: validated.evaluation_at,
    compiled_output_sha256: validated.compiled_output_sha256,
    status: 'complete',
    content_sha256: validated.content_sha256,
  }
  return canonicalBytes(canonicalPayload)
}

export function validateGenerationMetadata(input: unknown): OKFGenerationMetadata {
  if (!isPlainObject(input)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(input, [
    'schema_version',
    'generation_id',
    'manifest_id',
    'manifest_sha256',
    'project_scope_id',
    'compiler_version',
    'evaluation_at',
    'compiled_output_sha256',
    'status',
    'content_sha256',
  ])

  if (input.schema_version !== 1 || input.compiler_version !== COMPILER_VERSION || input.status !== 'complete') {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const generationId = validateGenerationId(input.generation_id)
  const manifestId = validateManifestId(input.manifest_id)
  const manifestSha256 = validateHash(input.manifest_sha256)
  const projectScopeId = validateScopeId(input.project_scope_id)
  assertUtcTimestamp(input.evaluation_at)
  const compiledOutputHash = validateHash(input.compiled_output_sha256)

  const payloadForHash = {
    schema_version: 1,
    generation_id: generationId,
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    evaluation_at: input.evaluation_at,
    compiled_output_sha256: compiledOutputHash,
    status: 'complete',
  }
  const expectedContentHash = canonicalHash(payloadForHash)

  if (typeof input.content_sha256 === 'string' && input.content_sha256.length > 0) {
    if (input.content_sha256 !== expectedContentHash) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  return {
    schema_version: 1,
    generation_id: generationId,
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    project_scope_id: projectScopeId,
    compiler_version: COMPILER_VERSION,
    evaluation_at: input.evaluation_at,
    compiled_output_sha256: compiledOutputHash,
    status: 'complete',
    content_sha256: expectedContentHash,
  }
}

export function canonicalizeCurrentPointer(current: OKFCurrentPointer): string {
  const validated = validateCurrentPointer(current)
  const canonicalPayload = {
    schema_version: 1,
    generation_id: validated.generation_id,
    generation_sha256: validated.generation_sha256,
    manifest_id: validated.manifest_id,
    manifest_sha256: validated.manifest_sha256,
    project_scope_id: validated.project_scope_id,
    content_sha256: validated.content_sha256,
  }
  return canonicalBytes(canonicalPayload)
}

export function validateCurrentPointer(input: unknown): OKFCurrentPointer {
  if (!isPlainObject(input)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(input, [
    'schema_version',
    'generation_id',
    'generation_sha256',
    'manifest_id',
    'manifest_sha256',
    'project_scope_id',
    'content_sha256',
  ])

  if (input.schema_version !== 1) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  const generationId = validateGenerationId(input.generation_id)
  const generationSha256 = validateHash(input.generation_sha256)
  const manifestId = validateManifestId(input.manifest_id)
  const manifestSha256 = validateHash(input.manifest_sha256)
  const projectScopeId = validateScopeId(input.project_scope_id)

  const payloadForHash = {
    schema_version: 1,
    generation_id: generationId,
    generation_sha256: generationSha256,
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    project_scope_id: projectScopeId,
  }
  const expectedContentHash = canonicalHash(payloadForHash)

  if (typeof input.content_sha256 === 'string' && input.content_sha256.length > 0) {
    if (input.content_sha256 !== expectedContentHash) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
  }

  return {
    schema_version: 1,
    generation_id: generationId,
    generation_sha256: generationSha256,
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    project_scope_id: projectScopeId,
    content_sha256: expectedContentHash,
  }
}

export function validateCompileOKFRequest(request: unknown): CompileOKFRequest {
  if (!isPlainObject(request)) throw new MemoryStoreError('memory_compile_invalid_input')
  safeAssertExactKeys(request, ['project_root', 'project_scope_id', 'evaluation_at', 'compiler_version'])

  if (typeof request.project_root !== 'string' || !request.project_root.startsWith('/')) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }
  const projectScopeId = validateScopeId(request.project_scope_id)
  assertUtcTimestamp(request.evaluation_at)
  if (request.compiler_version !== COMPILER_VERSION) {
    throw new MemoryStoreError('memory_compile_invalid_input')
  }

  return {
    project_root: request.project_root,
    project_scope_id: projectScopeId,
    evaluation_at: request.evaluation_at,
    compiler_version: COMPILER_VERSION,
  }
}

export interface BuildExpectedIndexParams {
  generation_id: string
  project_scope_id: string
  compiler_version: CompilerVersion
  evaluation_at: string
  shortFacts: readonly ShortTermMemoryFact[]
  longFacts: readonly LongTermMemoryFact[]
}

export function buildExpectedIndex(params: BuildExpectedIndexParams): OKFIndex {
  const indexEntries: OKFIndexEntry[] = []

  for (const f of params.shortFacts) {
    indexEntries.push({
      memory_id: f.memory_id,
      tier: 'short_term',
      session_scope_id: f.session_scope_id,
      component: null,
      title: f.title,
      summary: f.summary,
      tags: [...f.tags],
      created_at: f.created_at,
      expires_at: f.expires_at,
      content_sha256: f.content_sha256,
      page_ref: `wiki/memories/${f.memory_id}.md`,
    })
  }

  for (const f of params.longFacts) {
    const slug = deriveComponentSlug(f.tags)
    indexEntries.push({
      memory_id: f.memory_id,
      tier: 'long_term',
      session_scope_id: null,
      component: slug,
      title: f.title,
      summary: f.summary,
      tags: [...f.tags],
      created_at: f.created_at,
      expires_at: null,
      content_sha256: f.content_sha256,
      page_ref: `wiki/memories/${f.memory_id}.md`,
    })
  }

  indexEntries.sort((a, b) => compareCodePoints(a.memory_id, b.memory_id))

  const indexObject: OKFIndex = {
    schema_version: 1,
    generation_id: params.generation_id,
    project_scope_id: params.project_scope_id,
    compiler_version: params.compiler_version,
    evaluation_at: params.evaluation_at,
    entries: indexEntries,
    content_sha256: '',
  }
  const indexCanonical = canonicalizeIndex(indexObject)
  indexObject.content_sha256 = validateIndex(JSON.parse(indexCanonical)).content_sha256
  return indexObject
}
