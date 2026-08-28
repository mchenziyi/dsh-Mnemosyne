import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { MemoryStoreError } from '../memory-store-error.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { canonicalBytes, canonicalHash, compareCodePoints, sha256 } from '../protocol/canonical.js'
import { checkPathHierarchy, ensureDirectoryChain, validateProjectRoot, validateScopeId } from '../memory-store-path.js'
import { computeProjectScopeId } from '../runtime-scope.js'
import { openOKFMemoryV2Store } from './okf-memory-store.js'
import { catalogId, validateOKFCatalogV1, type OKFCatalogV1 } from './okf-catalog.js'
import { compareOKFMemories, validateOKFMemoryV2, type OKFMemoryV2 } from './okf-memory.js'

export const OKF_V2_COMPILER_VERSION = 'dsh-mnemosyne-okf-v2/1'

export interface OKFGenerationV2OutputRef {
  path: string
  content_sha256: string
  byte_length: number
}

export interface OKFGenerationV2Manifest {
  schema_version: 1
  generation_id: string
  project_scope_id: string
  compiler_version: string
  catalog_id: string
  catalog_sha256: string
  memory_refs: Array<{ memory_id: string; content_sha256: string }>
  output_refs: OKFGenerationV2OutputRef[]
  created_at: string
}

export interface CompileOKFGenerationV2Request {
  catalog: OKFCatalogV1
  memories: OKFMemoryV2[]
  created_at: string
}

export interface CompiledOKFGenerationV2 {
  generation_id: string
  manifest: OKFGenerationV2Manifest
  files: Map<string, string>
}

export interface PublishOKFGenerationV2Request {
  project_root: string
  project_scope_id: string
  catalog_id: string
  created_at: string
}

export interface ReadOKFGenerationV2Request {
  project_root: string
  project_scope_id: string
}

function json(value: unknown): string {
  return canonicalBytes(value)
}

function titleEntry(ref: string, title: string): { ref: string; title: string } {
  return { ref, title }
}

function validateWorld(catalog: OKFCatalogV1, memories: OKFMemoryV2[]): Map<string, OKFMemoryV2> {
  const byId = new Map<string, OKFMemoryV2>()
  for (const raw of memories) {
    const memory = validateOKFMemoryV2(raw)
    if (memory.project_scope_id !== catalog.project_scope_id || byId.has(memory.memory_id)) {
      throw new MemoryStoreError('memory_compile_invalid_input')
    }
    byId.set(memory.memory_id, memory)
  }
  const catalogRefs = new Set<string>()
  for (const node of catalog.nodes) {
    for (const memoryId of node.memory_refs) {
      if (!byId.has(memoryId) || catalogRefs.has(memoryId)) throw new MemoryStoreError('memory_compile_invalid_input')
      catalogRefs.add(memoryId)
    }
  }
  if (catalogRefs.size !== byId.size) throw new MemoryStoreError('memory_compile_invalid_input')
  for (const memory of byId.values()) {
    for (const relatedId of memory.related_memory_refs) {
      if (!byId.has(relatedId)) throw new MemoryStoreError('memory_compile_invalid_input')
    }
  }
  return byId
}

