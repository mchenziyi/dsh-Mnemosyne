import { assertExactKeys, assertHash, canonicalBytes, canonicalHash, compareCodePoints, ProtocolValidationError } from '../protocol/canonical.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { validateMemoryId, validateScopeId } from '../memory-store-path.js'
import { compareGovernanceMemoryRefsV1, validateGovernanceEventRefV1, type GovernanceHeadV1, type GovernanceMemoryRefV1 } from '../protocol/governance.js'

export const LEGACY_GENERATION_COMPILER_V1 = 'dsh-mnemosyne-okf-v2/1' as const
export const GOVERNED_GENERATION_COMPILER_V1 = 'dsh-mnemosyne-okf-governance-v1/1' as const
export interface LegacyGenerationManifestV1 { schema_version: 1; generation_id: string; project_scope_id: string; compiler_version: typeof LEGACY_GENERATION_COMPILER_V1; catalog_id: string; catalog_sha256: string; memory_refs: GovernanceMemoryRefV1[]; output_refs: Array<{ path: string; content_sha256: string; byte_length: number }>; created_at: string }
export interface GovernedGenerationManifestV1 extends Omit<LegacyGenerationManifestV1, 'schema_version' | 'compiler_version'> { schema_version: 2; compiler_version: typeof GOVERNED_GENERATION_COMPILER_V1; visible_memory_refs: GovernanceMemoryRefV1[]; governance_head: GovernanceHeadV1; effective_catalog_id: string; effective_catalog_sha256: string; effective_state_sha256: string }
export type VersionedGenerationManifestV1 = { kind: 'legacy'; manifest: LegacyGenerationManifestV1; governance_head: null; visible_memory_refs: GovernanceMemoryRefV1[] } | { kind: 'governed'; manifest: GovernedGenerationManifestV1; governance_head: GovernanceHeadV1; visible_memory_refs: GovernanceMemoryRefV1[] }

