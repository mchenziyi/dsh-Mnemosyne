import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ManagementRuntime } from './management-runtime.js'

const LIST_PARAMETERS = {
  tier: {
    type: 'string',
    enum: ['all', 'short_term', 'long_term'],
  },
  include_inactive: { type: 'boolean' },
  limit: { type: 'integer' },
} as const

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true, const: 1 },
    project_scope_id: { type: 'string', required: true },
    session_scope_id: { type: 'string', required: true },
    evaluation_at: { type: 'string', required: true },
    params: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        tier: { type: 'string', required: true, enum: ['all', 'short_term', 'long_term'] },
        include_inactive: { type: 'boolean', required: true },
        limit: { type: 'integer', required: true },
      },
    },
    total_count: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tier: { type: 'string', required: true, enum: ['short_term', 'long_term'] },
          session_scope_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          memory_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          created_at: { type: 'string', required: true },
          expires_at: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          state: { type: 'string', required: true, enum: ['active', 'promoted', 'expired', 'forgotten'] },
          content_sha256: { type: 'string', required: true },
        },
      },
    },
    content_sha256: { type: 'string', required: true },
  },
} as const

export function createListTool(managementRuntime: ManagementRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_list',
    description: 'List short-term and long-term memories in the current project.',
    parameters: LIST_PARAMETERS,
    output: {
      schema: LIST_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (params: unknown, exec: ToolRunContext) => {
      return managementRuntime.list(params, exec)
    },
  } as never)
}

const PROMOTE_PARAMETERS = {
  memory_id: { type: 'string', required: true },
} as const

const PROMOTE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['created', 'noop'] },
    memory_id: { type: 'string', required: true },
    source_short_term_ref: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        project_scope_id: { type: 'string', required: true },
        session_scope_id: { type: 'string', required: true },
        memory_id: { type: 'string', required: true },
        content_sha256: { type: 'string', required: true },
      },
    },
    generation_id: { type: 'string', required: true },
  },
} as const

export function createPromoteTool(managementRuntime: ManagementRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_promote',
    description: 'Promote a short-term memory from the current session into permanent long-term memory.',
    parameters: PROMOTE_PARAMETERS,
    output: {
      schema: PROMOTE_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (params: unknown, exec: ToolRunContext) => {
      return managementRuntime.promote(params, exec)
    },
  } as never)
}

const FORGET_PARAMETERS = {
  tier: { type: 'string', required: true, enum: ['short_term', 'long_term'] },
  memory_id: { type: 'string', required: true },
} as const

const FORGET_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['created', 'noop'] },
    forget_id: { type: 'string', required: true },
    target: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        tier: { type: 'string', required: true, enum: ['short_term', 'long_term'] },
        session_scope_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        memory_id: { type: 'string', required: true },
        content_sha256: { type: 'string', required: true },
      },
    },
    generation_id: { type: 'string', required: true },
  },
} as const

export function createForgetTool(managementRuntime: ManagementRuntime): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_forget',
    description: 'Logically forget a short-term or long-term memory in the current project.',
    parameters: FORGET_PARAMETERS,
    output: {
      schema: FORGET_OUTPUT_SCHEMA as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (params: unknown, exec: ToolRunContext) => {
      return managementRuntime.forget(params, exec)
    },
  } as never)
}