export function compileOKFGenerationV2(request: CompileOKFGenerationV2Request): CompiledOKFGenerationV2 {
  assertUtcTimestamp(request.created_at)
  const catalog = validateOKFCatalogV1(request.catalog)
  const memoryById = validateWorld(catalog, request.memories)
  const nodeById = new Map(catalog.nodes.map((node) => [node.node_id, node]))
  const files = new Map<string, string>()
  const root = nodeById.get(catalog.root_node_id)!

  files.set('indexes/root.json', json({
    schema_version: 1,
    root_node_id: root.node_id,
    children: root.child_node_refs.map((id) => titleEntry(id, nodeById.get(id)!.title)),
  }))

  for (const node of catalog.nodes.sort((a, b) => compareCodePoints(a.node_id, b.node_id))) {
    files.set(`indexes/nodes/${node.node_id}.json`, json({
      schema_version: 1,
      node_id: node.node_id,
      title: node.title,
      summary: node.summary,
      children: node.child_node_refs.map((id) => titleEntry(id, nodeById.get(id)!.title)),
      memories: node.memory_refs.map((id) => titleEntry(id, memoryById.get(id)!.title)),
    }))
  }

  const memories = [...memoryById.values()].sort(compareOKFMemories)
  for (const memory of memories) {
    files.set(`summaries/${memory.memory_id}.json`, json({
      schema_version: 1,
      memory_id: memory.memory_id,
      title: memory.title,
      summary: memory.summary,
    }))
    const related = memory.related_memory_refs.map((id) => `- ${memoryById.get(id)!.title} (${id})`)
    files.set(
      `contents/${memory.memory_id}.md`,
      `# ${memory.title}\n\n${memory.content}\n\n## 相关记忆\n\n${related.length ? related.join('\n') : '- 无'}\n`,
    )
  }

  const outputRefs = [...files]
    .map(([path, content]) => ({ path, content_sha256: sha256(content), byte_length: Buffer.byteLength(content, 'utf8') }))
    .sort((a, b) => compareCodePoints(a.path, b.path))
  const identity: Omit<OKFGenerationV2Manifest, 'generation_id'> = {
    schema_version: 1,
    project_scope_id: catalog.project_scope_id,
    compiler_version: OKF_V2_COMPILER_VERSION,
    catalog_id: catalogId(catalog),
    catalog_sha256: catalog.content_sha256,
    memory_refs: memories.map((memory) => ({ memory_id: memory.memory_id, content_sha256: memory.content_sha256 })),
    output_refs: outputRefs,
    created_at: request.created_at,
  }
  const generationId = `gen_${canonicalHash(identity).slice('sha256_'.length)}`
  const manifest: OKFGenerationV2Manifest = { ...identity, generation_id: generationId }
  files.set('manifest.json', json(manifest))
  return { generation_id: generationId, manifest, files: new Map([...files].sort(([a], [b]) => compareCodePoints(a, b))) }
}

async function validRoot(projectRoot: string, scope: string): Promise<string> {
  const root = await validateProjectRoot(projectRoot)
  if (computeProjectScopeId(root) !== validateScopeId(scope)) throw new MemoryStoreError('memory_store_scope_mismatch')
  return root
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await import('node:fs/promises').then(({ open }) => open(path, constants.O_RDONLY))
  try { await handle.sync() } finally { await handle.close() }
}

async function writeStage(root: string, stage: string, files: Map<string, string>): Promise<void> {
  await mkdir(stage, { mode: 0o700 })
  for (const [relativePath, content] of files) {
    const path = join(stage, relativePath)
    const rel = relative(stage, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new MemoryStoreError('memory_compile_path_unsafe')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode: 0o600, flag: 'wx' })
  }
  await checkPathHierarchy(root, stage, false)
}

async function writeCurrent(root: string, generationId: string, manifestBytes: string): Promise<void> {
  const v2Root = join(root, '.dsh-mnemosyne', 'v2')
  const tempRoot = join(v2Root, 'tmp')
  const current = join(v2Root, 'CURRENT')
  const temp = join(tempRoot, `current_${randomUUID()}.tmp`)
  const bytes = json({ schema_version: 1, generation_id: generationId, manifest_sha256: sha256(manifestBytes) })
  await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
  await rename(temp, current)
  await syncDirectory(v2Root)
}

