import { constants } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalBytes, sha256 } from '../protocol/canonical.js'
import { checkPathHierarchy, ensureDirectoryChain, validateProjectRoot, validateScopeId } from '../memory-store-path.js'
import { acquireCompilerLock, syncDirectory } from '../generation-store.js'
import { MemoryStoreError } from '../memory-store-error.js'

export interface V2CurrentSnapshotV1 {
  token: string
  bytes: string | null
  generation_id: string | null
  manifest_sha256: string | null
}

function pointerPath(root: string): string { return join(root, '.dsh-mnemosyne', 'v2', 'CURRENT') }

export async function readV2CurrentSnapshotV1(options: { project_root: string; project_scope_id: string }): Promise<V2CurrentSnapshotV1> {
  const root = await validateProjectRoot(options.project_root)
  validateScopeId(options.project_scope_id)
  const path = pointerPath(root)
  try {
    await checkPathHierarchy(root, path, true)
    const bytes = await readFile(path, 'utf8')
    const value = JSON.parse(bytes) as Record<string, unknown>
    if (value.schema_version !== 1 || typeof value.generation_id !== 'string' || typeof value.manifest_sha256 !== 'string') throw new Error('invalid_current')
    return { token: sha256(bytes), bytes, generation_id: value.generation_id, manifest_sha256: value.manifest_sha256 }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return { token: sha256(''), bytes: null, generation_id: null, manifest_sha256: null }
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_compile_current_invalid', error)
  }
}

export async function switchV2CurrentV1(options: { project_root: string; project_scope_id: string; expected: V2CurrentSnapshotV1; generation_id: string; manifest_bytes: string }): Promise<void> {
  const actual = await readV2CurrentSnapshotV1(options)
  if (actual.token !== options.expected.token) throw new MemoryStoreError('memory_compile_busy')
  const root = await validateProjectRoot(options.project_root)
  const dir = dirname(pointerPath(root))
  await ensureDirectoryChain(root, dir)
  const path = pointerPath(root)
  const temp = join(dir, `.current_${randomUUID()}.tmp`)
  const bytes = canonicalBytes({ schema_version: 1 as const, generation_id: options.generation_id, manifest_sha256: sha256(options.manifest_bytes) })
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = undefined
    await rename(temp, path); await syncDirectory(dir)
  } finally { await handle?.close().catch(() => undefined); await unlink(temp).catch(() => undefined) }
}

export async function withV2CurrentTransaction<T>(options: { project_root: string; project_scope_id: string }, operation: () => Promise<T>): Promise<T> {
  const root = await validateProjectRoot(options.project_root)
  validateScopeId(options.project_scope_id)
  const release = await acquireCompilerLock(root)
  try { return await operation() }
  finally { await release() }
}
