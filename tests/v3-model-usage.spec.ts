import { describe, expect, it } from 'vitest'
import { aggregateModelUsageV3, modelUsageFromSessionEventV3 } from '../src/v3/model-usage.js'

describe('v3 model usage attribution', () => {
  it('reads successful message usage without double-counting its embedded stream', () => {
    const event = {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 97, cacheWriteTokens: 5, reasoningTokens: 2 },
        stream: [{ type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 97, cacheWriteTokens: 5, reasoningTokens: 2 } }],
      },
    }
    expect(modelUsageFromSessionEventV3(event)).toEqual({
      uncached_input_tokens: 11,
      output_tokens: 3,
      cache_read_tokens: 97,
      cache_write_tokens: 5,
      reasoning_tokens: 2,
    })
  })

  it('reads failed attempt usage from its compact stream', () => {
    expect(modelUsageFromSessionEventV3({
      type: 'assistant/attempt',
      data: { stream: [{ type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 13 } }] },
    })).toEqual({ uncached_input_tokens: 7, output_tokens: 1, cache_read_tokens: 13 })
  })

  it('aggregates successful and failed calls without treating unreported cache fields as zero', () => {
    expect(aggregateModelUsageV3([
      { type: 'assistant/attempt', data: { stream: [{ type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } }] } },
      { type: 'assistant/message', data: { usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 97 } } },
    ])).toEqual({
      uncached_input_tokens: 18,
      output_tokens: 4,
      model_calls: 2,
      failed_attempts: 1,
    })
    expect(aggregateModelUsageV3([
      { type: 'assistant/message', data: { usage: { inputTokens: 2, outputTokens: 1 } } },
    ])).toEqual({ uncached_input_tokens: 2, output_tokens: 1, model_calls: 1, failed_attempts: 0 })
    expect(aggregateModelUsageV3([
      { type: 'assistant/attempt', data: { stream: [{ type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 3 } }] } },
      { type: 'assistant/message', data: { usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 97 } } },
    ])?.cache_read_tokens).toBe(100)
  })

  it('ignores malformed or unrelated event data', () => {
    expect(modelUsageFromSessionEventV3({ type: 'assistant/message', data: { usage: { inputTokens: -1, outputTokens: 2 } } })).toBeUndefined()
    expect(modelUsageFromSessionEventV3({ type: 'user/message', data: {} })).toBeUndefined()
    expect(aggregateModelUsageV3([])).toBeUndefined()
    expect(aggregateModelUsageV3([{ type: 'assistant/message', data: { message: { content: [] } } }])).toBeUndefined()
  })
})
