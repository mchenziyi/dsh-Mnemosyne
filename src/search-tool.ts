import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { OKFSearchDisclosure } from './protocol/okf-retrieval.js'

export interface SearchRuntime {
  search(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFSearchDisclosure>
}

const SEARCH_PARAMETERS = {
  query: { type: 'string', required: true },
  component_hint: { type: 'string' },
  top_k: { type: 'integer' },
} as const

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true, const: 1 },
    disclosure_id: { type: 'string', required: true },
    retrieval_id: { type: 'string', required: true },
    project_scope_id: { type: 'string', required: true },
    session_scope_id: { type: 'string', required: true },
    generation_ref: {
      required: true,
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            generation_id: { type: 'string', required: true },
            generation_sha256: { type: 'string', required: true },
            manifest_id: { type: 'string', required: true },
            manifest_sha256: { type: 'string', required: true },
            index_sha256: { type: 'string', required: true },
          },
        },
      ],
    },
    query_fingerprint: { type: 'string', required: true },
    component_hint: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    top_k: { type: 'integer', required: true },
    level: { type: 'integer', required: true, const: 2 },
    result_count: { type: 'integer', required: true },
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
          score_fixed: { type: 'integer', required: true },
          rank: { type: 'integer', required: true },
        },
      },
    },
    content_sha256: { type: 'string', required: true },
  },
} as const

export function createSearchTool(runtime: SearchRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_search',
    description: 'Search verified project memory and return an L2 disclosure without body content.',
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<OKFSearchDisclosure> => {
      return runtime.search(args, exec)
    },
  } as never)
}
