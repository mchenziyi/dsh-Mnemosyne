import { assertExactKeys, assertHash, assertId, assertInteger, assertObject, assertSafeText, canonicalHash, compareCodePoints, ProtocolValidationError } from '../protocol/canonical.js'
import { validateCandidate, validateSkipDecision, type AcquisitionCandidate } from '../protocol/acquisition.js'
import { validateMemoryCatalog } from '../protocol/evaluation.js'
import { encodeDisclosure, replayDisclosure, validateCandidateUniverse, validateOpenDisclosure, validateRetrievalRequest, validateSearchDisclosure, type CandidateUniverse, type DisclosureEnvelope, type OpenDisclosure, type RetrievalRequest, type SearchDisclosure } from '../protocol/retrieval.js'
import { buildIndex, type MemoryIndex } from './index.js'
import { FIXTURE_CATALOG } from './fixture.js'
import { normalizeQuery } from './normalize.js'
import { rank } from './rank.js'

export interface SearchInput { query: string; component_hint?: string | null; operation_hint?: string | null; top_k?: number }
export interface OpenInput { retrieval_id: string; search_disclosure_sha256: string; memory_id: string }
export interface RegistryResult { status: 'created' | 'noop' | 'skipped'; candidate?: AcquisitionCandidate }
export interface RetrievalAudit { request: RetrievalRequest; candidateUniverse: CandidateUniverse }
export interface AcquisitionAudit { candidates: AcquisitionCandidate[]; overlaps: Record<string, string[]> }

const SEARCH_INPUT_KEYS = ['query', 'component_hint', 'operation_hint', 'top_k'] as const

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ProtocolValidationError()
}

function controlledHint(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new ProtocolValidationError()
  return value
}

export function validateSearchInput(value: unknown): SearchInput {
  assertObject(value); assertAllowedKeys(value, SEARCH_INPUT_KEYS)
  if (!Object.hasOwn(value, 'query')) throw new ProtocolValidationError()
  assertSafeText(value.query, 500)
  if (/[\u0000-\u001f\u007f]/u.test(value.query)) throw new ProtocolValidationError()
  const componentHint = controlledHint(value.component_hint); const operationHint = controlledHint(value.operation_hint)
  const topK = value.top_k === undefined ? 5 : value.top_k
  assertInteger(topK, 1, 5)
  return { query: value.query, component_hint: componentHint, operation_hint: operationHint, top_k: topK }
}

export function validateOpenInput(value: unknown): OpenInput {
  assertObject(value); assertExactKeys(value, ['retrieval_id', 'search_disclosure_sha256', 'memory_id'])
  assertId(value.retrieval_id, 'retrieval_'); assertHash(value.search_disclosure_sha256); assertId(value.memory_id, 'memory_')
  return { retrieval_id: value.retrieval_id, search_disclosure_sha256: value.search_disclosure_sha256, memory_id: value.memory_id }
}

function idFromHash(prefix: string, value: unknown): string { return `${prefix}${canonicalHash(value).slice(7, 23)}` }
function hashWithout(value: Record<string, unknown>, key: string): string { const copy = { ...value }; delete copy[key]; return canonicalHash(copy) }
function clone<T>(value: T): T { return structuredClone(value) }
function requestFor(index: MemoryIndex, query: string, componentHint: string | null, operationHint: string | null, topK: number): RetrievalRequest {
  const normalized = normalizeQuery(query); const queryFingerprint = canonicalHash({ query: normalized }); const identity = { query_fingerprint: queryFingerprint, component_hint: componentHint, operation_hint: operationHint, top_k: topK, catalog_sha256: index.catalogSha256 }
  const base = { schema_version: 1 as const, retrieval_id: idFromHash('retrieval_', identity), ...identity }
  return { ...base, content_sha256: hashWithout(base, 'content_sha256') }
}
function disclosureId(value: unknown): string { return idFromHash('disclosure_', value) }

export class RetrievalRuntime {
  readonly index: MemoryIndex
  private readonly searchRegistry = new Map<string, SearchDisclosure>()
  private readonly candidates = new Map<string, AcquisitionCandidate>()
  private readonly auditRegistry = new Map<string, RetrievalAudit>()
  private readonly eventRegistry = new Map<string, AcquisitionCandidate>()
  private readonly overlapRegistry = new Map<string, string[]>()

  constructor(catalog: unknown) { this.index = buildIndex(validateMemoryCatalog(catalog)) }

