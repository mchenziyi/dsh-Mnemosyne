import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/protocol/canonical.js'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.js'
import { encodePlumbingSummary, loadEvaluationTruth, runNoMemoryProbe, runPlumbingEvaluation, summarizePlumbing, validatePlumbingReceipt, validatePlumbingSummary, validateRecallExecution, runScriptedFixtureAdapter, type PlumbingSummary } from '../src/m05c/plumbing.js'
import { createRecallContextTool, RECALL_PREFIX } from '../src/recall-tool.js'
import { encodeRecallContext, encodeRecallReceipt, replayRecallContext, validateRecallContext, validateRecallReceipt } from '../src/protocol/recall.js'

import { RetrievalRuntime } from '../src/retrieval/runtime.js'
import { createFixtureSearchTool, createFixtureOpenTool } from '../src/retrieval/fixture-tools.js'

async function runtime(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const truth = await loadEvaluationTruth()
  const r = new RetrievalRuntime(truth.catalog)
  const unregSearch = ctx.tools.register(createFixtureSearchTool(r))
  const unregOpen = ctx.tools.register(createFixtureOpenTool(r))
  return {
    ctx,
    fiber: {
      dispose: async () => {
        unregOpen()
        unregSearch()
      },
    },
  }
}

describe('M0.5C plumbing execution', () => {
  it('runs six tasks across three isolated groups and produces 90 receipts', async () => {
    const result = await runPlumbingEvaluation()
    expect(result.receipts).toHaveLength(90)
    expect(result.summary.status).toBe('pass')
    expect(result.summary.invariants.group_isolation).toBe(true)
    expect(result.summary.invariants.recall_source).toBe(true)
    expect(result.summary.invariants.disposal_cleanliness).toBe(true)
    expect(result.summary.invariants.scripted_outcomes).toBe(true)
    expect(await summarizePlumbing(result.receipts)).toEqual(result.summary)
    expect(result.receipts.filter((receipt) => receipt.group === 'no_memory').every((receipt) => receipt.tool_calls.length === 0 && receipt.visible_memory_ids.length === 0 && receipt.retrieved_memory_ids.length === 0)).toBe(true)
    expect(new Set(result.receipts.map((receipt) => receipt.run_id)).size).toBe(90)
    expect(new Set(result.receipts.map((receipt) => receipt.content_sha256)).size).toBe(90)
    expect(await encodePlumbingSummary(result.summary)).toBe(await encodePlumbingSummary(await summarizePlumbing(result.receipts)))
  })

  it('uses real ctx.tools for search/open and evaluation-only recall, then disposes', async () => {
    const { ctx, fiber } = await runtime()
    expect(ctx.tools.get('mnemosyne_search')).toBeDefined()
    expect(ctx.tools.get('mnemosyne_open')).toBeDefined()
    expect(ctx.tools.get('mnemosyne_eval_recall_context')).toBeUndefined()
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05c-search'), name: 'mnemosyne_search', arguments: { query: 'compiler cache targeted rebuild', top_k: 5 } })
    expect(result.isError).toBe(false)
    const search = result.value as Record<string, unknown>
    const open = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05c-open'), name: 'mnemosyne_open', arguments: { retrieval_id: search.retrieval_ref, search_disclosure_sha256: search.content_sha256, memory_id: (search.items as Array<Record<string, unknown>>)[0].memory_id } })
    expect(open.isError).toBe(false)
    const unregister = ctx.tools.register(createRecallContextTool())
    const recall = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05c-recall'), name: 'mnemosyne_eval_recall_context', arguments: { search_disclosure_json: JSON.stringify(search), open_disclosure_jsons: [JSON.stringify(open.value)] } })
    expect(recall.isError).toBe(false)
    expect(validateRecallExecution(recall).replayVerified).toBe(true)
    expect(encodeRecallReceipt(validateRecallReceipt(recall.value))).toBe(encodeRecallReceipt(validateRecallReceipt(recall.value)))
    expect(recall.additionalContexts).toHaveLength(1)
    expect(recall.additionalContexts?.[0].source).toEqual({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' })
    expect((recall.additionalContexts?.[0].content[0] as { text: string }).text.startsWith(RECALL_PREFIX)).toBe(true)
    const recallText = (recall.additionalContexts?.[0].content[0] as { text: string }).text
    const replayed = replayRecallContext(recallText.slice(RECALL_PREFIX.length + 1))
    expect(encodeRecallContext(replayed)).toBe(recallText.slice(RECALL_PREFIX.length + 1))
    const rehash = (value: Record<string, unknown>) => {
      const { content_sha256: _content, context_id: _context, ...identity } = value
      const context_id = `context_${canonicalHash(identity).slice(7, 23)}`
      const body = { ...identity, context_id }
      return { ...body, content_sha256: canonicalHash(body) }
    }
    expect(() => validateRecallContext(rehash({ ...replayed, retrieval_id: 'retrieval_wrong' }))).toThrow()
    expect(() => validateRecallContext(rehash({ ...replayed, memory_ids: [...replayed.memory_ids, 'memory_extra'].sort() }))).toThrow()
    expect(() => validateRecallContext(rehash({ ...replayed, open_disclosures: [...replayed.open_disclosures, replayed.open_disclosures[0]] }))).toThrow()
    expect(() => validateRecallContext(rehash({ ...replayed, open_disclosures: replayed.open_disclosures.map((open) => ({ ...open, parent_disclosure_sha256: `sha256_${'f'.repeat(64)}` })) }))).toThrow()
    const invalid = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05c-recall-invalid'), name: 'mnemosyne_eval_recall_context', arguments: { search_disclosure_json: '{}', open_disclosure_jsons: ['{}'] } })
    expect(invalid.isError).toBe(true)
    expect(invalid.additionalContexts ?? []).toHaveLength(0)
    const malicious = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('m05c-recall-malicious'), name: 'mnemosyne_eval_recall_context', arguments: { search_disclosure_json: '{"secret":"password=supersecret /private/tmp"}', open_disclosure_jsons: ['{}'] } })
    expect(malicious.isError).toBe(true)
    expect(JSON.stringify(malicious)).not.toContain('supersecret')
    expect(malicious.additionalContexts ?? []).toHaveLength(0)
    const validExecution = recall as typeof recall & { additionalContexts: NonNullable<typeof recall.additionalContexts> }
    expect(() => validateRecallExecution({ ...validExecution, additionalContexts: [] })).toThrow()
    expect(() => validateRecallExecution({ ...validExecution, additionalContexts: [...validExecution.additionalContexts, validExecution.additionalContexts[0]] })).toThrow()
    const wrongSource = { ...validExecution.additionalContexts[0], source: { kind: 'plugin' as const, plugin: 'other', form: 'recall' as const } }
    expect(() => validateRecallExecution({ ...validExecution, additionalContexts: [wrongSource] } as ToolExecutionResult)).toThrow()
    const wrongPrefix = { ...validExecution.additionalContexts[0], content: [{ type: 'text' as const, text: 'not a recall' }] }
    expect(() => validateRecallExecution({ ...validExecution, additionalContexts: [wrongPrefix] } as ToolExecutionResult)).toThrow()
    const receiptValue = validExecution.value as Record<string, unknown>
    const wrongReceiptBase = { ...receiptValue, context_content_sha256: `sha256_${'f'.repeat(64)}` }
    const wrongReceipt = { ...wrongReceiptBase, content_sha256: canonicalHash(wrongReceiptBase) }
    expect(() => validateRecallExecution({ ...validExecution, value: wrongReceipt } as ToolExecutionResult)).toThrow()
    unregister()
    await fiber.dispose()
    expect(ctx.tools.get('mnemosyne_eval_recall_context')).toBeUndefined()
    expect(ctx.tools.get('mnemosyne_search')).toBeUndefined()
  })

  it('does not expose M0.5A SummaryReport or recommendation', async () => {
    const { summary } = await runPlumbingEvaluation()
    expect(summary).not.toHaveProperty('recommendation')
    expect(JSON.stringify(summary)).not.toMatch(/GO|ADJUST|STOP/)
  })

  it('rejects summary identity/content tampering and unknown fields', async () => {
    const result = await runPlumbingEvaluation()
    const tampered = JSON.parse(JSON.stringify(result.summary)) as Record<string, unknown>
    tampered.status = result.summary.status === 'pass' ? 'fail' : 'pass'
    await expect(validatePlumbingSummary(tampered)).rejects.toThrow()
    await expect(validatePlumbingSummary({ ...result.summary, recommendation: 'go' })).rejects.toThrow()
  })

  it('accepts only a valid failure prefix and never treats it as success', async () => {
    const result = await runPlumbingEvaluation()
    const truth = await loadEvaluationTruth()
    const original = result.receipts.find((receipt) => receipt.group === 'auto_inject')!
    const assertion_results = original.assertion_results.map((item, index) => index === 0 ? { ...item, passed: false } : item)
    const { content_sha256: _ignored, ...withoutHash } = original
    const body = { ...withoutHash, tool_calls: original.tool_calls.slice(0, -1), context_source: 'none' as const, recall_context_sha256: null, recall_replay_verified: false, visible_memory_ids: [], assertion_results, success: false, failure_code: 'synthetic_failure' }
    expect(validatePlumbingReceipt({ ...body, content_sha256: canonicalHash(body) }, truth).success).toBe(false)
    expect(() => validatePlumbingReceipt({ ...body, content_sha256: canonicalHash({ ...body, success: true }) }, truth)).toThrow()
    const injectedFailure = { ...withoutHash, assertion_results, success: false, failure_code: 'adapter_assertion_failed' }
    expect(validatePlumbingReceipt({ ...injectedFailure, content_sha256: canonicalHash(injectedFailure) }, truth).context_source).toBe('plugin_recall')
    const duplicateRecall = { ...body, tool_calls: [...original.tool_calls, 'mnemosyne_eval_recall_context'], content_sha256: '' }
    delete (duplicateRecall as Partial<typeof duplicateRecall>).content_sha256
    expect(() => validatePlumbingReceipt({ ...duplicateRecall, content_sha256: canonicalHash(duplicateRecall) }, truth)).toThrow()
  })

  it('does not derive answers from prompt without visible memory material', () => {
    expect(runScriptedFixtureAdapter('targeted rebuild canonical identity active workspace', []).result.exit_code).toBe(1)
    expect(runScriptedFixtureAdapter('targeted rebuild canonical identity active workspace', ['targeted rebuild', 'canonical identity', 'active workspace']).result.exit_code).toBe(0)
  })

  it('runs the no-memory probe without constructing a catalog-backed runtime', async () => {
    const receipt = await runNoMemoryProbe()
    expect(receipt.group).toBe('no_memory')
    expect(receipt.tool_calls).toEqual([])
    expect(receipt.retrieved_memory_ids).toEqual([])
    expect(receipt.visible_memory_ids).toEqual([])
  })

  it('replays identical fixture runs byte-for-byte and rejects receipt identity changes', async () => {
    const first = await runPlumbingEvaluation()
    const second = await runPlumbingEvaluation()
    expect(JSON.stringify(first.receipts)).toBe(JSON.stringify(second.receipts))
    expect(await encodePlumbingSummary(first.summary)).toBe(await encodePlumbingSummary(second.summary))
    const missing = JSON.parse(JSON.stringify(first.summary)) as PlumbingSummary
    missing.receipts.no_memory.pop()
    await expect(validatePlumbingSummary(missing)).rejects.toThrow()
    const replaced = JSON.parse(JSON.stringify(first.summary)) as PlumbingSummary
    replaced.receipts.no_memory[0].task_id = 'task_unknown'
    await expect(validatePlumbingSummary(replaced)).rejects.toThrow()
    const duplicated = JSON.parse(JSON.stringify(first.summary)) as PlumbingSummary
    duplicated.receipts.no_memory[1] = duplicated.receipts.no_memory[0]
    await expect(validatePlumbingSummary(duplicated)).rejects.toThrow()
  })

  it('marks a complete channel with an invalid scripted outcome as summary failure', async () => {
    const result = await runPlumbingEvaluation()
    const make = (receipt: typeof result.receipts[number], success: boolean, failure_code: string | null) => {
      const assertion_results = receipt.assertion_results.map((item, index) => ({ ...item, passed: success ? true : index === 0 ? false : item.passed }))
      const { content_sha256: _content, ...body } = { ...receipt, assertion_results, success, failure_code }
      return { ...body, content_sha256: canonicalHash(body) }
    }
    const noMemoryIndex = result.receipts.findIndex((receipt) => receipt.group === 'no_memory')
    const noMemoryBad = make(result.receipts[noMemoryIndex], true, null)
    const noMemoryReceipts = [...result.receipts]; noMemoryReceipts[noMemoryIndex] = noMemoryBad
    expect((await summarizePlumbing(noMemoryReceipts)).status).toBe('fail')
    const autoIndex = result.receipts.findIndex((receipt) => receipt.group === 'auto_inject')
    const autoBad = make(result.receipts[autoIndex], false, 'adapter_assertion_failed')
    const autoReceipts = [...result.receipts]; autoReceipts[autoIndex] = autoBad
    expect((await summarizePlumbing(autoReceipts)).status).toBe('fail')
  })
})
