import { describe, expect, it } from 'vitest'
import { createDisclosureReceiptV3, runRecallSubagentV3 } from '../src/v3/recall-subagent.js'

const base = { generation_id: 'gen_' + 'a'.repeat(64), project_scope_id: 'sha256_' + 'b'.repeat(64) }
const pin = { ...base, catalog_id: 'catalog_' + 'c'.repeat(64), files: new Map() } as any

describe('v3 recall subagent boundary', () => {
  it('requires content to be selected only after summary selection', async () => {
    await expect(runRecallSubagentV3(pin, 'task', ['mem_a'], async () => ({ summary_refs: [], content_refs: ['mem_a'] }), new AbortController().signal)).rejects.toThrow()
  })

  it('rejects forged and over-budget refs', () => {
    expect(() => createDisclosureReceiptV3({ schema_version: 1, ...base, offered_refs: ['mem_a'], summary_refs: ['mem_b'], content_refs: [] })).toThrow()
    expect(() => createDisclosureReceiptV3({ schema_version: 1, ...base, offered_refs: ['mem_a'], summary_refs: ['mem_a'], content_refs: ['mem_a', 'mem_b', 'mem_c', 'mem_d'] })).toThrow()
  })

  it('binds the receipt to the pinned generation and preserves deterministic refs', async () => {
    const receipt = await runRecallSubagentV3(pin, 'task', ['mem_b', 'mem_a'], async (request) => {
      expect(request.generation_id).toBe(base.generation_id)
      expect(request.offered_refs).toEqual(['mem_a', 'mem_b'])
      return { summary_refs: ['mem_b', 'mem_a'], content_refs: ['mem_a'] }
    }, new AbortController().signal)
    expect(receipt.summary_refs).toEqual(['mem_a', 'mem_b'])
    expect(receipt.content_refs).toEqual(['mem_a'])
    expect(receipt.receipt_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
  })
})
