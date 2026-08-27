import type { StrictSessionEvidence } from './business-evidence.js'

export interface ToolCallSummary {
  readonly call_id: string
  readonly tool_name: string
}

export interface ToolResultSummary {
  readonly call_id: string
  readonly status: string
}

export interface SessionEventSummary {
  readonly tool_calls: readonly ToolCallSummary[]
  readonly tool_results: readonly ToolResultSummary[]
  readonly completed_turns: number
  readonly session_id?: string
}

export declare function extractToolEventSummary(sessionEvents: readonly unknown[]): SessionEventSummary
export declare function writeSessionEvidence(
  evidenceDir: string,
  runId: string,
  summary: SessionEventSummary | StrictSessionEvidence
): Promise<void>
export declare function readSessionEvidence(
  evidenceDir: string,
  runId: string
): Promise<SessionEventSummary | StrictSessionEvidence | null>