export async function publishOKFGenerationV2(request: PublishOKFGenerationV2Request): Promise<CompiledOKFGenerationV2> {
  const root = await validRoot(request.project_root, request.project_scope_id)
  const store = openOKFMemoryV2Store({ project_root: root, project_scope_id: request.project_scope_id })
  const catalog = await store.getCatalog(request.catalog_id)
  const memories = await store.listMemories()
  const compiled = compileOKFGenerationV2({ catalog, memories, created_at: request.created_at })
  const v2Root = join(root, '.dsh-mnemosyne', 'v2')
  const generationsRoot = join(v2Root, 'generations')
  const tempRoot = join(v2Root, 'tmp')
  await ensureDirectoryChain(root, generationsRoot)
  await ensureDirectoryChain(root, tempRoot)
  const stage = join(tempRoot, `stage_${randomUUID()}`)
  const target = join(generationsRoot, compiled.generation_id)
  try {
    await writeStage(root, stage, compiled.files)
    await rename(stage, target)
    await syncDirectory(generationsRoot)
  } catch (error: unknown) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    if ((error as { code?: string }).code !== 'EEXIST' && (error as { code?: string }).code !== 'ENOTEMPTY') {
      throw error instanceof MemoryStoreError ? error : new MemoryStoreError('memory_compile_io_failed', error)
    }
  }
  const manifestBytes = compiled.files.get('manifest.json')!
  await verifyGeneration(root, request.project_scope_id, compiled.generation_id, sha256(manifestBytes))
  await writeCurrent(root, compiled.generation_id, manifestBytes)
  return compiled
}

async function verifyGeneration(root: string, scope: string, generationId: string, expectedManifestHash: string): Promise<CompiledOKFGenerationV2> {
  if (!/^gen_[0-9a-f]{64}$/.test(generationId)) throw new MemoryStoreError('memory_compile_current_invalid')
  const generationRoot = join(root, '.dsh-mnemosyne', 'v2', 'generations', generationId)
  const manifestPath = join(generationRoot, 'manifest.json')
  await checkPathHierarchy(root, manifestPath, true)
  const manifestBytes = await readFile(manifestPath, 'utf8')
  if (sha256(manifestBytes) !== expectedManifestHash) throw new MemoryStoreError('memory_compile_hash_mismatch')
  let manifest: OKFGenerationV2Manifest
  try { manifest = JSON.parse(manifestBytes) as OKFGenerationV2Manifest } catch (error: unknown) { throw new MemoryStoreError('memory_compile_decode_failed', error) }
  if (manifest.generation_id !== generationId || manifest.project_scope_id !== scope || manifest.compiler_version !== OKF_V2_COMPILER_VERSION) {
    throw new MemoryStoreError('memory_compile_hash_mismatch')
  }
  const files = new Map<string, string>([['manifest.json', manifestBytes]])
  for (const output of manifest.output_refs) {
    const path = join(generationRoot, output.path)
    const rel = relative(generationRoot, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new MemoryStoreError('memory_compile_path_unsafe')
    await checkPathHierarchy(root, path, true)
    const content = await readFile(path, 'utf8')
    if (sha256(content) !== output.content_sha256 || Buffer.byteLength(content, 'utf8') !== output.byte_length) {
      throw new MemoryStoreError('memory_compile_hash_mismatch')
    }
    files.set(output.path, content)
  }
  return { generation_id: generationId, manifest, files }
}

export async function readCurrentOKFGenerationV2(request: ReadOKFGenerationV2Request): Promise<CompiledOKFGenerationV2> {
  const root = await validRoot(request.project_root, request.project_scope_id)
  const currentPath = join(root, '.dsh-mnemosyne', 'v2', 'CURRENT')
  try {
    await checkPathHierarchy(root, currentPath, true)
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as { schema_version: number; generation_id: string; manifest_sha256: string }
    if (current.schema_version !== 1 || typeof current.manifest_sha256 !== 'string') throw new MemoryStoreError('memory_compile_current_invalid')
    return verifyGeneration(root, request.project_scope_id, current.generation_id, current.manifest_sha256)
  } catch (error: unknown) {
    if (error instanceof MemoryStoreError) throw error
    if ((error as { code?: string }).code === 'ENOENT') throw new MemoryStoreError('memory_compile_not_found')
    throw new MemoryStoreError('memory_compile_current_invalid', error)
  }
}
