import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readVerifiedCurrentWorld } from './generation-store.js'
import { MemoryStoreError } from './memory-store-error.js'
import {
  validateStatusV3Output,
  type MemoryAvailability,
  type ScopeReason,
  type StatusV3MemoryPayload,
  type StatusV3Output,
  type StatusV3ScopePayload,
} from './protocol/okf-retrieval.js'

export type { StatusV3ScopePayload as ScopeStatusPayload, ScopeReason, MemoryAvailability }

export type StatusScopeResolution =
  | {
      status: 'ready'
      source?: 'session_header' | 'explicit_config'
      reason?: null
      scope: {
        project_root: string
        project_scope_id: string
        session_scope_id: string
        source: 'session_header' | 'explicit_config'
      }
    }
  | {
      status: 'unavailable' | 'conflict'
      source?: 'none'
      reason: ScopeReason
      scope?: undefined
    }

export interface StatusScopeResolver {
  resolveExecution(exec?: ToolRunContext): StatusScopeResolution
}

export type { StatusV3Output as StatusOutput }

export const STATUS_OUTPUT: StatusV3Output = Object.freeze({
  plugin: 'dsh-Mnemosyne',
  version: '0.1.0',
  protocol_version: 3,
  memory_enabled: true,
  status: 'ready',
  scope: Object.freeze({
    status: 'unavailable' as const,
    source: 'none' as const,
    project_scope_id: null,
    session_scope_id: null,
    reason: 'missing_agent' as const,
  }),
  memory: Object.freeze({
    availability: 'unavailable' as const,
    generation_id: null,
    short_term_count: 0,
    long_term_count: 0,
    total_count: 0,
    reason: 'missing_agent',
  }),
})

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plugin: { type: 'string', required: true, const: 'dsh-Mnemosyne' },
    version: { type: 'string', required: true, const: '0.1.0' },
    protocol_version: { type: 'integer', required: true, const: 3 },
    memory_enabled: { type: 'boolean', required: true, const: true },
    status: { type: 'string', required: true, const: 'ready' },
    scope: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['ready', 'unavailable', 'conflict'] },
        source: { type: 'string', required: true, enum: ['session_header', 'explicit_config', 'none'] },
        project_scope_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        session_scope_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        reason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      },
    },
    memory: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        availability: { type: 'string', required: true, enum: ['ready', 'empty', 'unavailable', 'invalid'] },
        generation_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        short_term_count: { type: 'integer', required: true },
        long_term_count: { type: 'integer', required: true },
        total_count: { type: 'integer', required: true },
        reason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      },
    },
  },
} as const

export function createStatusTool(runtime?: StatusScopeResolver): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_status',
    description: 'Report the read-only dsh-Mnemosyne status.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args: unknown, exec: ToolRunContext): Promise<StatusV3Output> => {
      if (!runtime) {
        return STATUS_OUTPUT
      }

      const resolution = runtime.resolveExecution(exec)
      if (resolution.status !== 'ready') {
        const scopePayload: StatusV3ScopePayload = {
          status: resolution.status,
          source: 'none',
          project_scope_id: null,
          session_scope_id: null,
          reason: resolution.reason,
        }
        const memoryPayload: StatusV3MemoryPayload = {
          availability: 'unavailable',
          generation_id: null,
          short_term_count: 0,
          long_term_count: 0,
          total_count: 0,
          reason: resolution.reason,
        }
        const out: StatusV3Output = {
          plugin: 'dsh-Mnemosyne',
          version: '0.1.0',
          protocol_version: 3,
          memory_enabled: true,
          status: 'ready',
          scope: scopePayload,
          memory: memoryPayload,
        }
        return validateStatusV3Output(out)
      }

      const scopePayload: StatusV3ScopePayload = {
        status: 'ready',
        source: resolution.scope.source,
        project_scope_id: resolution.scope.project_scope_id,
        session_scope_id: resolution.scope.session_scope_id,
        reason: null,
      }

      let memoryPayload: StatusV3MemoryPayload
      try {
        const currentWorld = await readVerifiedCurrentWorld(resolution.scope.project_root, resolution.scope.project_scope_id)
        if (!currentWorld) {
          memoryPayload = {
            availability: 'empty',
            generation_id: null,
            short_term_count: 0,
            long_term_count: 0,
            total_count: 0,
            reason: null,
          }
        } else {
          let shortTermCount = 0
          let longTermCount = 0
          for (const entry of currentWorld.index.entries) {
            if (entry.tier === 'short_term') {
              if (entry.session_scope_id === resolution.scope.session_scope_id) {
                shortTermCount++
              }
            } else {
              longTermCount++
            }
          }
          memoryPayload = {
            availability: 'ready',
            generation_id: currentWorld.generation.generation_id,
            short_term_count: shortTermCount,
            long_term_count: longTermCount,
            total_count: shortTermCount + longTermCount,
            reason: null,
          }
        }
      } catch (err: unknown) {
        let reasonCode: string
        if (err instanceof MemoryStoreError) {
          reasonCode = err.code
        } else {
          reasonCode = 'generation_invalid'
        }
        memoryPayload = {
          availability: 'invalid',
          generation_id: null,
          short_term_count: 0,
          long_term_count: 0,
          total_count: 0,
          reason: reasonCode,
        }
      }

      const out: StatusV3Output = {
        plugin: 'dsh-Mnemosyne',
        version: '0.1.0',
        protocol_version: 3,
        memory_enabled: true,
        status: 'ready',
        scope: scopePayload,
        memory: memoryPayload,
      }
      return validateStatusV3Output(out)
    },
  })
}
