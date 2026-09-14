import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalBytes, sha256 } from '../protocol/canonical.js'
import { checkPathHierarchy, ensureDirectoryChain, validateProjectRoot, validateScopeId } from '../memory-store-path.js'
import { syncDirectory } from '../generation-store.js'
import { MemoryStoreError } from '../memory-store-error.js'
import { readVersionedGenerationManifestV1, type VersionedGenerationManifestV1 } from '../governance/generation.js'
import { openOKFMemoryV2Store } from './okf-memory-store.js'
import { openGovernanceLedgerStore, createMemoryCurrentBoundary } from '../governance/ledger-store.js'
import { replayGovernanceV1 } from '../governance/replay.js'
import { projectEffectiveWorldV1 } from '../governance/projection.js'
import type { CompiledOKFGenerationV2 } from './okf-compiler.js'
import { readCurrentOKFGenerationV2 } from './okf-compiler.js'
import { withV2CurrentTransaction, readV2CurrentSnapshotV1, switchV2CurrentV1, type V2CurrentSnapshotV1 } from './current-transaction.js'

export type CompiledVersionedGenerationV1 = { generation_id: string; manifest: VersionedGenerationManifestV1['manifest']; files: Map<string, string>; kind: VersionedGenerationManifestV1['kind']; governance_head: VersionedGenerationManifestV1['governance_head']; visible_memory_refs: VersionedGenerationManifestV1['visible_memory_refs'] }

function generationRoot(root: string, id: string): string { return join(root, '.dsh-mnemosyne', 'v2', 'generations', id) }

export async function publishImmutableVersionedGenerationV1(options: { project_root: string; project_scope_id: string; compiled: { generation_id: string; manifest: object; files: ReadonlyMap<string, string> }; expected?: V2CurrentSnapshotV1; before_current_switch?: () => void | Promise<void> }): Promise<void> {
  const root = await validateProjectRoot(options.project_root); validateScopeId(options.project_scope_id)
  const base = join(root, '.dsh-mnemosyne', 'v2'); const stage = join(base, 'tmp', `stage_${randomUUID()}`); const target = generationRoot(root, options.compiled.generation_id)
  await ensureDirectoryChain(root, join(base, 'tmp')); await ensureDirectoryChain(root, join(base, 'generations')); await mkdir(stage, { mode: 0o700 })
  try {
    for (const [name, content] of options.compiled.files) { const path = join(stage, name); const rel = relative(stage, path); if (rel.startsWith('..') || isAbsolute(rel)) throw new MemoryStoreError('memory_compile_path_unsafe'); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close() }
    await rename(stage, target)
    await syncDirectory(join(base, 'generations'))
  } catch (error: unknown) { await rm(stage, { recursive: true, force: true }).catch(() => undefined); if ((error as { code?: string }).code !== 'EEXIST') throw error }
  const manifestBytes = options.compiled.files.get('manifest.json'); if (!manifestBytes) throw new MemoryStoreError('memory_compile_invalid_input')
  const parsed = readVersionedGenerationManifestV1(JSON.parse(manifestBytes)); if (parsed.manifest.project_scope_id !== options.project_scope_id) throw new MemoryStoreError('memory_store_scope_mismatch')
  if (options.expected) {
    await options.before_current_switch?.()
    await switchV2CurrentV1({ project_root: root, project_scope_id: options.project_scope_id, expected: options.expected, generation_id: options.compiled.generation_id, manifest_bytes: manifestBytes })
  }
}

