export interface ToolExecutionEvidence {
  ordinal: number
  call_id_sha256: string
  tool_name: string
  argument_binding: Record<string, any>
  result_status: string
  result_binding: Record<string, any>
  result_sha256: string
}

export interface StrictSessionEvidence {
  schema_version: 2
  run_id: string
  project_scope_id: string
  session_id_sha256: string
  completed_turns: number
  tool_executions: ToolExecutionEvidence[]
  recorded_at: string
  content_sha256: string
}

export declare const MNEMOSYNE_TOOLS: Set<string>

export declare function projectToolExecution(
  toolName: string,
  rawArgs: unknown,
  rawResult: unknown
): {
  argument_binding: Record<string, unknown>
  result_status: string
  result_binding: Record<string, unknown>
}

export declare function extractStrictSessionEvidence(params: {
  runId: string
  projectScopeId: string
  sessionId: string
  sessionEvents: unknown[]
}): StrictSessionEvidence

export declare function computeSessionEvidenceSha256(evidence: Omit<StrictSessionEvidence, 'content_sha256'>): string

export declare function createStrictSessionEvidence(params: {
  run_id: string
  project_scope_id: string
  session_id_sha256: string
  completed_turns: number
  tool_executions: ToolExecutionEvidence[]
  recorded_at?: string
}): StrictSessionEvidence

export declare function validateStrictSessionEvidence(evidence: unknown): StrictSessionEvidence

export declare function validateSearchOpenBinding(
  searchExec: ToolExecutionEvidence,
  openExec: ToolExecutionEvidence
): void

export declare function writeStrictSessionEvidence(
  evidenceDir: string,
  evidence: StrictSessionEvidence,
  options?: { allowOverwrite?: boolean; overwrite?: boolean }
): Promise<void>

export declare function readStrictSessionEvidence(
  evidenceDir: string,
  runId: string
): Promise<StrictSessionEvidence>

