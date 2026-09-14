import { constants } from 'node:fs'
import { open, lstat, rename, unlink, link, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertExactKeys, assertHash, canonicalBytes, canonicalHash, ProtocolValidationError } from '../protocol/canonical.js'
import {
  canonicalizeGovernanceEventV1,
  computeGovernanceEventIdV1,
  createGovernanceEventV1,
  validateGovernanceEventV1,
  type GovernanceEventDraftV1,
  type GovernanceEventV1,
  type GovernanceHeadV1,
  type GovernanceMemoryRecordV1,
  validateGovernanceEventRefV1,
} from '../protocol/governance.js'
import { checkPathHierarchy, ensureDirectoryChain, validateProjectRoot, validateScopeId } from '../memory-store-path.js'
import { replayGovernanceV1, type GovernanceReplayResultV1 } from './replay.js'
import { syncDirectory } from '../generation-store.js'

export interface GovernanceCommitSnapshotV1 { token: string; project_scope_id: string; head: GovernanceHeadV1 | null }
export interface GovernanceCurrentBoundaryV1 {
  withExclusive<T>(operation: () => Promise<T>): Promise<T>
  read(): Promise<GovernanceCommitSnapshotV1>
  compareAndSwitch(expected: GovernanceCommitSnapshotV1, next: GovernanceHeadV1): Promise<void>
}
export interface GovernanceLedgerStoreV1 {
  writeEventExclusive(event: GovernanceEventV1): Promise<void>
  readEvent(ref: { event_id: string; event_sha256: string }): Promise<GovernanceEventV1>
  loadCommittedChain(head: GovernanceHeadV1 | null): Promise<GovernanceEventV1[]>
  commit(input: GovernanceCommitInputV1): Promise<{ event: GovernanceEventV1; head: GovernanceHeadV1; replay: GovernanceReplayResultV1 }>
}
export interface GovernanceCommitInputV1 extends Omit<GovernanceEventDraftV1, 'sequence' | 'prev_event_hash'> {
  memories: readonly GovernanceMemoryRecordV1[]
}

function fail(message: string): never { throw new ProtocolValidationError(message) }
function eventPath(root: string, id: string): string { return join(root, '.dsh-mnemosyne', 'v2', 'governance', 'events', `${id}.json`) }

async function strictRead(root: string, path: string): Promise<string> {
  await checkPathHierarchy(root, path, true)
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) fail('unsafe_event_file')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile()) fail('event_replaced')
    const bytes = await handle.readFile()
    const after = await lstat(path)
    if (after.dev !== stat.dev || after.ino !== stat.ino || bytes.length !== stat.size) fail('event_replaced')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { await handle.close() }
}

