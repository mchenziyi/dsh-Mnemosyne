export interface ModelUsageV3 {
  uncached_input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
}

export interface AggregateModelUsageV3 extends ModelUsageV3 {
  model_calls: number
  failed_attempts: number
}

interface TokenUsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  reasoningTokens?: unknown
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalizeUsage(value: unknown): ModelUsageV3 | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as TokenUsageLike
  const uncached = tokenCount(usage.inputTokens)
  const output = tokenCount(usage.outputTokens)
  if (uncached === undefined || output === undefined) return undefined
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  const reasoning = tokenCount(usage.reasoningTokens)
  return {
    uncached_input_tokens: uncached,
    output_tokens: output,
    ...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
  }
}

export function modelUsageFromSessionEventV3(event: unknown): ModelUsageV3 | undefined {
  if (!event || typeof event !== 'object') return undefined
  const value = event as { type?: unknown; data?: { usage?: unknown; stream?: unknown } }
  if (value.type === 'assistant/message') return normalizeUsage(value.data?.usage)
  if (value.type !== 'assistant/attempt' || !Array.isArray(value.data?.stream)) return undefined
  const chunk = [...value.data.stream].reverse().find((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'usage') as { usage?: unknown } | undefined
  return normalizeUsage(chunk?.usage)
}

export function aggregateModelUsageV3(events: readonly unknown[]): AggregateModelUsageV3 | undefined {
  let aggregate: AggregateModelUsageV3 | undefined
  let cacheReadComplete = true
  let cacheWriteComplete = true
  let reasoningComplete = true
  for (const event of events) {
    const type = (event as { type?: unknown } | undefined)?.type
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
    const usage = modelUsageFromSessionEventV3(event)
    if (!usage) return undefined
    aggregate ??= { uncached_input_tokens: 0, output_tokens: 0, model_calls: 0, failed_attempts: 0 }
    aggregate.uncached_input_tokens += usage.uncached_input_tokens
    aggregate.output_tokens += usage.output_tokens
    if (!Number.isSafeInteger(aggregate.uncached_input_tokens) || !Number.isSafeInteger(aggregate.output_tokens)) return undefined
    aggregate.model_calls++
    if (type === 'assistant/attempt') aggregate.failed_attempts++
    if (usage.cache_read_tokens !== undefined) {
      aggregate.cache_read_tokens = (aggregate.cache_read_tokens ?? 0) + usage.cache_read_tokens
      if (!Number.isSafeInteger(aggregate.cache_read_tokens)) return undefined
    } else cacheReadComplete = false
    if (usage.cache_write_tokens !== undefined) {
      aggregate.cache_write_tokens = (aggregate.cache_write_tokens ?? 0) + usage.cache_write_tokens
      if (!Number.isSafeInteger(aggregate.cache_write_tokens)) return undefined
    } else cacheWriteComplete = false
    if (usage.reasoning_tokens !== undefined) {
      aggregate.reasoning_tokens = (aggregate.reasoning_tokens ?? 0) + usage.reasoning_tokens
      if (!Number.isSafeInteger(aggregate.reasoning_tokens)) return undefined
    } else reasoningComplete = false
  }
  if (!aggregate) return undefined
  if (!cacheReadComplete) delete aggregate.cache_read_tokens
  if (!cacheWriteComplete) delete aggregate.cache_write_tokens
  if (!reasoningComplete) delete aggregate.reasoning_tokens
  return aggregate
}
