import { defineTool } from '@deepseek-ai/dsh-tools'

export interface StatusOutput {
  plugin: 'dsh-Mnemosyne'
  version: '0.0.0-dev'
  protocol_version: 1
  memory_enabled: false
  status: 'ready'
}

export const STATUS_OUTPUT: StatusOutput = Object.freeze({
  plugin: 'dsh-Mnemosyne',
  version: '0.0.0-dev',
  protocol_version: 1,
  memory_enabled: false,
  status: 'ready',
})

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plugin: { type: 'string', required: true, const: 'dsh-Mnemosyne' },
    version: { type: 'string', required: true, const: '0.0.0-dev' },
    protocol_version: { type: 'integer', required: true, const: 1 },
    memory_enabled: { type: 'boolean', required: true, const: false },
    status: { type: 'string', required: true, const: 'ready' },
  },
} as const

export function createStatusTool(): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_status',
    description: 'Report the read-only dsh-Mnemosyne M0 plugin status.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => STATUS_OUTPUT,
  })
}
