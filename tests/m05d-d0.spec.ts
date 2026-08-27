import { describe, expect, it } from 'vitest'
import {
  loadM05Dv2Fixtures,
  validateM05Dv2Fixtures,
  runOfflineM05D,
  validateOfflineReceipts,
  validateModelReceipt,
  validateUsage,
  FakeProvider,
  V1_GOLDEN,
} from '../src/m05d/index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { canonicalHash } from '../src/protocol/canonical.js'
import { RetrievalRuntime } from '../src/retrieval/runtime.js'
import { createRecallContext, encodeRecallContext, replayRecallContext } from '../src/protocol/recall.js'
import { RECALL_PREFIX } from '../src/recall-tool.js'

describe('M0.5D D0/D1 failure matrix', () => {
  it('emits a complete public fake-provider stream for no-memory failure', async () => {
    expect(FakeProvider.length).toBe(0)
    const provider = new FakeProvider(); const chunks = [] as unknown[]
    for await (const chunk of provider.stream({ provider: 'm05d-fake', model: 'offline', messages: [createUserMessage({ content: [{ type: 'text', text: 'M05D_TASK_SHAPE\n{"task_id":"task_build_recovery","result_fields":["rebuild_mode"]}\ntask_id:task_build_recovery\nDiagnose a targeted rebuild.' }], source: { kind: 'user' } })], tools: [] })) chunks.push(chunk)
    expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })
  it('derives a memory result from visible evidence rather than prompt wording', async () => {
    const fixtures = await loadM05Dv2Fixtures(); const runtime = new RetrievalRuntime(fixtures.catalog); const search = runtime.search({ query: 'compiler configuration', top_k: 5 }); const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: 'memory_build_cache' })
    const provider = new FakeProvider(); const chunks = [] as unknown[]
    for await (const chunk of provider.stream({ provider: 'm05d-fake', model: 'offline', messages: [createUserMessage({ content: [{ type: 'text', text: 'M05D_TASK_SHAPE\n{"task_id":"task_build_recovery","result_fields":["rebuild_mode"]}' }], source: { kind: 'user' } }), createUserMessage({ content: [{ type: 'text', text: 'task_id:task_build_recovery\nUnrelated instruction.' }], source: { kind: 'user' } }), createUserMessage({ content: [{ type: 'text', text: JSON.stringify(opened) }], source: { kind: 'user' } })], tools: [] })) chunks.push(chunk)
    const text = chunks.find((chunk) => (chunk as { type: string }).type === 'text-delta') as { text: string }
    expect(JSON.parse(text.text).result).toEqual({ rebuild_mode: 'targeted' })
  })
  it('passes the same fake stream through public LLM runtime', async () => {
    const ctx = new Context(); const fiber = await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['m05d-fake'], new FakeProvider()); const chunks = [] as unknown[]
    for await (const chunk of ctx.llm.stream({ provider: 'm05d-fake', model: 'offline', messages: [createUserMessage({ content: [{ type: 'text', text: 'M05D_TASK_SHAPE\n{"task_id":"task_build_recovery","result_fields":["rebuild_mode"]}\ntask_id:task_build_recovery\nDiagnose a targeted rebuild.' }], source: { kind: 'user' } })], tools: [] })) chunks.push(chunk)
    await fiber.dispose()
    expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })
  it('passes a validated recall envelope through the public LLM runtime', async () => {
    const fixtures = await loadM05Dv2Fixtures(); const runtime = new RetrievalRuntime(fixtures.catalog); const search = runtime.search({ query: 'synthetic compiler configuration change', top_k: 5 }); const opened = runtime.open({ retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: search.items[0].memory_id }); const context = createRecallContext(search, [opened]); const ctx = new Context(); const fiber = await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['m05d-fake'], new FakeProvider()); const chunks = [] as unknown[]
    const encoded = encodeRecallContext(context); expect(encoded.includes('\n')).toBe(false); expect(replayRecallContext(encoded).content_sha256).toBe(context.content_sha256)
    for await (const chunk of ctx.llm.stream({ provider: 'm05d-fake', model: 'offline', messages: [createUserMessage({ content: [{ type: 'text', text: `${RECALL_PREFIX}\n${encoded}\nM05D_TASK_SHAPE\n{"task_id":"task_build_recovery","result_fields":["rebuild_mode"]}\ntask_id:task_build_recovery\nDiagnose a synthetic compiler configuration change and choose a deterministic targeted rebuild.` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } })], tools: [] })) chunks.push(chunk)
    await fiber.dispose(); expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })
  it('keeps v1 golden bytes and adds exactly two non-memory controls to v2', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    expect(fixtures.tasks.filter((task) => task.task_kind === 'memory_dependent')).toHaveLength(6)
    expect(fixtures.tasks.filter((task) => task.task_kind === 'non_memory_control')).toHaveLength(2)
    expect(fixtures.manifest.files.map((file) => file.relative_name)).toContain('acquisition-cases.json')
    expect((fixtures.catalog as unknown as { fixture_version: number }).fixture_version).toBe(1)
    expect((fixtures.retrievalCases as unknown as { fixture_version: number }).fixture_version).toBe(1)
    const manifest = new Map(fixtures.manifest.files.map((file) => [file.relative_name, file.content_sha256]))
    expect(manifest.get('memory-catalog.json')).toBe(V1_GOLDEN['memory-catalog.json'])
    expect(manifest.get('retrieval-cases.json')).toBe(V1_GOLDEN['retrieval-cases.json'])
  })

  it('validates receipts only against complete fixtures and records acquisition reason/hash closure', async () => {
    const fixtures = await loadM05Dv2Fixtures(); const summary = await runOfflineM05D()
    expect(() => validateOfflineReceipts(summary.receipts, fixtures)).not.toThrow()
    const novel = summary.receipts.find((receipt) => receipt.acquisition.case_id === 'novel_candidate')!
    const skipped = summary.receipts.find((receipt) => receipt.acquisition.case_id !== 'novel_candidate')!
    expect(novel.acquisition.provider_calls).toBe(1)
    expect(novel.acquisition.reason_code).toBe('novel_candidate')
    expect(novel.acquisition.candidate_content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(skipped.acquisition.provider_calls).toBe(0)
    expect(skipped.acquisition.candidate_content_sha256).toBeNull()
    expect(skipped.acquisition.reason_code).not.toBe('novel_candidate')
    const reasonTamper = structuredClone(summary.receipts); const reasonReceipt = reasonTamper.find((receipt) => receipt.acquisition.case_id === 'novel_candidate')!; reasonReceipt.acquisition.reason_code = 'sensitive_input'; delete (reasonReceipt as unknown as Record<string, unknown>).canonical_hash; reasonReceipt.canonical_hash = canonicalHash(reasonReceipt)
    expect(() => validateOfflineReceipts(reasonTamper, fixtures)).toThrow()
    const hashTamper = structuredClone(summary.receipts); const hashReceipt = hashTamper.find((receipt) => receipt.acquisition.case_id === 'novel_candidate')!; hashReceipt.acquisition.candidate_content_sha256 = 'sha256_0000000000000000000000000000000000000000000000000000000000000000'; delete (hashReceipt as unknown as Record<string, unknown>).canonical_hash; hashReceipt.canonical_hash = canonicalHash(hashReceipt)
    expect(() => validateOfflineReceipts(hashTamper, fixtures)).toThrow()
  })

  it('rejects invalid control task kinds and required memory', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    const invalid = structuredClone(fixtures)
    invalid.tasks[6].task_kind = 'memory_dependent'
    invalid.tasks[6].required_memory_ids = ['memory_build_cache']
    expect(() => validateM05Dv2Fixtures(invalid)).toThrow()
  })

  it('runs 120 isolated offline receipts with stable identities and acquisition timing', async () => {
    const first = await runOfflineM05D()
    const second = await runOfflineM05D()
    expect(first.receipts).toHaveLength(120)
    expect(new Set(first.receipts.map((receipt) => receipt.run_id)).size).toBe(120)
    expect(first.canonical_bytes).toBe(second.canonical_bytes)
    expect(first.evidence_kind).toBe('offline_fake_provider')
    expect(first.recommendation).toBeUndefined()
    expect(first.receipts.filter((receipt) => receipt.acquisition.provider_calls > 0)).toHaveLength(24)
    expect(first.receipts.every((receipt) => receipt.acquisition.after_task_completed)).toBe(true)
    expect(first.receipts.find((receipt) => receipt.task_id === 'task_build_recovery' && receipt.group === 'no_memory')?.tool_calls).toEqual(['m05d_task_fixture'])
    expect(first.receipts.find((receipt) => receipt.task_id === 'task_build_recovery' && receipt.group === 'tool_only')?.tool_calls).toEqual(['m05d_task_fixture', 'mnemosyne_search', 'mnemosyne_open'])
    expect(first.receipts.find((receipt) => receipt.task_id === 'task_build_recovery' && receipt.group === 'auto_inject')?.tool_calls).toEqual(['m05d_task_fixture'])
  })

  it('fails closed for strict model receipts and usage', () => {
    expect(() => validateModelReceipt('{"schema_version":1}')).toThrow()
    expect(() => validateModelReceipt('```json\n{}\n```')).toThrow()
    expect(() => validateUsage({ inputTokens: -1, outputTokens: 0 })).toThrow()
    expect(() => validateUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 1, billedInput: 1 })).toThrow()
  })

  it('rejects protocol drift, threshold drift, and runner-limit drift', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    for (const mutate of [
      (value: typeof fixtures) => (value.protocol as Record<string, unknown>).extra = true,
      (value: typeof fixtures) => (value.protocol.thresholds as Record<string, unknown>).excluded_leakage_max = 1,
      (value: typeof fixtures) => (value.protocol.runner_limits as Record<string, unknown>).max_model_calls_per_task = 5,
    ]) {
      const invalid = structuredClone(fixtures); mutate(invalid); expect(() => validateM05Dv2Fixtures(invalid)).toThrow()
    }
  })

  it('rejects catalog/retrieval reference and schema drift', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    const catalog = structuredClone(fixtures); (catalog.catalog as unknown as Record<string, unknown>).unknown = true
    expect(() => validateM05Dv2Fixtures(catalog)).toThrow()
    const retrieval = structuredClone(fixtures); (retrieval.retrievalCases as unknown as { cases: Array<Record<string, unknown>> }).cases[0].expected_memory_ids = ['memory_missing']
    expect(() => validateM05Dv2Fixtures(retrieval)).toThrow()
  })

  it('rejects manifest hash format, duplicate names, and missing closure', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    for (const mutate of [
      (value: typeof fixtures) => (value.manifest.files[0].content_sha256 = 'not-a-hash'),
      (value: typeof fixtures) => (value.manifest.files[1].relative_name = value.manifest.files[0].relative_name),
      (value: typeof fixtures) => (value.manifest.files = value.manifest.files.slice(1)),
    ]) {
      const invalid = structuredClone(fixtures); mutate(invalid); expect(() => validateM05Dv2Fixtures(invalid)).toThrow()
    }
  })

  it('rejects unsafe acquisition input and malformed candidate output', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    const sensitive = structuredClone(fixtures); sensitive.acquisitionCases[0].episode_summary = 'api_key=FAKE_SECRET'
    expect(() => validateM05Dv2Fixtures(sensitive)).toThrow()
    const malformed = structuredClone(fixtures); malformed.acquisitionCases[0].provider_output = { title: '', summary: 'ok', redaction_status: 'passed' }
    expect(() => validateM05Dv2Fixtures(malformed)).toThrow()
  })

  it('rejects receipt prose, unknown result fields, wrong task, and unobserved memory', () => {
    const base = JSON.stringify({ schema_version: 1, task_id: 'task_control_format', exit_code: 0, result: { controlled_field: 'alpha' }, adopted_memory_ids: [], failure_code: null })
    expect(() => validateModelReceipt(` ${base}`)).toThrow()
    expect(() => validateModelReceipt(base, [], ['other_field'])).toThrow()
    expect(() => validateModelReceipt(base.replace('task_control_format', 'task_wrong'), [], ['controlled_field'], 'task_control_format')).toThrow()
    const adopted = base.replace('[]', '["memory_build_cache"]'); expect(() => validateModelReceipt(adopted)).toThrow()
  })

  it('fails closed for missing, duplicate, tampered, and cross-group runs', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    const summary = await runOfflineM05D()
    expect(() => validateOfflineReceipts(summary.receipts.slice(1), fixtures)).toThrow()
    const duplicate = structuredClone(summary.receipts); duplicate[1].run_id = duplicate[0].run_id
    expect(() => validateOfflineReceipts(duplicate, fixtures)).toThrow()
    const tampered = structuredClone(summary.receipts); tampered[0].success = !tampered[0].success
    expect(() => validateOfflineReceipts(tampered, fixtures)).toThrow()
    const drifted = structuredClone(summary.receipts); drifted[0].group = drifted[0].group === 'no_memory' ? 'auto_inject' : 'no_memory'
    expect(() => validateOfflineReceipts(drifted, fixtures)).toThrow()
  })

  it('rejects recomputed-hash receipt tampering and enforces observed/opened/adopted closure', { timeout: 20000 }, async () => {
    const fixtures = await loadM05Dv2Fixtures(); const summary = await runOfflineM05D()
    const tool = structuredClone(summary.receipts.find((receipt) => receipt.group === 'tool_only' && receipt.retrieved_memory_ids.length > receipt.opened_memory_ids.length)!)
    tool.adopted_memory_ids = [tool.retrieved_memory_ids.find((id) => !tool.opened_memory_ids.includes(id))!]
    delete (tool as unknown as Record<string, unknown>).canonical_hash
    tool.canonical_hash = canonicalHash(tool)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === tool.run_id ? tool : receipt), fixtures)).toThrow()
    const unknown = structuredClone(summary.receipts[0]); unknown.model_result.unknown = true
    delete (unknown as unknown as Record<string, unknown>).canonical_hash; unknown.canonical_hash = canonicalHash(unknown)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === unknown.run_id ? unknown : receipt), fixtures)).toThrow()
    const usage = structuredClone(summary.receipts[0]); usage.usage.model.inputTokens = -1
    delete (usage as unknown as Record<string, unknown>).canonical_hash; usage.canonical_hash = canonicalHash(usage)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === usage.run_id ? usage : receipt), fixtures)).toThrow()
    const observed = structuredClone(summary.receipts.find((receipt) => receipt.group === 'tool_only' && receipt.observed_memory_ids.length > 0)!)
    observed.observed_memory_ids = observed.observed_memory_ids.slice(1); delete (observed as unknown as Record<string, unknown>).canonical_hash; observed.canonical_hash = canonicalHash(observed)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === observed.run_id ? observed : receipt), fixtures)).toThrow()
    const extra = structuredClone(summary.receipts[0]) as typeof summary.receipts[0] & { extra?: boolean }; extra.extra = true; delete (extra as unknown as Record<string, unknown>).canonical_hash; extra.canonical_hash = canonicalHash(extra)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === extra.run_id ? extra : receipt), fixtures)).toThrow()
  })

  it('enforces model receipt failure coupling and fixed model-call metadata', async () => {
    const fixtures = await loadM05Dv2Fixtures(); const summary = await runOfflineM05D()
    expect(summary.receipts.every((receipt) => receipt.seed_honored === false && receipt.model_call_count >= 1 && receipt.model_call_count <= fixtures.protocol.runner_limits.max_model_calls_per_task)).toBe(true)
    const invalid = JSON.stringify({ schema_version: 1, task_id: 'task_control_format', exit_code: 0, result: { controlled_field: 'alpha' }, adopted_memory_ids: [], failure_code: 'unexpected' })
    expect(() => validateModelReceipt(invalid, [], ['controlled_field'], 'task_control_format')).toThrow()
    const invalidFailure = JSON.stringify({ schema_version: 1, task_id: 'task_control_format', exit_code: 1, result: {}, adopted_memory_ids: [], failure_code: null })
    expect(() => validateModelReceipt(invalidFailure, [], [], 'task_control_format')).toThrow()
  })

  it('records exact recall source and validated context receipt closure', async () => {
    const summary = await runOfflineM05D()
    const auto = summary.receipts.find((receipt) => receipt.group === 'auto_inject' && receipt.recall_receipt !== null)!
    expect(auto.recall_source).toEqual({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' })
    expect(auto.recall_receipt?.content_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(auto.recall_context?.content_sha256).toBe(auto.recall_receipt?.context_content_sha256)
  })

  it('locks acquisition precedence and rejects unknown event vocab or forbidden leakage', async () => {
    const fixtures = await loadM05Dv2Fixtures()
    expect(fixtures.acquisitionCases.map((item) => item.expected_decision)).toEqual(['novel_candidate', 'duplicate_skip', 'external_failure_skip', 'sensitive_reject'])
    const summary = await runOfflineM05D()
    const eventTamper = structuredClone(summary.receipts[0]); eventTamper.memory_events = ['unknown_event']; delete (eventTamper as unknown as Record<string, unknown>).canonical_hash; eventTamper.canonical_hash = canonicalHash(eventTamper)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === eventTamper.run_id ? eventTamper : receipt), fixtures)).toThrow()
    const forbidden = structuredClone(summary.receipts.find((receipt) => receipt.group === 'tool_only')!); forbidden.retrieved_memory_ids = [...forbidden.retrieved_memory_ids, 'memory_stale_scope'].sort(); delete (forbidden as unknown as Record<string, unknown>).canonical_hash; forbidden.canonical_hash = canonicalHash(forbidden)
    expect(() => validateOfflineReceipts(summary.receipts.map((receipt) => receipt.run_id === forbidden.run_id ? forbidden : receipt), fixtures)).toThrow()
  })
})
