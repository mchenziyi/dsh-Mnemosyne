import { compareCodePoints } from '../protocol/canonical.js'
import { type CandidateRecord } from '../protocol/retrieval.js'
import { tokenize } from './normalize.js'
import { BM25_B, BM25_K1, type IndexedMemory, type MemoryIndex, FIELD_WEIGHTS } from './index.js'

export interface RankedCandidate extends CandidateRecord { entry: IndexedMemory }

function bm25(tf: number, length: number, averageLength: number, documentFrequency: number, documents: number): number {
  if (!tf || !documents) return 0
  const idf = Math.log(1 + (documents - documentFrequency + 0.5) / (documentFrequency + 0.5))
  return idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * length / Math.max(averageLength, 1))))
}

export function rank(index: MemoryIndex, normalizedQuery: string, componentHint: string | null, operationHint: string | null): RankedCandidate[] {
  const queryTokens = tokenize(normalizedQuery); const uniqueTerms = [...new Set(queryTokens)]
  return index.entries.map((entry) => {
    let score = 0; let matched = 0; let tokenCount = 0
    for (const field of Object.keys(FIELD_WEIGHTS) as (keyof typeof FIELD_WEIGHTS)[]) {
      const tokens = entry.fields[field]; tokenCount += tokens.length
      const averageLength = index.entries.reduce((sum, item) => sum + item.fields[field].length, 0) / Math.max(index.entries.length, 1)
      const fieldWeight = FIELD_WEIGHTS[field]
      for (const term of uniqueTerms) { const tf = tokens.filter((token) => token === term).length; if (tf) matched++; score += fieldWeight * bm25(tf, tokens.length, averageLength, index.entries.filter((item) => item.fields[field].includes(term)).length, index.entries.length) }
    }
    const aliasMatch = entry.memory.aliases.some((alias) => normalizedQuery.includes(alias.normalize('NFKC').toLowerCase()))
    const componentMatch = componentHint !== null && entry.memory.component === componentHint
    const operationMatch = operationHint !== null && entry.memory.operation === operationHint
    if (aliasMatch) score += 6
    if (componentHint !== null && entry.memory.component === componentHint) score += 3
    if (operationHint !== null && entry.memory.operation === operationHint) score += 3
    return { memory_id: entry.memory.memory_id, component_match: componentMatch, operation_match: operationMatch, alias_match: aliasMatch, token_count: tokenCount, matched_term_count: matched, score_fixed: Math.max(0, Math.floor(score * 1_000_000 + 0.5)), rank: 0, entry }
  }).sort((left, right) => right.score_fixed - left.score_fixed || compareCodePoints(left.memory_id, right.memory_id)).map((item, index) => ({ ...item, rank: index + 1 }))
}