  search(input: SearchInput): SearchDisclosure {
    input = validateSearchInput(input)
    const componentHint = input.component_hint ?? null; const operationHint = input.operation_hint ?? null; const topK = input.top_k ?? 5
    const request = validateRetrievalRequest(requestFor(this.index, input.query, componentHint, operationHint, topK)); const ranked = rank(this.index, normalizeQuery(input.query), componentHint, operationHint)
    const candidates = ranked.map(({ entry: _entry, ...candidate }) => candidate); const universeBase = { schema_version: 1 as const, retrieval_id: request.retrieval_id, catalog_sha256: this.index.catalogSha256, candidates }; const universe: CandidateUniverse = validateCandidateUniverse({ ...universeBase, content_sha256: hashWithout(universeBase, 'content_sha256') })
    const items = ranked.filter((item) => item.score_fixed > 0).slice(0, topK).map((item, index) => ({ memory_id: item.memory_id, title: item.entry.memory.title, summary: item.entry.memory.summary, component: item.entry.memory.component, operation: item.entry.memory.operation, tags: [...item.entry.memory.tags].sort(compareCodePoints), aliases: [...item.entry.memory.aliases].sort(compareCodePoints), score_fixed: item.score_fixed, rank: index + 1 }))
    const disclosureBase = { schema_version: 1 as const, disclosure_id: disclosureId({ retrieval_ref: request.retrieval_id, candidate_universe_sha256: universe.content_sha256, level: 2, items }), retrieval_ref: request.retrieval_id, candidate_universe_sha256: universe.content_sha256, level: 2 as const, result_count: items.length, items }
    const disclosure: SearchDisclosure = validateSearchDisclosure({ ...disclosureBase, content_sha256: hashWithout(disclosureBase, 'content_sha256') })
    this.searchRegistry.set(disclosure.content_sha256, clone(disclosure)); this.auditRegistry.set(request.retrieval_id, { request: clone(request), candidateUniverse: clone(universe) })
    return disclosure
  }

  open(input: OpenInput): OpenDisclosure {
    input = validateOpenInput(input)
    const search = this.searchRegistry.get(input.search_disclosure_sha256); if (!search || search.retrieval_ref !== input.retrieval_id || !search.items.some((item) => item.memory_id === input.memory_id)) throw new ProtocolValidationError()
    const memory = this.index.entries.find((entry) => entry.memory.memory_id === input.memory_id)?.memory; if (!memory || memory.lifecycle !== 'active') throw new ProtocolValidationError()
    const disclosureBase = { schema_version: 1 as const, disclosure_id: disclosureId({ parent_disclosure_sha256: search.content_sha256, retrieval_ref: input.retrieval_id, memory_id: input.memory_id, level: 3 }), retrieval_ref: input.retrieval_id, parent_disclosure_sha256: search.content_sha256, level: 3 as const, memory_id: memory.memory_id, title: memory.title, summary: memory.summary, component: memory.component, operation: memory.operation, tags: [...memory.tags].sort(compareCodePoints), aliases: [...memory.aliases].sort(compareCodePoints), body: memory.body, lifecycle: 'active' as const, memory_content_sha256: memory.content_sha256 }
    return validateOpenDisclosure({ ...disclosureBase, content_sha256: hashWithout(disclosureBase, 'content_sha256') })
  }

  replay(bytes: string): DisclosureEnvelope { return replayDisclosure(bytes) }
  encode(disclosure: DisclosureEnvelope): string { return encodeDisclosure(disclosure) }
  auditFor(retrievalId: string): RetrievalAudit {
    const audit = this.auditRegistry.get(retrievalId)
    if (!audit) throw new ProtocolValidationError()
    return { request: clone(validateRetrievalRequest(audit.request)), candidateUniverse: clone(validateCandidateUniverse(audit.candidateUniverse)) }
  }

  acquisitionAudit(): AcquisitionAudit {
    const overlaps: Record<string, string[]> = Object.create(null)
    for (const [candidateId, basisIds] of [...this.overlapRegistry].sort(([left], [right]) => compareCodePoints(left, right))) overlaps[candidateId] = [...basisIds].sort(compareCodePoints)
    return { candidates: clone([...this.candidates.values()].sort((left, right) => compareCodePoints(left.candidate_id, right.candidate_id))), overlaps: clone(overlaps) }
  }

  clear(): void { this.searchRegistry.clear(); this.auditRegistry.clear(); this.candidates.clear(); this.eventRegistry.clear(); this.overlapRegistry.clear() }

  recordCandidate(candidate: unknown, skip: unknown): RegistryResult {
    const checkedCandidate = validateCandidate(candidate); const checkedSkip = validateSkipDecision(skip)
    if (checkedSkip.candidate_id !== checkedCandidate.candidate_id) throw new ProtocolValidationError()
    if (checkedSkip.decision === 'skip_exact_event' || checkedSkip.decision === 'skip_exact_content') return { status: 'skipped' }
    const previousEvent = this.eventRegistry.get(checkedCandidate.source_event_id)
    if (previousEvent) {
      if (previousEvent.candidate_id === checkedCandidate.candidate_id && previousEvent.content_sha256 === checkedCandidate.content_sha256) return { status: 'noop', candidate: clone(previousEvent) }
      throw new ProtocolValidationError()
    }
    const storedCandidate = clone(checkedCandidate)
    this.eventRegistry.set(storedCandidate.source_event_id, storedCandidate)
    this.candidates.set(storedCandidate.candidate_id, storedCandidate)
    if (checkedSkip.decision === 'duplicate_candidate') this.overlapRegistry.set(checkedCandidate.candidate_id, [...checkedSkip.basis_ids])
    return { status: 'created', candidate: clone(storedCandidate) }
  }
}

export function createFixtureRuntime(): RetrievalRuntime { return new RetrievalRuntime(FIXTURE_CATALOG) }