export function openGovernanceLedgerStore(options: { project_root: string; project_scope_id: string; current: GovernanceCurrentBoundaryV1 }): GovernanceLedgerStoreV1 {
  const configuredRoot = options.project_root
  const scope = validateScopeId(options.project_scope_id)
  const current = options.current
  const root = async () => {
    const resolved = await validateProjectRoot(configuredRoot)
    return resolved
  }
  const readEvent = async (ref: { event_id: string; event_sha256: string }): Promise<GovernanceEventV1> => {
    const projectRoot = await root()
    if (ref.event_id !== computeGovernanceEventIdV1(ref.event_sha256)) fail('event_identity_mismatch')
    const path = eventPath(projectRoot, ref.event_id)
    let text: string
    try { text = await strictRead(projectRoot, path) } catch (error) { throw error }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { fail('event_decode_failed') }
    const event = validateGovernanceEventV1(parsed)
    if (event.project_scope_id !== scope || event.event_id !== ref.event_id || event.event_sha256 !== ref.event_sha256 || text !== canonicalizeGovernanceEventV1(event)) fail('event_identity_mismatch')
    return structuredClone(event)
  }
  const writeEventExclusive = async (event: GovernanceEventV1): Promise<void> => {
    const projectRoot = await root()
    const checked = validateGovernanceEventV1(event)
    if (checked.project_scope_id !== scope) fail('event_scope_mismatch')
    const target = eventPath(projectRoot, checked.event_id)
    await ensureDirectoryChain(projectRoot, dirname(target))
    const tmpDir = join(projectRoot, '.dsh-mnemosyne', 'v2', 'tmp')
    await ensureDirectoryChain(projectRoot, tmpDir)
    const tmp = join(tmpDir, `tmp_governance_event_${randomUUID()}.tmp`)
    const canonical = canonicalBytes(checked)
    let handle
    try {
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      await handle.writeFile(canonical, 'utf8'); await handle.sync(); await handle.close(); handle = undefined
      const roundTrip = JSON.parse(await strictRead(projectRoot, tmp))
      if (canonicalizeGovernanceEventV1(roundTrip) !== canonical) fail('event_readback_mismatch')
      await link(tmp, target)
      await syncDirectory(dirname(target))
      const stored = await readEvent({ event_id: checked.event_id, event_sha256: checked.event_sha256 })
      if (stored.event_sha256 !== checked.event_sha256) fail('event_readback_mismatch')
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined); await unlink(tmp).catch(() => undefined)
      if ((error as { code?: string }).code === 'EEXIST') fail('event_already_exists')
      throw error
    }
    await unlink(tmp).catch(() => undefined)
    await syncDirectory(tmpDir)
  }
  const loadCommittedChain = async (head: GovernanceHeadV1 | null): Promise<GovernanceEventV1[]> => {
    if (head === null) return []
    const reverse: GovernanceEventV1[] = []
    let cursor: GovernanceHeadV1 | null = head
    const seen = new Set<string>()
    while (cursor) {
      if (seen.has(cursor.event_id)) fail('chain_cycle')
      seen.add(cursor.event_id)
      const event = await readEvent(cursor)
      if (event.sequence !== cursor.sequence || event.project_scope_id !== scope) fail('chain_head_mismatch')
      reverse.push(event)
      cursor = event.prev_event_hash === null ? null : { sequence: event.sequence - 1, event_id: computeGovernanceEventIdV1(event.prev_event_hash), event_sha256: event.prev_event_hash }
      if (event.sequence === 1 && event.prev_event_hash !== null) fail('broken_genesis')
      if (event.sequence > 1 && event.prev_event_hash === null) fail('broken_parent')
    }
    return reverse.reverse()
  }
  return {
    writeEventExclusive,
    readEvent,
    loadCommittedChain,
    async commit(input) {
      return current.withExclusive(async () => {
      const projectRoot = await root(); void projectRoot
      const snapshot = await current.read()
      if (snapshot.project_scope_id !== scope) fail('current_scope_mismatch')
      const chain = await loadCommittedChain(snapshot.head)
      replayGovernanceV1({ project_scope_id: scope, memories: input.memories, events: chain })
      const sequence = snapshot.head ? snapshot.head.sequence + 1 : 1
      const draft: GovernanceEventDraftV1 = { schema_version: 1, project_scope_id: scope, sequence, prev_event_hash: snapshot.head?.event_sha256 ?? null, payload: input.payload, evidence_refs: input.evidence_refs, reason_code: input.reason_code, created_at: input.created_at }
      const event = createGovernanceEventV1(draft)
      await writeEventExclusive(event)
      const candidateChain = [...chain, await readEvent(event)]
      const replay = replayGovernanceV1({ project_scope_id: scope, memories: input.memories, events: candidateChain })
      const latest = await current.read()
      if (latest.token !== snapshot.token || latest.project_scope_id !== scope || JSON.stringify(latest.head) !== JSON.stringify(snapshot.head)) fail('current_changed')
      const next: GovernanceHeadV1 = { sequence: event.sequence, event_id: event.event_id, event_sha256: event.event_sha256 }
      await current.compareAndSwitch(snapshot, next)
      return { event, head: next, replay }
      })
    },
  }
}

