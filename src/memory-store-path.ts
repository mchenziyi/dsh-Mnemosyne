import { constants } from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { MemoryStoreError } from './memory-store-error.js'

const MEMORY_ID_REGEX = /^mem_[a-z0-9][a-z0-9._-]{0,63}$/
const SCOPE_ID_REGEX = /^sha256_[0-9a-f]{64}$/

export function validateMemoryId(id: unknown): string {
  if (typeof id !== 'string' || !MEMORY_ID_REGEX.test(id) || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  return id
}

export function validateScopeId(id: unknown): string {
  if (typeof id !== 'string' || !SCOPE_ID_REGEX.test(id) || id.includes('\0')) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  return id
}

export async function validateProjectRoot(projectRoot: unknown): Promise<string> {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || projectRoot.includes('\0')) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }

  let normalized = normalize(projectRoot)
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1)
  }

  let real: string
  try {
    real = await realpath(normalized)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_store_path_unsafe', err)
  }

  if (real !== normalized) {
    throw new MemoryStoreError('memory_store_symlink_rejected')
  }

  let st
  try {
    st = await lstat(normalized)
  } catch (err: unknown) {
    throw new MemoryStoreError('memory_store_path_unsafe', err)
  }

  if (st.isSymbolicLink()) {
    throw new MemoryStoreError('memory_store_symlink_rejected')
  }
  if (!st.isDirectory()) {
    throw new MemoryStoreError('memory_store_path_unsafe')
  }

  return normalized
}

export interface StoreLayout {
  projectRoot: string
  storeRoot: string
  factsRoot: string
  shortTermRoot: string
  longTermRoot: string
  tmpRoot: string
}

export function getStoreLayout(projectRoot: string): StoreLayout {
  const storeRoot = join(projectRoot, '.dsh-mnemosyne')
  const factsRoot = join(storeRoot, 'facts')
  const shortTermRoot = join(factsRoot, 'short-term')
  const longTermRoot = join(factsRoot, 'long-term')
  const tmpRoot = join(storeRoot, 'tmp')

  return {
    projectRoot,
    storeRoot,
    factsRoot,
    shortTermRoot,
    longTermRoot,
    tmpRoot,
  }
}

export function getShortTermPath(projectRoot: string, sessionScopeId: string, memoryId: string): string {
  const validSessionId = validateScopeId(sessionScopeId)
  const validMemoryId = validateMemoryId(memoryId)
  return join(projectRoot, '.dsh-mnemosyne', 'facts', 'short-term', validSessionId, `${validMemoryId}.json`)
}

export function getLongTermPath(projectRoot: string, memoryId: string): string {
  const validMemoryId = validateMemoryId(memoryId)
  return join(projectRoot, '.dsh-mnemosyne', 'facts', 'long-term', `${validMemoryId}.json`)
}

export async function checkComponentPermissions(path: string, isFile = false): Promise<void> {
  let st
  try {
    st = await lstat(path)
  } catch (err: unknown) {
    const nodeErr = err as { code?: string }
    if (nodeErr.code === 'ENOENT') return
    throw new MemoryStoreError('memory_store_path_unsafe', err)
  }

  if (st.isSymbolicLink()) {
    throw new MemoryStoreError('memory_store_symlink_rejected')
  }

  const mode = st.mode & 0o777
  if ((st.mode & 0o077) !== 0) {
    throw new MemoryStoreError('memory_store_insecure_permissions')
  }

  if (isFile) {
    if (!st.isFile()) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if (mode !== 0o600) {
      throw new MemoryStoreError('memory_store_insecure_permissions')
    }
  } else {
    if (!st.isDirectory()) {
      throw new MemoryStoreError('memory_store_path_unsafe')
    }
    if (mode !== 0o700) {
      throw new MemoryStoreError('memory_store_insecure_permissions')
    }
  }
}

export async function checkPathHierarchy(projectRoot: string, targetPath: string): Promise<void> {
  const rel = relative(projectRoot, targetPath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new MemoryStoreError('memory_store_path_unsafe')
  }

  const segments = rel.split(sep).filter(Boolean)
  let current = projectRoot

  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i])
    const isTargetFile = i === segments.length - 1 && targetPath.endsWith('.json')
    await checkComponentPermissions(current, isTargetFile)
  }
}

export async function ensureDirectoryChain(projectRoot: string, targetDir: string): Promise<void> {
  const rel = relative(projectRoot, targetDir)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new MemoryStoreError('memory_store_path_unsafe')
  }

  const segments = rel.split(sep).filter(Boolean)
  let current = projectRoot

  for (const seg of segments) {
    current = join(current, seg)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (err: unknown) {
      const nodeErr = err as { code?: string }
      if (nodeErr.code !== 'EEXIST') {
        throw new MemoryStoreError('memory_store_io_failed', err)
      }
    }
    await checkComponentPermissions(current, false)
  }
}