function invalid(message = 'generation_manifest_invalid'): never { throw new ProtocolValidationError(message) }
function hash(value: unknown): string { try { assertHash(value); return value } catch { return invalid() } }
function refs(value: unknown): GovernanceMemoryRefV1[] {
  if (!Array.isArray(value)) invalid()
  const output: GovernanceMemoryRefV1[] = []; const seen = new Set<string>(); let previous: GovernanceMemoryRefV1 | null = null
  for (const raw of value) { assertExactKeys(raw, ['memory_id', 'content_sha256']); const id = raw.memory_id as string; try { validateMemoryId(id) } catch { invalid() } const ref = { memory_id: id, content_sha256: hash(raw.content_sha256) }; const key = `${ref.memory_id}\0${ref.content_sha256}`; if (seen.has(key)) invalid('duplicate_memory_ref'); if (previous && compareGovernanceMemoryRefsV1(previous, ref) >= 0) invalid('noncanonical_memory_refs'); seen.add(key); output.push(ref); previous = ref }
  return output
}
function outputs(value: unknown): Array<{ path: string; content_sha256: string; byte_length: number }> {
  if (!Array.isArray(value)) invalid(); const result: Array<{ path: string; content_sha256: string; byte_length: number }> = []; let previous = ''
  for (const raw of value) { assertExactKeys(raw, ['path', 'content_sha256', 'byte_length']); if (typeof raw.path !== 'string' || raw.path.length === 0 || (previous && compareCodePoints(previous, raw.path as string) >= 0)) invalid('noncanonical_outputs'); if (!Number.isSafeInteger(raw.byte_length) || (raw.byte_length as number) < 0) invalid(); result.push({ path: raw.path as string, content_sha256: hash(raw.content_sha256), byte_length: raw.byte_length as number }); previous = raw.path as string }
  return result
}
function common(value: Record<string, unknown>, schema: 1 | 2): void {
  if (value.schema_version !== schema || typeof value.generation_id !== 'string' || !/^gen_[0-9a-f]{64}$/.test(value.generation_id)) invalid(); try { validateScopeId(value.project_scope_id) } catch { invalid() } if (typeof value.catalog_id !== 'string' || !/^catalog_[0-9a-f]{64}$/.test(value.catalog_id)) invalid(); hash(value.catalog_sha256); try { assertUtcTimestamp(value.created_at) } catch { invalid() }
}
export function validateLegacyGenerationManifestV1(value: unknown): LegacyGenerationManifestV1 {
  assertExactKeys(value, ['schema_version', 'generation_id', 'project_scope_id', 'compiler_version', 'catalog_id', 'catalog_sha256', 'memory_refs', 'output_refs', 'created_at'])
  const raw = value as Record<string, unknown>; common(raw, 1); if (raw.compiler_version !== LEGACY_GENERATION_COMPILER_V1) invalid()
  const manifest = { schema_version: 1 as const, generation_id: raw.generation_id as string, project_scope_id: raw.project_scope_id as string, compiler_version: LEGACY_GENERATION_COMPILER_V1, catalog_id: raw.catalog_id as string, catalog_sha256: raw.catalog_sha256 as string, memory_refs: refs(raw.memory_refs), output_refs: outputs(raw.output_refs), created_at: raw.created_at as string }
  const identity = { ...manifest }; delete (identity as Partial<LegacyGenerationManifestV1>).generation_id
  if (manifest.generation_id !== `gen_${canonicalHash(identity).slice(7)}`) invalid('generation_identity_mismatch')
  return manifest
}
function validateGoverned(value: unknown, checkIdentity: boolean): GovernedGenerationManifestV1 {
  assertExactKeys(value, ['schema_version', 'generation_id', 'project_scope_id', 'compiler_version', 'catalog_id', 'catalog_sha256', 'memory_refs', 'output_refs', 'created_at', 'visible_memory_refs', 'governance_head', 'effective_catalog_id', 'effective_catalog_sha256', 'effective_state_sha256'])
  const raw = value as Record<string, unknown>; common(raw, 2); if (raw.compiler_version !== GOVERNED_GENERATION_COMPILER_V1) invalid()
  const memoryRefs = refs(raw.memory_refs); const visible = refs(raw.visible_memory_refs); const rawSet = new Set(memoryRefs.map((ref) => `${ref.memory_id}\0${ref.content_sha256}`)); if (visible.some((ref) => !rawSet.has(`${ref.memory_id}\0${ref.content_sha256}`))) invalid('visible_memory_not_raw')
  if (typeof raw.effective_catalog_id !== 'string' || !/^ecatalog_[0-9a-f]{64}$/.test(raw.effective_catalog_id)) invalid(); const effectiveHash = hash(raw.effective_catalog_sha256); if (raw.effective_catalog_id !== `ecatalog_${effectiveHash.slice(7)}`) invalid(); const stateHash = hash(raw.effective_state_sha256)
  if (!raw.governance_head || typeof raw.governance_head !== 'object') invalid(); const head = raw.governance_head as Record<string, unknown>; if (!Number.isSafeInteger(head.sequence) || (head.sequence as number) < 1) invalid(); const ref = validateGovernanceEventRefV1({ event_id: head.event_id, event_sha256: head.event_sha256 })
  const manifest = { schema_version: 2 as const, generation_id: raw.generation_id as string, project_scope_id: raw.project_scope_id as string, compiler_version: GOVERNED_GENERATION_COMPILER_V1, catalog_id: raw.catalog_id as string, catalog_sha256: raw.catalog_sha256 as string, memory_refs: memoryRefs, output_refs: outputs(raw.output_refs), created_at: raw.created_at as string, visible_memory_refs: visible, governance_head: { sequence: head.sequence as number, ...ref }, effective_catalog_id: raw.effective_catalog_id as string, effective_catalog_sha256: effectiveHash, effective_state_sha256: stateHash }
  const identity = { ...manifest }; delete (identity as Partial<GovernedGenerationManifestV1>).generation_id; if (checkIdentity && manifest.generation_id !== `gen_${canonicalHash(identity).slice(7)}`) invalid('generation_identity_mismatch')
  return manifest
}
export function validateGovernedGenerationManifestV1(value: unknown): GovernedGenerationManifestV1 { return validateGoverned(value, true) }
export function readVersionedGenerationManifestV1(value: unknown): VersionedGenerationManifestV1 {
  if (typeof value !== 'object' || value === null || !('schema_version' in value) || !('compiler_version' in value)) invalid(); const raw = value as Record<string, unknown>; if (raw.schema_version === 1 && raw.compiler_version === LEGACY_GENERATION_COMPILER_V1) { const manifest = validateLegacyGenerationManifestV1(raw); return { kind: 'legacy', manifest, governance_head: null, visible_memory_refs: structuredClone(manifest.memory_refs) } } if (raw.schema_version === 2 && raw.compiler_version === GOVERNED_GENERATION_COMPILER_V1) { const manifest = validateGovernedGenerationManifestV1(raw); return { kind: 'governed', manifest, governance_head: manifest.governance_head, visible_memory_refs: structuredClone(manifest.visible_memory_refs) } } invalid('unknown_generation_version')
}
export function createGovernedGenerationManifestV1(input: Omit<GovernedGenerationManifestV1, 'generation_id'>): GovernedGenerationManifestV1 {
  const checked = validateGoverned({ ...input, generation_id: `gen_${'0'.repeat(64)}` }, false); const identity = { ...checked }; delete (identity as Partial<GovernedGenerationManifestV1>).generation_id; const generation_id = `gen_${canonicalHash(identity).slice(7)}`; return { ...checked, generation_id }
}
export function canonicalizeVersionedGenerationManifestV1(value: unknown): string { const parsed = readVersionedGenerationManifestV1(value); return canonicalBytes(parsed.manifest) }
