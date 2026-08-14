import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RetrievalRuntime } from './retrieval/runtime.js'

const OPEN_PARAMETERS = { retrieval_id: { type: 'string', required: true }, search_disclosure_sha256: { type: 'string', required: true }, memory_id: { type: 'string', required: true } } as const
const OPEN_SCHEMA = { type: 'object', additionalProperties: false, properties: { schema_version: { type: 'integer', required: true }, disclosure_id: { type: 'string', required: true }, retrieval_ref: { type: 'string', required: true }, parent_disclosure_sha256: { type: 'string', required: true }, level: { type: 'integer', required: true }, memory_id: { type: 'string', required: true }, title: { type: 'string', required: true }, summary: { type: 'string', required: true }, component: { type: 'string', required: true }, operation: { type: 'string', required: true }, tags: { type: 'array', required: true, items: { type: 'string' } }, aliases: { type: 'array', required: true, items: { type: 'string' } }, body: { type: 'string', required: true }, lifecycle: { type: 'string', required: true, const: 'active' }, memory_content_sha256: { type: 'string', required: true }, content_sha256: { type: 'string', required: true } } } as const

export function createOpenTool(runtime: RetrievalRuntime): ReturnType<typeof defineTool> {
  return defineTool({ name: 'mnemosyne_open', description: 'Open one active synthetic memory only after a matching mnemosyne_search disclosure.', parameters: OPEN_PARAMETERS, output: { schema: OPEN_SCHEMA as never, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args: unknown) => runtime.open(args as never) } as never)
}
