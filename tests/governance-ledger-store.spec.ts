import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProtocolValidationError } from '../src/protocol/canonical.js'
import { createGovernanceEventV1, type GovernanceMemoryRecordV1 } from '../src/protocol/governance.js'
import { createMemoryCurrentBoundary, openFileGovernanceCurrentBoundary, openGovernanceLedgerStore } from '../src/governance/ledger-store.js'

const PROJECT = `sha256_${'a'.repeat(64)}`
const A = { memory_id: 'mem_a', content_sha256: `sha256_${'1'.repeat(64)}` }
const B = { memory_id: 'mem_b', content_sha256: `sha256_${'2'.repeat(64)}` }

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.tmp-mnemosyne-ledger-'))
  const current = createMemoryCurrentBoundary(PROJECT)
  const store = openGovernanceLedgerStore({ project_root: root, project_scope_id: PROJECT, current })
  return { root, current, store, memories: [{ ...A, project_scope_id: PROJECT }, { ...B, project_scope_id: PROJECT }] as GovernanceMemoryRecordV1[] }
}

describe('Governance Ledger Store Slice 3', () => {
  it('commits one direct child and loads only the CURRENT-reachable chain', async () => {
    const f = await fixture()
    try {
      const first = await f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'deactivate', memory: A }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:00.000Z', memories: f.memories })
      const second = await f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'reactivate', memory: A, deactivate_event: { event_id: first.event.event_id, event_sha256: first.event.event_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:01.000Z', memories: f.memories })
      expect((await f.store.loadCommittedChain(second.head)).map((event) => event.sequence)).toEqual([1, 2])
      expect((await f.current.read()).head).toEqual(second.head)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('leaves an exclusive candidate orphan and never reuses it', async () => {
    const f = await fixture()
    try {
      const orphan = createGovernanceEventV1({ schema_version: 1, project_scope_id: PROJECT, sequence: 1, prev_event_hash: null, payload: { action: 'deactivate', memory: { memory_id: A.memory_id, content_sha256: A.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'orphan', created_at: '2026-09-11T00:00:00.000Z' })
      await f.store.writeEventExclusive(orphan)
      expect(await f.store.loadCommittedChain(null)).toEqual([])
      await expect(f.store.writeEventExclusive(orphan)).rejects.toThrow(ProtocolValidationError)
      const committed = await f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'deactivate', memory: A }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'new', created_at: '2026-09-11T00:00:01.000Z', memories: f.memories })
      expect(committed.event.event_id).not.toBe(orphan.event_id)
      expect((await f.store.loadCommittedChain(committed.head)).map((event) => event.event_id)).toEqual([committed.event.event_id])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects tampering and project-scope crossover', async () => {
    const f = await fixture()
    try {
      const result = await f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'deactivate', memory: { memory_id: A.memory_id, content_sha256: A.content_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:00.000Z', memories: f.memories })
      const path = join(f.root, '.dsh-mnemosyne', 'v2', 'governance', 'events', `${result.event.event_id}.json`)
      await writeFile(path, `${await readFile(path, 'utf8')} `, { mode: 0o600 })
      await expect(f.store.readEvent(result.event)).rejects.toThrow(ProtocolValidationError)
      const other = openGovernanceLedgerStore({ project_root: f.root, project_scope_id: `sha256_${'b'.repeat(64)}`, current: createMemoryCurrentBoundary(`sha256_${'b'.repeat(64)}`) })
      await expect(other.readEvent(result.event)).rejects.toThrow(ProtocolValidationError)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects a lost CURRENT update before switching', async () => {
    const f = await fixture()
    try {
      const first = await f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'deactivate', memory: A }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'test', created_at: '2026-09-11T00:00:00.000Z', memories: f.memories })
      const snapshot = await f.current.read()
      await f.current.compareAndSwitch(snapshot, { sequence: 2, event_id: first.event.event_id, event_sha256: first.event.event_sha256 })
      await expect(f.store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'reactivate', memory: A, deactivate_event: { event_id: first.event.event_id, event_sha256: first.event.event_sha256 } }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'stale', created_at: '2026-09-11T00:00:01.000Z', memories: f.memories })).rejects.toThrow(ProtocolValidationError)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('uses an isolated file CURRENT with atomic replacement and a filesystem lock', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp-mnemosyne-current-'))
    try {
      const current = openFileGovernanceCurrentBoundary({ project_root: root, project_scope_id: PROJECT, current_path: join(root, 'fixture', 'CURRENT') })
      const store = openGovernanceLedgerStore({ project_root: root, project_scope_id: PROJECT, current })
      const committed = await store.commit({ schema_version: 1, project_scope_id: PROJECT, payload: { action: 'deactivate', memory: A }, evidence_refs: [{ kind: 'memory', memory_id: A.memory_id, content_sha256: A.content_sha256 }], reason_code: 'file', created_at: '2026-09-11T00:00:00.000Z', memories: [{ ...A, project_scope_id: PROJECT }, { ...B, project_scope_id: PROJECT }] })
      expect((await current.read()).head).toEqual(committed.head)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
