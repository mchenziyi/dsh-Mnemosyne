import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ConsolidationStatusStore, type ConsolidationStatus, type ConsolidationStatusSnapshot } from './consolidation-status-store.js'
export type { ConsolidationStatus, ConsolidationStatusSnapshot } from './consolidation-status-store.js'

/** Live, process-local status used only by the browser status strip. */
export class ConsolidationStatusService extends TypertRemoteService {
  static inject: string[] = []
  private readonly store = new ConsolidationStatusStore()

  constructor(ctx: Context) {
    super(ctx, 'mnemosyneStatus')
    Object.defineProperty(Object.getPrototypeOf(this), '@deepseek-ai/dsh-typert-protocol/remote-methods', {
      configurable: true,
      value: Object.freeze({ version: 1, methods: Object.freeze([{
        method: 'get',
        invocation: Object.freeze({ kind: 'direct' }),
      }]) }),
    })
  }

  set(sessionId: string, status: ConsolidationStatus, turn: number): void {
    this.store.set(sessionId, status, turn)
  }

  clear(sessionId: string): void {
    this.store.clear(sessionId)
  }

  get(sessionId: string): ConsolidationStatusSnapshot | null {
    return this.store.get(sessionId)
  }
}
