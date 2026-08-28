import {
  assertExactKeys,
  assertHash,
  assertId,
  assertInteger,
  canonicalBytes,
  canonicalHash,
  compareCodePoints,
  sortedUnique,
  withoutHash,
} from '../protocol/canonical.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { MemoryStoreError } from '../memory-store-error.js'

export interface OKFCatalogNodeV1 {
  node_id: string
  title: string
  summary: string
  parent_node_id: string | null
  child_node_refs: string[]
  memory_refs: string[]
}

export interface OKFCatalogV1 {
  schema_version: 1
  project_scope_id: string
  root_node_id: string
  nodes: OKFCatalogNodeV1[]
  updated_at: string
  content_sha256: string
}

const CATALOG_KEYS = ['schema_version', 'project_scope_id', 'root_node_id', 'nodes', 'updated_at', 'content_sha256'] as const
const NODE_KEYS = ['node_id', 'title', 'summary', 'parent_node_id', 'child_node_refs', 'memory_refs'] as const

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new MemoryStoreError('memory_store_invalid_input')
  }
  return value
}

function normalizeNode(raw: unknown): OKFCatalogNodeV1 {
  assertExactKeys(raw, NODE_KEYS)
  assertId(raw.node_id, 'node_')
  if (raw.parent_node_id !== null) assertId(raw.parent_node_id, 'node_')
  if (!Array.isArray(raw.child_node_refs) || raw.child_node_refs.length > 64) throw new MemoryStoreError('memory_store_invalid_input')
  if (!Array.isArray(raw.memory_refs) || raw.memory_refs.length > 256) throw new MemoryStoreError('memory_store_invalid_input')
  for (const ref of raw.child_node_refs) assertId(ref, 'node_')
  for (const ref of raw.memory_refs) assertId(ref, 'mem_')
  return {
    node_id: raw.node_id as string,
    title: text(raw.title, 320),
    summary: text(raw.summary, 2000),
    parent_node_id: raw.parent_node_id as string | null,
    child_node_refs: sortedUnique(raw.child_node_refs as string[]),
    memory_refs: sortedUnique(raw.memory_refs as string[]),
  }
}

function validateTree(catalog: OKFCatalogV1): void {
  const byId = new Map(catalog.nodes.map((node) => [node.node_id, node]))
  if (byId.size !== catalog.nodes.length) throw new MemoryStoreError('memory_store_invalid_input')
  const root = byId.get(catalog.root_node_id)
  if (!root || root.parent_node_id !== null || root.memory_refs.length !== 0) throw new MemoryStoreError('memory_store_invalid_input')

  const memories = new Set<string>()
  for (const node of catalog.nodes) {
    if (node.node_id !== catalog.root_node_id && node.parent_node_id === null) throw new MemoryStoreError('memory_store_invalid_input')
    if (node.parent_node_id !== null) {
      const parent = byId.get(node.parent_node_id)
      if (!parent || !parent.child_node_refs.includes(node.node_id)) throw new MemoryStoreError('memory_store_invalid_input')
    }
    for (const childId of node.child_node_refs) {
      const child = byId.get(childId)
      if (!child || child.parent_node_id !== node.node_id) throw new MemoryStoreError('memory_store_invalid_input')
    }
    for (const memoryId of node.memory_refs) {
      if (memories.has(memoryId)) throw new MemoryStoreError('memory_store_invalid_input')
      memories.add(memoryId)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new MemoryStoreError('memory_store_invalid_input')
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const childId of byId.get(nodeId)!.child_node_refs) visit(childId)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  visit(catalog.root_node_id)
  if (visited.size !== catalog.nodes.length) throw new MemoryStoreError('memory_store_invalid_input')
}

function normalize(raw: unknown, requireHash: boolean): OKFCatalogV1 {
  try {
    assertExactKeys(raw, CATALOG_KEYS)
    assertInteger(raw.schema_version, 1, 1)
    assertHash(raw.project_scope_id)
    assertId(raw.root_node_id, 'node_')
    assertUtcTimestamp(raw.updated_at)
    if (requireHash) assertHash(raw.content_sha256)
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > 512) throw new MemoryStoreError('memory_store_invalid_input')
    const normalized: OKFCatalogV1 = {
      schema_version: 1,
      project_scope_id: raw.project_scope_id as string,
      root_node_id: raw.root_node_id as string,
      nodes: raw.nodes.map(normalizeNode).sort((a, b) => compareCodePoints(a.node_id, b.node_id)),
      updated_at: raw.updated_at as string,
      content_sha256: raw.content_sha256 as string,
    }
    validateTree(normalized)
    return normalized
  } catch (error: unknown) {
    if (error instanceof MemoryStoreError) throw error
    throw new MemoryStoreError('memory_store_invalid_input', error)
  }
}

export function computeOKFCatalogV1Hash(raw: OKFCatalogV1): string {
  const normalized = normalize(raw, false)
  return canonicalHash(withoutHash(normalized as unknown as Record<string, unknown>))
}

export function validateOKFCatalogV1(raw: unknown): OKFCatalogV1 {
  const normalized = normalize(raw, true)
  if (normalized.content_sha256 !== computeOKFCatalogV1Hash(normalized)) throw new MemoryStoreError('memory_store_hash_mismatch')
  return normalized
}

export function canonicalizeOKFCatalogV1(raw: unknown): string {
  return canonicalBytes(validateOKFCatalogV1(raw))
}

export function catalogId(catalog: OKFCatalogV1): string {
  return `catalog_${catalog.content_sha256.slice('sha256_'.length)}`
}