export interface GovernanceCurrentFixtureV1 { schema_version: 1; project_scope_id: string; governance_head: GovernanceHeadV1 | null }
export function createMemoryCurrentBoundary(project_scope_id: string, initialHead: GovernanceHeadV1 | null = null): GovernanceCurrentBoundaryV1 {
  let value: GovernanceCurrentFixtureV1 = { schema_version: 1, project_scope_id, governance_head: initialHead }
  let token = canonicalHash(value)
  let tail = Promise.resolve()
  return {
    async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail
      let resolveTail!: () => void
      tail = new Promise<void>((resolve) => { resolveTail = resolve })
      await previous
      try { return await operation() } finally { resolveTail() }
    },
    async read() { return { token, project_scope_id, head: structuredClone(value.governance_head) } },
    async compareAndSwitch(expected, next) {
      if (token !== expected.token) fail('current_changed')
      value = { schema_version: 1, project_scope_id, governance_head: structuredClone(next) }; token = canonicalHash(value)
    },
  }
}

/** Isolated CURRENT boundary for Slice 3 fixtures. Slice 4 will provide the production manifest adapter. */
export function openFileGovernanceCurrentBoundary(options: { project_root: string; project_scope_id: string; current_path: string }): GovernanceCurrentBoundaryV1 {
  const scope = validateScopeId(options.project_scope_id)
  const path = options.current_path
  let tail = Promise.resolve()
  const empty = (): GovernanceCurrentFixtureV1 => ({ schema_version: 1, project_scope_id: scope, governance_head: null })
  const readValue = async (): Promise<{ value: GovernanceCurrentFixtureV1; token: string }> => {
    const root = await validateProjectRoot(options.project_root)
    await checkPathHierarchy(root, path, true)
    let text: string
    try { text = await readFile(path, 'utf8') } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') { const value = empty(); return { value, token: canonicalHash(value) } }
      throw error
    }
    const parsed = JSON.parse(text) as Record<string, unknown>
    assertExactKeys(parsed, ['schema_version', 'project_scope_id', 'governance_head'])
    if (parsed.schema_version !== 1 || parsed.project_scope_id !== scope) fail('current_invalid')
    let head: GovernanceHeadV1 | null = null
    if (parsed.governance_head !== null) {
      assertExactKeys(parsed.governance_head, ['sequence', 'event_id', 'event_sha256'])
      const raw = parsed.governance_head as Record<string, unknown>
      const sequence = raw.sequence as number
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail('current_invalid')
      head = { sequence, ...validateGovernanceEventRefV1({ event_id: raw.event_id, event_sha256: raw.event_sha256 }) }
    }
    const value = { schema_version: 1 as const, project_scope_id: scope, governance_head: head }
    if (text !== canonicalBytes(value)) fail('current_noncanonical')
    return { value, token: canonicalHash(value) }
  }
  return {
    async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail; let release!: () => void
      tail = new Promise<void>((resolve) => { release = resolve }); await previous
      const root = await validateProjectRoot(options.project_root)
      const dir = dirname(path); await ensureDirectoryChain(root, dir)
      const lockPath = `${path}.lock`
      let lock
      try {
        lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        await lock.close(); lock = undefined
        return await operation()
      } finally {
        await lock?.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        release()
      }
    },
    async read() { const current = await readValue(); return { token: current.token, project_scope_id: scope, head: structuredClone(current.value.governance_head) } },
    async compareAndSwitch(expected, next) {
      const actual = await readValue()
      if (actual.token !== expected.token || JSON.stringify(actual.value.governance_head) !== JSON.stringify(expected.head)) fail('current_changed')
      const root = await validateProjectRoot(options.project_root)
      const dir = dirname(path); await ensureDirectoryChain(root, dir)
      const temp = join(dir, `.current_${randomUUID()}.tmp`)
      const bytes = canonicalBytes({ schema_version: 1 as const, project_scope_id: scope, governance_head: next })
      let handle
      try { handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, path); await syncDirectory(dir) }
      finally { await handle?.close().catch(() => undefined); await unlink(temp).catch(() => undefined) }
      await readValue()
    },
  }
}
