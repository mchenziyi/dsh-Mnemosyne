import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ConsolidationStatusSnapshot } from './consolidation-status-store.js'

const sessionIdSchema = {
  parse(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('invalid_session_id')
    return value
  },
}

const statusSchema = {
  parse(value: unknown): ConsolidationStatusSnapshot | null {
    if (value === null) return null
    if (typeof value !== 'object'
      || !('status' in value) || !('turn' in value) || !('updatedAt' in value)
      || (value.status !== 'running' && value.status !== 'created' && value.status !== 'skipped' && value.status !== 'failed')
      || typeof value.turn !== 'number' || !Number.isInteger(value.turn) || value.turn < 0
      || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
      throw new TypeError('invalid_consolidation_status')
    }
    return { status: value.status, turn: value.turn, updatedAt: value.updatedAt }
  },
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@cziyi/dsh-mnemosyne',
  descriptors: [{
    id: '@cziyi/dsh-mnemosyne#mnemosyneStatus/get',
    service: 'mnemosyneStatus',
    namespace: 'mnemosyneStatus',
    method: 'get',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'string', schema: sessionIdSchema,
    } }],
    result: {
      mode: 'strict', typeSymbol: '@cziyi/dsh-mnemosyne#ConsolidationStatusSnapshot|null', schema: statusSchema,
    },
  }],
}

export default TYPERT_REMOTE
