import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MemoryStoreError } from '../memory-store-error.js'
import { checkPathHierarchy, ensureDirectoryChain, validateMemoryId, validateProjectRoot, validateScopeId } from '../memory-store-path.js'
import { computeProjectScopeId } from '../runtime-scope.js'
import { compareCodePoints } from '../protocol/canonical.js'
import { canonicalizeOKFMemoryV2, validateOKFMemoryV2, type OKFMemoryV2 } from './okf-memory.js'
import { canonicalizeOKFCatalogV1, catalogId, validateOKFCatalogV1, type OKFCatalogV1 } from './okf-catalog.js'

export interface OKFMemoryV2StoreOptions {
  project_root: string
  project_scope_id: string
}

export interface OKFMemoryV2WriteResult {
  status: 'created' | 'noop'
  memory_id: string
  content_sha256: string
}

export interface OKFCatalogV1WriteResult {
  status: 'created' | 'noop'
  catalog_id: string
  content_sha256: string
}

export interface OKFMemoryV2Store {
  putMemory(memory: OKFMemoryV2): Promise<OKFMemoryV2WriteResult>
  getMemory(memoryId: string): Promise<OKFMemoryV2>
  listMemories(): Promise<OKFMemoryV2[]>
  putCatalog(catalog: OKFCatalogV1): Promise<OKFCatalogV1WriteResult>
  getCatalog(catalogId: string): Promise<OKFCatalogV1>
  listCatalogs(): Promise<OKFCatalogV1[]>
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_BYTES = 1024 * 1024
const CATALOG_ID = /^catalog_[0-9a-f]{64}$/

async function readObject<T>(root: string, path: string, validate: (raw: unknown) => T, canonicalize: (raw: unknown) => string): Promise<T> {
  await checkPathHierarchy(root, path, true)
  let stat
  try {
    stat = await lstat(path)
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') throw new MemoryStoreError('memory_store_not_found')
    throw new MemoryStoreError('memory_store_io_failed', error)
  }
  if (stat.isSymbolicLink()) throw new MemoryStoreError('memory_store_symlink_rejected')
  if (!stat.isFile()) throw new MemoryStoreError('memory_store_path_unsafe')
  if ((stat.mode & 0o777) !== 0o600) throw new MemoryStoreError('memory_store_insecure_permissions')
  if (stat.size > MAX_BYTES) throw new MemoryStoreError('memory_store_file_too_large')

  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const handleStat = await handle.stat()
    if (!handleStat.isFile() || handleStat.dev !== stat.dev || handleStat.ino !== stat.ino) throw new MemoryStoreError('memory_store_path_unsafe')
    const buffer = await handle.readFile()
    if (buffer.length !== handleStat.size || buffer.length > MAX_BYTES) throw new MemoryStoreError('memory_store_file_too_large')
    const text = decoder.decode(buffer)
    const result = validate(JSON.parse(text))
    if (text !== canonicalize(result)) throw new MemoryStoreError('memory_store_noncanonical')
    return structuredClone(result)
  } catch (error: unknown) {
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_store_decode_failed', error)
  } finally {
    await handle?.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeImmutable(
  root: string,
  target: string,
  canonical: string,
  expectedHash: string,
  readExisting: () => Promise<{ content_sha256: string }>,
): Promise<'created' | 'noop'> {
  try {
    const existing = await readExisting()
    if (existing.content_sha256 === expectedHash) return 'noop'
    throw new MemoryStoreError('memory_store_identity_conflict')
  } catch (error: unknown) {
    if (!(error instanceof MemoryStoreError) || error.code !== 'memory_store_not_found') throw error
  }

  const tempRoot = join(root, '.dsh-mnemosyne', 'v2', 'tmp')
  await ensureDirectoryChain(root, dirname(target))
  await ensureDirectoryChain(root, tempRoot)
  const temp = join(tempRoot, `tmp_${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await handle.writeFile(canonical, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temp, target)
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    if ((error as { code?: string }).code === 'EEXIST') {
      const winner = await readExisting()
      if (winner.content_sha256 === expectedHash) return 'noop'
      throw new MemoryStoreError('memory_store_identity_conflict')
    }
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_store_io_failed', error)
  }
  try {
    await syncDirectory(dirname(target))
    await unlink(temp)
    await syncDirectory(tempRoot)
    const result = await readExisting()
    if (result.content_sha256 !== expectedHash) throw new MemoryStoreError('memory_store_hash_mismatch')
    return 'created'
  } catch (error: unknown) {
    await unlink(temp).catch(() => undefined)
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_store_io_failed', error)
  }
}

async function listJson<T>(root: string, dir: string, read: (id: string) => Promise<T>, idFromName: (name: string) => string): Promise<T[]> {
  let entries
  try {
    await checkPathHierarchy(root, dir, false)
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error instanceof MemoryStoreError ? error : new MemoryStoreError('memory_store_io_failed', error)
  }
  const values: T[] = []
  for (const entry of entries.sort((a, b) => compareCodePoints(a.name, b.name))) {
    if (entry.isSymbolicLink()) throw new MemoryStoreError('memory_store_symlink_rejected')
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new MemoryStoreError('memory_store_decode_failed')
    values.push(await read(idFromName(entry.name)))
  }
  return values
}

export function openOKFMemoryV2Store(options: OKFMemoryV2StoreOptions): OKFMemoryV2Store {
  if (!options || typeof options !== 'object') throw new MemoryStoreError('memory_store_invalid_input')
  const scope = validateScopeId(options.project_scope_id)
  const configuredRoot = options.project_root

  const root = async (): Promise<string> => {
    const resolved = await validateProjectRoot(configuredRoot)
    if (computeProjectScopeId(resolved) !== scope) throw new MemoryStoreError('memory_store_scope_mismatch')
    return resolved
  }

  const readMemory = async (memoryId: string): Promise<OKFMemoryV2> => {
    const projectRoot = await root()
    const id = validateMemoryId(memoryId)
    const value = await readObject(projectRoot, join(projectRoot, '.dsh-mnemosyne', 'v2', 'memories', `${id}.json`), validateOKFMemoryV2, canonicalizeOKFMemoryV2)
    if (value.project_scope_id !== scope) throw new MemoryStoreError('memory_store_scope_mismatch')
    return value
  }

  const readCatalog = async (id: string): Promise<OKFCatalogV1> => {
    const projectRoot = await root()
    if (!CATALOG_ID.test(id)) throw new MemoryStoreError('memory_store_invalid_input')
    const value = await readObject(projectRoot, join(projectRoot, '.dsh-mnemosyne', 'v2', 'catalogs', `${id}.json`), validateOKFCatalogV1, canonicalizeOKFCatalogV1)
    if (value.project_scope_id !== scope || catalogId(value) !== id) throw new MemoryStoreError('memory_store_scope_mismatch')
    return value
  }

  return {
    async putMemory(raw: OKFMemoryV2): Promise<OKFMemoryV2WriteResult> {
      const projectRoot = await root()
      const value = validateOKFMemoryV2(raw)
      if (value.project_scope_id !== scope) throw new MemoryStoreError('memory_store_scope_mismatch')
      for (const ref of value.related_memory_refs) await readMemory(ref)
      const path = join(projectRoot, '.dsh-mnemosyne', 'v2', 'memories', `${value.memory_id}.json`)
      const status = await writeImmutable(projectRoot, path, canonicalizeOKFMemoryV2(value), value.content_sha256, () => readMemory(value.memory_id))
      return { status, memory_id: value.memory_id, content_sha256: value.content_sha256 }
    },
    getMemory: readMemory,
    async listMemories(): Promise<OKFMemoryV2[]> {
      const projectRoot = await root()
      return listJson(projectRoot, join(projectRoot, '.dsh-mnemosyne', 'v2', 'memories'), readMemory, (name) => validateMemoryId(name.slice(0, -5)))
    },
    async putCatalog(raw: OKFCatalogV1): Promise<OKFCatalogV1WriteResult> {
      const projectRoot = await root()
      const value = validateOKFCatalogV1(raw)
      if (value.project_scope_id !== scope) throw new MemoryStoreError('memory_store_scope_mismatch')
      for (const node of value.nodes) for (const memoryId of node.memory_refs) await readMemory(memoryId)
      const id = catalogId(value)
      const path = join(projectRoot, '.dsh-mnemosyne', 'v2', 'catalogs', `${id}.json`)
      const status = await writeImmutable(projectRoot, path, canonicalizeOKFCatalogV1(value), value.content_sha256, () => readCatalog(id))
      return { status, catalog_id: id, content_sha256: value.content_sha256 }
    },
    getCatalog: readCatalog,
    async listCatalogs(): Promise<OKFCatalogV1[]> {
      const projectRoot = await root()
      return listJson(projectRoot, join(projectRoot, '.dsh-mnemosyne', 'v2', 'catalogs'), readCatalog, (name) => name.slice(0, -5))
    },
  }
}
