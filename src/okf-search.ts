import { canonicalBytes, canonicalHash, compareCodePoints, sha256 } from './protocol/canonical.js'
import type { OKFIndex, OKFIndexEntry } from './okf-schema.js'
import {
  canonicalizeSearchDisclosure,
  computeRetrievalId,
  computeSearchDisclosureId,
  validateSearchDisclosure,
  validateSearchInput,
  type OKFGenerationRef,
  type OKFSearchDisclosure,
  type OKFSearchDisclosureItem,
  type OKFSearchInput,
} from './protocol/okf-retrieval.js'

function isHan(char: string): boolean {
  return /^\p{Script=Han}$/u.test(char)
}

export function tokenizeText(value: string): string[] {
  const tokens: string[] = []
  const characters = Array.from(value.normalize('NFKC').toLowerCase())
  let index = 0
  while (index < characters.length) {
    if (isHan(characters[index])) {
      let end = index + 1
      while (end < characters.length && isHan(characters[end])) {
        end++
      }
      const segment = characters.slice(index, end)
      for (const char of segment) {
        tokens.push(char)
      }
      for (let width = 2; width <= 3; width++) {
        for (let offset = 0; offset + width <= segment.length; offset++) {
          tokens.push(segment.slice(offset, offset + width).join(''))
        }
      }
      index = end
      continue
    }
    const match = characters.slice(index).join('').match(/^[\p{L}\p{N}]+/u)
    if (match) {
      tokens.push(match[0])
      index += Array.from(match[0]).length
    } else {
      index++
    }
  }
  return tokens
}

export interface ExecuteOKFSearchParams {
  index: OKFIndex | null
  generationRef: OKFGenerationRef | null
  projectScopeId: string
  sessionScopeId: string
  searchParams: OKFSearchInput | { query: string; component_hint?: string | null; top_k?: number }
}

export function executeOKFSearch(params: ExecuteOKFSearchParams): OKFSearchDisclosure {
  const input = validateSearchInput(params.searchParams)
  const normalizedQuery = input.query.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  const queryFingerprint = sha256(normalizedQuery)

  if (!params.index || !params.generationRef) {
    const retrievalId = computeRetrievalId({
      project_scope_id: params.projectScopeId,
      session_scope_id: params.sessionScopeId,
      query_fingerprint: queryFingerprint,
      component_hint: input.component_hint,
      top_k: input.top_k,
      generation_ref: null,
    })
    const disclosureId = computeSearchDisclosureId({
      retrieval_id: retrievalId,
      project_scope_id: params.projectScopeId,
      session_scope_id: params.sessionScopeId,
      query_fingerprint: queryFingerprint,
      component_hint: input.component_hint,
      top_k: input.top_k,
      generation_ref: null,
      items: [],
    })
    const emptyPayload = {
      schema_version: 1 as const,
      disclosure_id: disclosureId,
      retrieval_id: retrievalId,
      project_scope_id: params.projectScopeId,
      session_scope_id: params.sessionScopeId,
      generation_ref: null,
      query_fingerprint: queryFingerprint,
      component_hint: input.component_hint,
      top_k: input.top_k,
      level: 2 as const,
      result_count: 0,
      items: Object.freeze([]),
      content_sha256: '',
    }
    const canonical = canonicalizeSearchDisclosure(emptyPayload)
    return validateSearchDisclosure(JSON.parse(canonical))
  }

  const queryTokens = tokenizeText(normalizedQuery)
  const uniqueQueryTerms = [...new Set(queryTokens)]

  interface ScoredCandidate {
    entry: OKFIndexEntry
    score_fixed: number
  }

  const candidates: ScoredCandidate[] = []

  for (const entry of params.index.entries) {
    if (entry.tier === 'short_term' && entry.session_scope_id !== params.sessionScopeId) {
      continue
    }

    const titleLower = entry.title.normalize('NFKC').toLowerCase()
    const summaryLower = entry.summary.normalize('NFKC').toLowerCase()
    const titleTokens = tokenizeText(entry.title)
    const componentTokens = entry.component ? tokenizeText(entry.component) : []
    const summaryTokens = tokenizeText(entry.summary)
    const tagTokens = entry.tags.flatMap((t) => tokenizeText(t))

    let entryScore = 0

    for (const term of uniqueQueryTerms) {
      let termScore = 0

      // Title match
      if (titleTokens.includes(term)) {
        termScore += 4000
      } else if (titleLower.includes(term)) {
        termScore += 800
      }

      // Component match
      if (componentTokens.includes(term)) {
        termScore += 4000
      }

      // Summary match
      if (summaryTokens.includes(term)) {
        termScore += 3000
      } else if (summaryLower.includes(term)) {
        termScore += 400
      }

      // Tag match
      if (tagTokens.includes(term)) {
        termScore += 2000
      }

      entryScore += termScore
    }

    if (input.component_hint !== null && entry.component === input.component_hint && entryScore > 0) {
      entryScore += 5000
    }

    if (entryScore > 0) {
      candidates.push({
        entry,
        score_fixed: entryScore,
      })
    }
  }

  // Sort by score_fixed descending, then memory_id code point ascending
  candidates.sort((left, right) => {
    const scoreDiff = right.score_fixed - left.score_fixed
    if (scoreDiff !== 0) {
      return scoreDiff
    }
    return compareCodePoints(left.entry.memory_id, right.entry.memory_id)
  })

  // Truncate to top_k
  const truncated = candidates.slice(0, input.top_k)

  const items: OKFSearchDisclosureItem[] = truncated.map((cand, idx) => {
    const memory_ref = cand.entry.tier === 'short_term'
      ? Object.freeze({
          tier: 'short_term' as const,
          session_scope_id: cand.entry.session_scope_id!,
          memory_id: cand.entry.memory_id,
          content_sha256: cand.entry.content_sha256,
          page_ref: cand.entry.page_ref,
        })
      : Object.freeze({
          tier: 'long_term' as const,
          session_scope_id: null,
          memory_id: cand.entry.memory_id,
          content_sha256: cand.entry.content_sha256,
          page_ref: cand.entry.page_ref,
        })

    return Object.freeze({
      memory_ref,
      title: cand.entry.title,
      summary: cand.entry.summary,
      component: cand.entry.component,
      tags: cand.entry.tags,
      score_fixed: cand.score_fixed,
      rank: idx + 1,
    })
  })

  const retrievalId = computeRetrievalId({
    project_scope_id: params.projectScopeId,
    session_scope_id: params.sessionScopeId,
    query_fingerprint: queryFingerprint,
    component_hint: input.component_hint,
    top_k: input.top_k,
    generation_ref: params.generationRef,
  })

  const disclosureId = computeSearchDisclosureId({
    retrieval_id: retrievalId,
    project_scope_id: params.projectScopeId,
    session_scope_id: params.sessionScopeId,
    query_fingerprint: queryFingerprint,
    component_hint: input.component_hint,
    top_k: input.top_k,
    generation_ref: params.generationRef,
    items,
  })

  const rawDisclosure: OKFSearchDisclosure = {
    schema_version: 1,
    disclosure_id: disclosureId,
    retrieval_id: retrievalId,
    project_scope_id: params.projectScopeId,
    session_scope_id: params.sessionScopeId,
    generation_ref: params.generationRef,
    query_fingerprint: queryFingerprint,
    component_hint: input.component_hint,
    top_k: input.top_k,
    level: 2,
    result_count: items.length,
    items: Object.freeze(items),
    content_sha256: '',
  }

  const canonical = canonicalizeSearchDisclosure(rawDisclosure)
  return validateSearchDisclosure(JSON.parse(canonical))
}