export async function readCurrentVersionedGenerationV1(options: { project_root: string; project_scope_id: string }): Promise<CompiledVersionedGenerationV1> {
  const root = await validateProjectRoot(options.project_root); const snapshot = await readV2CurrentSnapshotV1(options); if (!snapshot.generation_id || !snapshot.manifest_sha256) throw new MemoryStoreError('memory_compile_not_found')
  const dir = generationRoot(root, snapshot.generation_id); const manifestBytes = await readFile(join(dir, 'manifest.json'), 'utf8'); if (sha256(manifestBytes) !== snapshot.manifest_sha256) throw new MemoryStoreError('memory_compile_hash_mismatch')
  const parsed = readVersionedGenerationManifestV1(JSON.parse(manifestBytes)); if (parsed.manifest.project_scope_id !== options.project_scope_id) throw new MemoryStoreError('memory_store_scope_mismatch')
  const files = new Map<string, string>([['manifest.json', manifestBytes]])
  for (const output of parsed.manifest.output_refs) { const path = join(dir, output.path); await checkPathHierarchy(root, path, true); const content = await readFile(path, 'utf8'); if (sha256(content) !== output.content_sha256 || Buffer.byteLength(content, 'utf8') !== output.byte_length) throw new MemoryStoreError('memory_compile_hash_mismatch'); files.set(output.path, content) }
  if (parsed.kind === 'governed') {
    const manifest = parsed.manifest
    const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: options.project_scope_id })
    const catalog = await store.getCatalog(manifest.catalog_id)
    const memories = await Promise.all(manifest.memory_refs.map((ref) => store.getMemory(ref.memory_id)))
    const records = memories.map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256, project_scope_id: options.project_scope_id }))
    const ledger = openGovernanceLedgerStore({ project_root: root, project_scope_id: options.project_scope_id, current: createMemoryCurrentBoundary(options.project_scope_id, manifest.governance_head) })
    const events = await ledger.loadCommittedChain(manifest.governance_head)
    const replay = replayGovernanceV1({ project_scope_id: options.project_scope_id, memories: records, events })
    const projected = projectEffectiveWorldV1({ project_scope_id: options.project_scope_id, raw_catalog: catalog, raw_memories: memories, effective_memories: replay.effective_memories, governance_events: events, governance_head: manifest.governance_head })
    if (projected.effective_catalog_id !== manifest.effective_catalog_id || projected.effective_catalog_sha256 !== manifest.effective_catalog_sha256 || projected.effective_state_sha256 !== manifest.effective_state_sha256 || JSON.stringify(projected.visible_memory_refs) !== JSON.stringify(manifest.visible_memory_refs)) throw new MemoryStoreError('memory_compile_hash_mismatch')
    const visible = new Set(manifest.visible_memory_refs.map((ref) => ref.memory_id))
    const indexed = new Set<string>()
    for (const [path, content] of files) if (path.startsWith('indexes/nodes/') && path.endsWith('.json')) { const node = JSON.parse(content) as { memories?: Array<{ ref?: unknown }> }; for (const item of node.memories ?? []) if (typeof item.ref !== 'string' || !visible.has(item.ref)) throw new MemoryStoreError('memory_compile_hash_mismatch'); else indexed.add(item.ref) }
    if (indexed.size !== visible.size || [...visible].some((id) => !indexed.has(id))) throw new MemoryStoreError('memory_compile_hash_mismatch')
  }
  return { generation_id: parsed.manifest.generation_id, manifest: parsed.manifest, files, kind: parsed.kind, governance_head: parsed.governance_head, visible_memory_refs: parsed.visible_memory_refs }
}

export async function readCurrentRecallWorldV1(options: { project_root: string; project_scope_id: string }): Promise<CompiledOKFGenerationV2 | CompiledVersionedGenerationV1> {
  const snapshot = await readV2CurrentSnapshotV1(options)
  if (!snapshot.generation_id) return await readCurrentOKFGenerationV2(options)
  const root = await validateProjectRoot(options.project_root)
  const manifestBytes = await readFile(join(generationRoot(root, snapshot.generation_id), 'manifest.json'), 'utf8')
  let marker: { schema_version?: unknown; compiler_version?: unknown }
  try { marker = JSON.parse(manifestBytes) as typeof marker } catch { throw new MemoryStoreError('memory_compile_decode_failed') }
  if (marker.schema_version === 1 && marker.compiler_version === 'dsh-mnemosyne-okf-v2/1') return await readCurrentOKFGenerationV2(options)
  if (marker.schema_version === 2 && marker.compiler_version === 'dsh-mnemosyne-okf-governance-v1/1') return await readCurrentVersionedGenerationV1(options)
  throw new MemoryStoreError('memory_compile_current_invalid')
}

export { withV2CurrentTransaction }
