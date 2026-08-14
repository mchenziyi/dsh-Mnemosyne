import { canonicalHash, compareCodePoints } from '../protocol/canonical.js'
import { type MemoryCatalog, type MemoryFixture } from '../protocol/evaluation.js'
import { normalizeQuery, tokenize } from './normalize.js'

export const FIELD_WEIGHTS: Readonly<Record<'title' | 'summary' | 'component' | 'operation' | 'tags' | 'aliases' | 'body', number>> = Object.freeze({ title: 4, summary: 3, component: 4, operation: 4, tags: 2, aliases: 5, body: 1 })
export const BM25_K1 = 1.2
export const BM25_B = 0.75

export type IndexedMemory = {
  memory: MemoryFixture
  fields: Record<keyof typeof FIELD_WEIGHTS, string[]>
}

export type MemoryIndex = {
  catalog: MemoryCatalog
  catalogSha256: string
  entries: IndexedMemory[]
}

export function buildIndex(catalog: MemoryCatalog): MemoryIndex {
  const active = catalog.memories.filter((memory) => memory.lifecycle === 'active')
  const entries = active.map((memory) => {
    const fieldText = { title: memory.title, summary: memory.summary, component: memory.component, operation: memory.operation, tags: memory.tags.join(' '), aliases: memory.aliases.join(' '), body: memory.body }
    const fields = Object.fromEntries(Object.entries(fieldText).map(([key, text]) => [key, tokenize(normalizeQuery(text))])) as IndexedMemory['fields']
    return { memory, fields }
  }).sort((left, right) => compareCodePoints(left.memory.memory_id, right.memory.memory_id))
  return { catalog, catalogSha256: canonicalHash(catalog), entries }
}
