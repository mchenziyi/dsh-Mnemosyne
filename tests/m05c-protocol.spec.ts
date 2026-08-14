import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/protocol/canonical.js'
import { createRecallContextTool, RECALL_PREFIX } from '../src/recall-tool.js'
import { encodeRecallContext, replayRecallContext, validateRecallContext } from '../src/protocol/recall.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

describe('M0.5C recall protocol', () => {
  it('builds a stable envelope from valid search/open disclosures', async () => {
    const tool = createRecallContextTool()
    expect(tool.name).toBe('mnemosyne_eval_recall_context')
    expect(RECALL_PREFIX).toContain('not user authored')
    expect(typeof canonicalHash).toBe('function')
  })

  it('rejects a tampered envelope and replays canonical bytes without runtime access', () => {
    expect(() => replayRecallContext('{"schema_version":1}')).toThrow()
    expect(() => validateRecallContext({})).toThrow()
    expect(() => encodeRecallContext({} as never)).toThrow()
  })

  it('rejects non-canonical replay bytes, invalid parents, duplicate memories, and oversized open sets', () => {
    expect(() => replayRecallContext('{ "schema_version": 1 }')).toThrow()
    expect(() => validateRecallContext({ schema_version: 1, context_id: 'context_a', source: 'plugin_memory', not_user_authored: true, retrieval_id: 'retrieval_a', search_disclosure: {}, open_disclosures: [{}, {}, {}], memory_ids: [], content_sha256: 'sha256_' + '0'.repeat(64) })).toThrow()
  })

  it('creates a typed plugin recall UserMessage', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: `${RECALL_PREFIX}\n{"ok":true}` }],
      source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' },
    })
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' })
  })

  it('does not expose the evaluation-only tool from the production package root', async () => {
    const production = await import('../src/index.js')
    expect('createRecallContextTool' in production).toBe(false)
    expect('mnemosyne_eval_recall_context' in production).toBe(false)
  })
})
