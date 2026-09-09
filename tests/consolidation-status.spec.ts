import { describe, expect, it } from 'vitest'
import { ConsolidationStatusStore } from '../src/consolidation-status-store.js'

describe('consolidation status store', () => {
  it('keeps status isolated by session and replaces it at completion', () => {
    const store = new ConsolidationStatusStore()
    store.set('session-a', 'running', 2)
    expect(store.get('session-b')).toBeNull()
    expect(store.get('session-a')?.status).toBe('running')
    store.set('session-a', 'created', 2)
    expect(store.get('session-a')?.status).toBe('created')
    store.clear('session-a')
    expect(store.get('session-a')).toBeNull()
  })

  it('clears only the disposed session and tolerates repeated cleanup', () => {
    const store = new ConsolidationStatusStore()
    store.set('session-a', 'running', 1)
    store.set('session-b', 'created', 1)
    store.clear('session-a')
    store.clear('session-a')
    expect(store.get('session-a')).toBeNull()
    expect(store.get('session-b')?.status).toBe('created')
  })
})
