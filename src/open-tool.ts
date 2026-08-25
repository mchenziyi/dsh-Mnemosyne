import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { OKFOpenDisclosure } from './protocol/okf-retrieval.js'

export interface OpenRuntime {
  open(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFOpenDisclosure>
}

const OPEN_PARAMETERS = {
  retrieval_id: { type: 'string', required: true },
  search_disclosure_sha256: { type: 'string', required: true },
  memory_id: { type: 'string', required: true },
} as const

const OPEN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true, const: 1 },
    disclosure_id: { type: 'string', required: true },
    retrieval_id: { type: 'string', required: true },
    parent_disclosure_sha256: { type: 'string', required: true },
    project_scope_id: { type: 'string', required: true },
    session_scope_id: { type: 'string', required: true },
    generation_ref: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        generation_id: { type: 'string', required: true },
        generation_sha256: { type: 'string', required: true },
        manifest_id: { type: 'string', required: true },
        manifest_sha256: { type: 'string', required: true },
        index_sha256: { type: 'string', required: true },
      },
    },
    level: { type: 'integer', required: true, const: 3 },
    memory_ref: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        tier: { type: 'string', required: true, enum: ['short_term', 'long_term'] },
        session_scope_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        memory_id: { type: 'string', required: true },
        content_sha256: { type: 'string', required: true },
        page_ref: { type: 'string', required: true },
      },
    },
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    component: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    body: { type: 'string', required: true },
    content_sha256: { type: 'string', required: true },
  },
} as const

export function createOpenTool(runtime: OpenRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_open',
    description: 'Open one verified memory with full body content after a matching search disclosure.',
    parameters: OPEN_PARAMETERS,
    output: {
      schema: OPEN_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<OKFOpenDisclosure> => {
      return runtime.open(args, exec)
    },
  } as never)
}
