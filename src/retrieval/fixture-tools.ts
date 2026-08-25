import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface FixtureRetrievalRuntime {
  search(rawArgs: unknown, exec?: ToolRunContext): Promise<unknown> | unknown
  open(rawArgs: unknown, exec?: ToolRunContext): Promise<unknown> | unknown
}

const FIXTURE_SEARCH_PARAMETERS = {
  query: { type: 'string', required: true },
  component_hint: { type: 'string' },
  operation_hint: { type: 'string' },
  top_k: { type: 'integer' },
} as const

const FIXTURE_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true },
    disclosure_id: { type: 'string', required: true },
    retrieval_ref: { type: 'string', required: true },
    candidate_universe_sha256: { type: 'string', required: true },
    level: { type: 'integer', required: true },
    result_count: { type: 'integer', required: true },
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          component: { type: 'string', required: true },
          operation: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          aliases: { type: 'array', required: true, items: { type: 'string' } },
          score_fixed: { type: 'integer', required: true },
          rank: { type: 'integer', required: true },
        },
      },
    },
    content_sha256: { type: 'string', required: true },
  },
} as const

const FIXTURE_OPEN_PARAMETERS = {
  retrieval_id: { type: 'string', required: true },
  search_disclosure_sha256: { type: 'string', required: true },
  memory_id: { type: 'string', required: true },
} as const

const FIXTURE_OPEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true },
    disclosure_id: { type: 'string', required: true },
    retrieval_ref: { type: 'string', required: true },
    parent_disclosure_sha256: { type: 'string', required: true },
    level: { type: 'integer', required: true },
    memory_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    component: { type: 'string', required: true },
    operation: { type: 'string', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    aliases: { type: 'array', required: true, items: { type: 'string' } },
    body: { type: 'string', required: true },
    lifecycle: { type: 'string', required: true, const: 'active' },
    memory_content_sha256: { type: 'string', required: true },
    content_sha256: { type: 'string', required: true },
  },
} as const

export function createFixtureSearchTool(runtime: FixtureRetrievalRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_search',
    description: 'Fixture search tool for M0.5 evaluation pipeline.',
    parameters: FIXTURE_SEARCH_PARAMETERS,
    output: {
      schema: FIXTURE_SEARCH_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      return runtime.search(args, exec)
    },
  } as never)
}

export function createFixtureOpenTool(runtime: FixtureRetrievalRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_open',
    description: 'Fixture open tool for M0.5 evaluation pipeline.',
    parameters: FIXTURE_OPEN_PARAMETERS,
    output: {
      schema: FIXTURE_OPEN_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      return runtime.open(args, exec)
    },
  } as never)
}
