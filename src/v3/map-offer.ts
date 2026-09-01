import { MemoryStoreError } from '../memory-store-error.js'
import { canonicalHash, compareCodePoints } from '../protocol/canonical.js'
import type { CompiledOKFGenerationV2 } from '../v2/okf-compiler.js'

export const MAP_OFFER_SCHEMA_VERSION = 1
export const MAP_OFFER_MAX_BYTES = 8192
export const MAP_OFFER_PAGE_SIZE = 32

export interface PinnedGenerationV3 {
  readonly generation_id: string
  readonly project_scope_id: string
  readonly catalog_id: string
  readonly files: ReadonlyMap<string, string>
}

export interface MapOfferEntryV3 {
  readonly ref: string
  readonly title: string
  readonly kind: 'node' | 'memory'
}

export interface MapOfferV3 {
  readonly schema_version: 1
  readonly generation_id: string
  readonly catalog_id: string
  readonly project_scope_id: string
  readonly node_id: string
  readonly entries: readonly MapOfferEntryV3[]
  readonly next_cursor: string | null
  readonly offer_sha256: string
}

type IndexFile = {
  node_id: string
  children: Array<{ ref: string; title: string }>
  memories: Array<{ ref: string; title: string }>
}

function fail(): never { throw new MemoryStoreError('memory_store_invalid_input') }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}

export function pinGenerationV3(generation: CompiledOKFGenerationV2): PinnedGenerationV3 {
  if (!generation || !generation.manifest || !(generation.files instanceof Map)) fail()
  const source = new Map<string, string>(generation.files)
  const files: ReadonlyMap<string, string> = {
    get: (key) => source.get(key),
    has: (key) => source.has(key),
    get size() { return source.size },
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback, thisArg) => source.forEach((value, key) => callback.call(thisArg, value, key, files)),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  }
  return freeze({
    generation_id: generation.generation_id,
    project_scope_id: generation.manifest.project_scope_id,
    catalog_id: generation.manifest.catalog_id,
    files,
  })
}

function readIndex(pin: PinnedGenerationV3, nodeId: string): IndexFile {
  const path = nodeId === 'node_root' ? 'indexes/root.json' : `indexes/nodes/${nodeId}.json`
  const raw = pin.files.get(path)
  if (!raw) fail()
  try {
    const parsed = JSON.parse(raw) as IndexFile
    if (parsed.node_id !== undefined && parsed.node_id !== nodeId) fail()
    if (!Array.isArray(parsed.children)) fail()
    if (nodeId === 'node_root') {
      if (parsed.memories !== undefined && !Array.isArray(parsed.memories)) fail()
      parsed.memories ??= []
    } else if (!Array.isArray(parsed.memories)) fail()
    return parsed
  } catch { return fail() }
}

export function createMapOfferV3(pin: PinnedGenerationV3, nodeId = 'node_root', cursor = 0): MapOfferV3 {
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail()
  const index = readIndex(pin, nodeId)
  const entries = [
    ...index.children.map((entry) => ({ ref: entry.ref, title: entry.title, kind: 'node' as const })),
    ...index.memories.map((entry) => ({ ref: entry.ref, title: entry.title, kind: 'memory' as const })),
  ].sort((a, b) => compareCodePoints(a.ref, b.ref))
  const page = entries.slice(cursor, cursor + MAP_OFFER_PAGE_SIZE)
  const next = cursor + page.length < entries.length ? String(cursor + page.length) : null
  const identity = { schema_version: 1 as const, generation_id: pin.generation_id, catalog_id: pin.catalog_id, project_scope_id: pin.project_scope_id, node_id: nodeId, entries: page, next_cursor: next }
  return freeze({ ...identity, offer_sha256: canonicalHash(identity) })
}
