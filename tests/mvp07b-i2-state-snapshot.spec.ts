import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  createRunStateSnapshot,
  captureRunStateSnapshot,
  validateRunStateSnapshot,
  computeRunStateSnapshotSha256,
  computeFactDiff,
  createCanaryIdentityLedger,
  advanceCanaryIdentityLedger,
  validateCanaryIdentityLedger,
  type RunStateSnapshot,
  type CanaryIdentityLedger,
} from '../src/m07b/state-evidence.js'
import { computeSha256, computeProjectScopeId } from '../src/m07b/canary-protocol.js'
import { openMemoryFactStore } from '../src/memory-store.js'
import { createOKFCompiler } from '../src/okf-compiler.js'
import { createCandidateWriter } from '../src/candidate-writer.js'

describe('MVP-07B-I2 Phase I2-B: State Snapshot & CanaryIdentityLedger', () => {
  const dummyProjectScopeId = 'sha256_' + '1'.repeat(64)
  const dummySessionId = 'session_test_abc123'
  const dummySessionIdHash = computeSha256(dummySessionId)

  describe('1. RunStateSnapshot Creation & Schema Validation', () => {
    it('creates and validates a canonical RunStateSnapshot with deterministic hash', () => {
      const snapshot = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: dummyProjectScopeId,
        session_id_sha256: dummySessionIdHash,
        short_term_refs: [
          {
            tier: 'short_term',
            session_scope_id: dummySessionIdHash,
            memory_id: 'mem_short_01',
            content_sha256: 'sha256_' + 'a'.repeat(64),
            page_ref: 'wiki/memories/mem_short_01.md',
          },
        ],
        long_term_refs: [],
        forget_refs: [],
        current_ref: {
          generation_id: 'gen_' + '1'.repeat(32),
          generation_sha256: 'sha256_' + 'b'.repeat(64),
          manifest_id: 'manifest_' + '1'.repeat(32),
          manifest_sha256: 'sha256_' + 'c'.repeat(64),
          index_sha256: 'sha256_' + 'd'.repeat(64),
        },
        index_memory_refs: [
          {
            tier: 'short_term',
            session_scope_id: dummySessionIdHash,
            memory_id: 'mem_short_01',
            content_sha256: 'sha256_' + 'a'.repeat(64),
            page_ref: 'wiki/memories/mem_short_01.md',
          },
        ],
      })

      expect(snapshot.snapshot_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
      expect(validateRunStateSnapshot(snapshot)).toEqual(snapshot)
    })

    it('rejects tampered snapshot_sha256 or unknown fields', () => {
      const snapshot = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: dummyProjectScopeId,
        session_id_sha256: dummySessionIdHash,
        short_term_refs: [],
        long_term_refs: [],
        forget_refs: [],
        current_ref: null,
        index_memory_refs: [],
      })

      expect(() => validateRunStateSnapshot({ ...snapshot, snapshot_sha256: 'sha256_' + '0'.repeat(64) })).toThrow('invalid_snapshot_hash')
      expect(() => validateRunStateSnapshot({ ...snapshot, malicious_extra_field: true } as any)).toThrow('invalid_snapshot')
    })
  })

  describe('2. Live Capture from Real .dsh-mnemosyne Store', () => {
    it('captures accurate snapshot from store and compiler', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'state_test_'))
      const realProjectRoot = await realpath(tempDir)
      try {
        const projectScopeId = computeProjectScopeId(realProjectRoot)
        const store = openMemoryFactStore({ project_root: realProjectRoot, project_scope_id: projectScopeId })
        const compiler = createOKFCompiler()
        const writer = createCandidateWriter({
          storeFactory: () => store,
          compiler,
        })

        const cand = {
          schema_version: 1 as const,
          decision: 'remember' as const,
          title: 'Testing Storage Snapshot',
          summary: 'Summary of candidate',
          body: 'Body content of candidate memory.',
          tags: ['test', 'storage'],
        }
        const createdAt = new Date().toISOString()
        const eventKey = 'event_key_test_01'
        const candidateSha256 = 'sha256_' + 'e'.repeat(64)
        const memoryId = 'mem_' + 'f'.repeat(32)

        const writeRes = await writer.write({
          source: 'auto',
          candidate: cand,
          scope: {
            schema_version: 1,
            session_id: dummySessionId,
            project_root: realProjectRoot,
            project_scope_id: projectScopeId,
            session_scope_id: dummySessionIdHash,
            source: 'session_header',
          },
          eventKey,
          candidateSha256,
          memoryId,
          createdAt,
        })

        expect(writeRes.status).toBe('created')

        const captured = await captureRunStateSnapshot({
          runId: 'run_1',
          projectRoot: realProjectRoot,
          sessionId: dummySessionId,
        })

        expect(captured.run_id).toBe('run_1')
        expect(captured.project_scope_id).toBe(projectScopeId)
        expect(captured.session_id_sha256).toBe(dummySessionIdHash)
        expect(captured.short_term_refs).toHaveLength(1)
        expect(captured.short_term_refs[0].memory_id).toBe(writeRes.memory_id)
        expect(captured.current_ref).not.toBeNull()
        expect(captured.current_ref?.generation_id).toBe(writeRes.generation_id)
        expect(captured.index_memory_refs).toHaveLength(1)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('computes exact fact differences between before and after snapshots', () => {
      const snap0 = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: dummyProjectScopeId,
        session_id_sha256: dummySessionIdHash,
        short_term_refs: [],
        long_term_refs: [],
        forget_refs: [],
        current_ref: null,
        index_memory_refs: [],
      })

      const snap1 = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: dummyProjectScopeId,
        session_id_sha256: dummySessionIdHash,
        short_term_refs: [
          {
            tier: 'short_term',
            session_scope_id: dummySessionIdHash,
            memory_id: 'mem_short_01',
            content_sha256: 'sha256_' + 'a'.repeat(64),
            page_ref: 'wiki/memories/mem_short_01.md',
          },
        ],
        long_term_refs: [],
        forget_refs: [],
        current_ref: {
          generation_id: 'gen_01',
          generation_sha256: 'sha256_' + '1'.repeat(64),
          manifest_id: 'manifest_01',
          manifest_sha256: 'sha256_' + '2'.repeat(64),
          index_sha256: 'sha256_' + '3'.repeat(64),
        },
        index_memory_refs: [
          {
            tier: 'short_term',
            session_scope_id: dummySessionIdHash,
            memory_id: 'mem_short_01',
            content_sha256: 'sha256_' + 'a'.repeat(64),
            page_ref: 'wiki/memories/mem_short_01.md',
          },
        ],
      })

      const diff = computeFactDiff(snap0, snap1)
      expect(diff.added_short_term).toHaveLength(1)
      expect(diff.added_short_term[0].memory_id).toBe('mem_short_01')
      expect(diff.added_long_term).toHaveLength(0)
      expect(diff.added_forget).toHaveLength(0)
      expect(diff.current_changed).toBe(true)
    })
  })

  describe('3. CanaryIdentityLedger Cross-Run Immutability', () => {
    it('initializes and advances ledger across 6 runs with deterministic identity chain', () => {
      let ledger = createCanaryIdentityLedger({
        project_scope_a: dummyProjectScopeId,
        project_scope_b: 'sha256_' + '2'.repeat(64),
      })

      expect(ledger.run_1_short_term_ref).toBeNull()

      // Advance Run 1
      const shortRef = {
        tier: 'short_term' as const,
        session_scope_id: dummySessionIdHash,
        memory_id: 'mem_short_01',
        content_sha256: 'sha256_' + 'a'.repeat(64),
        page_ref: 'wiki/memories/mem_short_01.md',
      }
      ledger = advanceCanaryIdentityLedger(ledger, 'run_1', {
        session_id_sha256: dummySessionIdHash,
        short_term_ref: shortRef,
      })

      expect(ledger.run_1_short_term_ref).toEqual(shortRef)
      expect(ledger.session_a1_sha256).toBe(dummySessionIdHash)

      // Advance Run 2
      ledger = advanceCanaryIdentityLedger(ledger, 'run_2', {
        search_retrieval_id: 'retrieval_100',
        search_disclosure_sha256: 'sha256_' + 'b'.repeat(64),
        open_body_sha256: 'sha256_' + 'c'.repeat(64),
      })

      expect(ledger.run_2_retrieval_id).toBe('retrieval_100')

      // Advance Run 3 (Promote)
      const longRef = {
        tier: 'long_term' as const,
        session_scope_id: null,
        memory_id: 'mem_long_01',
        content_sha256: 'sha256_' + 'd'.repeat(64),
        page_ref: 'wiki/memories/mem_long_01.md',
      }
      ledger = advanceCanaryIdentityLedger(ledger, 'run_3', {
        promoted_long_term_ref: longRef,
      })
      expect(ledger.run_3_promoted_long_term_ref).toEqual(longRef)

      // Advance Run 4
      const sessionA3Hash = 'sha256_' + '3'.repeat(64)
      ledger = advanceCanaryIdentityLedger(ledger, 'run_4', {
        session_a3_sha256: sessionA3Hash,
      })
      expect(ledger.session_a3_sha256).toBe(sessionA3Hash)

      // Advance Run 5 (Forget)
      ledger = advanceCanaryIdentityLedger(ledger, 'run_5', {
        forget_ref: {
          forget_id: 'forget_01',
          target_memory_id: 'mem_long_01',
          target_tier: 'long_term',
          generation_id: 'gen_05',
        },
      })
      expect(ledger.run_5_forget_ref?.forget_id).toBe('forget_01')

      // Advance Run 6 (Scope Isolation)
      ledger = advanceCanaryIdentityLedger(ledger, 'run_6', {
        project_b_isolated: true,
      })
      expect(ledger.run_6_project_b_isolated).toBe(true)

      expect(validateCanaryIdentityLedger(ledger)).toEqual(ledger)
    })

    it('rejects misspelled, missing, and extra ledger transition fields', () => {
      const ledger = createCanaryIdentityLedger({
        project_scope_a: dummyProjectScopeId,
        project_scope_b: 'sha256_' + '2'.repeat(64),
      })
      const shortRef = {
        tier: 'short_term' as const,
        session_scope_id: dummySessionIdHash,
        memory_id: 'mem_short_01',
        content_sha256: 'sha256_' + 'a'.repeat(64),
        page_ref: 'wiki/memories/mem_short_01.md',
      }

      expect(() => advanceCanaryIdentityLedger(ledger, 'run_1', {
        session_a1_sha256: dummySessionIdHash,
        source_short_term_ref: shortRef,
      } as never)).toThrow('invalid_ledger_update')
      expect(() => advanceCanaryIdentityLedger(ledger, 'run_1', {
        session_id_sha256: dummySessionIdHash,
      } as never)).toThrow('invalid_ledger_update')
      expect(() => advanceCanaryIdentityLedger(ledger, 'run_1', {
        session_id_sha256: dummySessionIdHash,
        short_term_ref: shortRef,
        extra: true,
      } as never)).toThrow('invalid_ledger_update')
    })
  })
})
