import { describe, expect, it } from 'vitest'
import retrievalCasesJson from '../fixtures/m0.5/v1/retrieval-cases.json' with { type: 'json' }
import { validateRetrievalCases } from '../src/protocol/evaluation.js'
import { createFixtureRuntime } from '../src/retrieval/runtime.js'

describe('M0.5B deterministic retrieval fixture', () => {
  it('runs every frozen Retrieval Case with its hints and checks expected/forbidden refs', () => {
    const fixture = validateRetrievalCases(retrievalCasesJson)
    expect(fixture.cases).toHaveLength(15)
    const runtime = createFixtureRuntime()
    for (const testCase of fixture.cases) {
      const result = runtime.search({ query: testCase.query, component_hint: testCase.component_hint, operation_hint: testCase.operation_hint, top_k: 5 })
      const ids = result.items.map((item) => item.memory_id)
      for (const expected of testCase.expected_memory_ids) expect(ids).toContain(expected)
      for (const forbidden of testCase.forbidden_memory_ids) expect(ids).not.toContain(forbidden)
      if (testCase.difficulty === 'negative_control') expect(result.items).toHaveLength(0)
    }
  })

  it('meets the frozen difficult-case Recall@5 and keeps active-only candidate results', () => {
    const fixture = validateRetrievalCases(retrievalCasesJson)
    const runtime = createFixtureRuntime()
    const difficult = fixture.cases.filter((testCase) => ['rephrase', 'alias', 'cross_component'].includes(testCase.difficulty))
    let recalled = 0
    for (const testCase of difficult) {
      const result = runtime.search({ query: testCase.query, component_hint: testCase.component_hint, operation_hint: testCase.operation_hint, top_k: 5 })
      const ids = new Set(result.items.map((item) => item.memory_id))
      if (testCase.expected_memory_ids.every((id) => ids.has(id))) recalled++
      expect([...ids]).not.toContain('memory_stale_scope')
      expect([...ids]).not.toContain('memory_unverified_hook')
    }
    expect(recalled / difficult.length).toBe(1)
  })

  it('keeps request, universe, ranking, and disclosure bytes stable', () => {
    const runtime = createFixtureRuntime()
    const first = runtime.search({ query: 'compiler settings changed, rebuild only what is needed', component_hint: 'compiler', operation_hint: 'build', top_k: 5 })
    const second = runtime.search({ query: 'compiler settings changed, rebuild only what is needed', component_hint: 'compiler', operation_hint: 'build', top_k: 5 })
    const audit = runtime.auditFor(first.retrieval_ref)
    expect(audit).toEqual(runtime.auditFor(second.retrieval_ref))
    expect(audit.request.retrieval_id).toBe(first.retrieval_ref)
    expect(audit.candidateUniverse.candidates).toHaveLength(5)
    expect(audit.candidateUniverse.candidates.map((candidate) => candidate.memory_id)).not.toContain('memory_stale_scope')
    expect(audit.candidateUniverse.candidates.map((candidate) => candidate.memory_id)).not.toContain('memory_unverified_hook')
    expect(first.items).toEqual(second.items)
    expect(first.items.every((item, index) => item.rank === index + 1)).toBe(true)
    expect(first.items.every((item, index) => index === 0 || first.items[index - 1].score_fixed >= item.score_fixed)).toBe(true)
  })
})
