import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export type ScopeReason =
  | 'missing_agent'
  | 'agent_session_identity_mismatch'
  | 'missing_project_root'
  | 'invalid_project_root'
  | 'invalid_session_id'
  | 'session_scope_conflict'
  | 'runtime_disposed'

export interface ScopeStatusPayload {
  status: 'ready' | 'unavailable' | 'conflict'
  source: 'session_header' | 'explicit_config' | 'none'
  project_scope_id: string | null
  session_scope_id: string | null
  reason: ScopeReason | null
}

export interface StatusScopeResolutionReady {
  status: 'ready'
  scope: {
    source: 'session_header' | 'explicit_config'
    project_scope_id: string
    session_scope_id: string
  }
}

export interface StatusScopeResolutionFailed {
  status: 'unavailable' | 'conflict'
  reason: ScopeReason
}

export type StatusScopeResolution = StatusScopeResolutionReady | StatusScopeResolutionFailed

export interface StatusScopeResolver {
  resolveExecution(exec?: ToolRunContext): StatusScopeResolution
}

export interface StatusOutput {
  plugin: 'dsh-Mnemosyne'
  version: '0.0.0-dev'
  protocol_version: 2
  memory_enabled: false
  status: 'ready'
  scope: ScopeStatusPayload
}

export const STATUS_OUTPUT: StatusOutput = Object.freeze({
  plugin: 'dsh-Mnemosyne',
  version: '0.0.0-dev',
  protocol_version: 2,
  memory_enabled: false,
  status: 'ready',
  scope: {
    status: 'unavailable' as const,
    source: 'none' as const,
    project_scope_id: null,
    session_scope_id: null,
    reason: 'missing_agent' as const,
  },
})

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plugin: { type: 'string', required: true, const: 'dsh-Mnemosyne' },
    version: { type: 'string', required: true, const: '0.0.0-dev' },
    protocol_version: { type: 'integer', required: true, const: 2 },
    memory_enabled: { type: 'boolean', required: true, const: false },
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
  },
} as const

export function createStatusTool(runtime?: StatusScopeResolver): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_status',
    description: 'Report the read-only dsh-Mnemosyne M0 plugin status.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args: unknown, exec: ToolRunContext): Promise<StatusOutput> => {
      if (!runtime) {
        return STATUS_OUTPUT
      }

      const resolution = runtime.resolveExecution(exec)
      if (resolution.status === 'ready') {
        return {
          plugin: 'dsh-Mnemosyne',
          version: '0.0.0-dev',
          protocol_version: 2,
          memory_enabled: false,
          status: 'ready',
          scope: {
            status: 'ready',
            source: resolution.scope.source,
            project_scope_id: resolution.scope.project_scope_id,
            session_scope_id: resolution.scope.session_scope_id,
            reason: null,
          },
        }
      }

      return {
        plugin: 'dsh-Mnemosyne',
        version: '0.0.0-dev',
        protocol_version: 2,
        memory_enabled: false,
        status: 'ready',
        scope: {
          status: resolution.status,
          source: 'none',
          project_scope_id: null,
          session_scope_id: null,
          reason: resolution.reason,
        },
      }
    },
  })
}
