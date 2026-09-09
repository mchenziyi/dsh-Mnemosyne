export type ConsolidationStatus = 'running' | 'created' | 'skipped' | 'failed'

export interface ConsolidationStatusSnapshot {
  status: ConsolidationStatus
  turn: number
  updatedAt: number
}

/** Process-local, session-keyed status; it is never part of model context. */
export class ConsolidationStatusStore {
  private readonly values = new Map<string, ConsolidationStatusSnapshot>()

  set(sessionId: string, status: ConsolidationStatus, turn: number): void {
    this.values.set(sessionId, { status, turn, updatedAt: Date.now() })
  }

  get(sessionId: string): ConsolidationStatusSnapshot | null {
    return this.values.get(sessionId) ?? null
  }

  clear(sessionId: string): void {
    this.values.delete(sessionId)
  }
}
