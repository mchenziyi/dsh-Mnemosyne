import { describe, expect, it } from 'vitest'
import {
  predicateRun1_AutomaticCapture,
  predicateRun2_RestartPersistence,
  predicateRun3_Promotion,
  predicateRun4_CrossSessionReading,
  predicateRun5_ForgetAndGrantInvalidation,
  predicateRun6_ScopeIsolation,
} from '../src/m07b/predicates.js'
import { createRunStateSnapshot, createCanaryIdentityLedger, advanceCanaryIdentityLedger } from '../src/m07b/state-evidence.js'
import { createStrictSessionEvidence as createRawStrictSessionEvidence } from '../src/m07b/business-evidence.js'
import { canonicalJson, computeSha256 } from '../src/m07b/canary-protocol.js'

function createStrictSessionEvidence(params: Parameters<typeof createRawStrictSessionEvidence>[0]) {
  const tool_executions = params.tool_executions.map((execution) => {
    const result_binding = structuredClone(execution.result_binding)
    if (Array.isArray(result_binding.memory_refs)) {
      result_binding.memory_refs = result_binding.memory_refs.map(({ page_ref: _pageRef, ...ref }) => ref)
    }
    if (result_binding.memory_ref?.page_ref) {
      const { page_ref: _pageRef, ...ref } = result_binding.memory_ref
      result_binding.memory_ref = ref
    }
    return {
      ...execution,
      result_binding,
      result_sha256: computeSha256(canonicalJson(result_binding)),
    }
  })
  return createRawStrictSessionEvidence({ ...params, tool_executions })
}

describe('MVP-07B-I2 Phase I2-C: Six Complete Business Predicates', () => {
  const scopeA = 'sha256_' + 'a'.repeat(64)
  const scopeB = 'sha256_' + 'b'.repeat(64)
  const sessionA1 = 'session_a1_12345'
  const sessionA1Hash = computeSha256(sessionA1)
  const sessionA3 = 'session_a3_99999'
  const sessionA3Hash = computeSha256(sessionA3)

  const shortMemRef = {
    tier: 'short_term' as const,
    session_scope_id: sessionA1Hash,
    memory_id: 'mem_short_01',
    content_sha256: 'sha256_' + '1'.repeat(64),
    page_ref: 'wiki/memories/mem_short_01.md',
  }

  const longMemRef = {
    tier: 'long_term' as const,
    session_scope_id: null,
    memory_id: 'mem_long_01',
    content_sha256: 'sha256_' + '2'.repeat(64),
    page_ref: 'wiki/memories/mem_long_01.md',
  }

  it('rejects legacy v1 session evidence at predicate boundaries', async () => {
    const result = await predicateRun2_RestartPersistence({
      snapshotAfter: createRunStateSnapshot({
        run_id: 'run_2',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
      }),
      sessionEvidence: {
        schema_version: 1,
        tool_calls: [
          { tool_name: 'mnemosyne_status' },
          { tool_name: 'mnemosyne_search' },
        ],
      } as never,
      sourceShortMemoryId: shortMemRef.memory_id,
    })
    expect(result).toEqual({ pass: false, reason: 'invalid_session_evidence' })
  })

  describe('Predicate Run 1: Automatic Capture', async () => {
    it('passes when exactly 1 short-term fact added without mnemosyne_remember', async () => {
      const snapBefore = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
      })

      const snapAfter = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        short_term_refs: [shortMemRef],
        current_ref: {
          generation_id: 'gen_01',
          generation_sha256: 'sha256_' + '3'.repeat(64),
          manifest_id: 'manifest_01',
          manifest_sha256: 'sha256_' + '4'.repeat(64),
          index_sha256: 'sha256_' + '5'.repeat(64),
        },
        index_memory_refs: [shortMemRef],
      })

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_1',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_status'),
            tool_name: 'mnemosyne_status',
            argument_binding: {},
            result_status: 'ready',
            result_binding: { availability: 'ready', generation_id: 'gen_01', short_term_count: 1, long_term_count: 0, total_count: 1 },
            result_sha256: 'sha256_' + '6'.repeat(64),
          },
        ],
      })

      const result = await predicateRun1_AutomaticCapture({
        snapshotBefore: snapBefore,
        snapshotAfter: snapAfter,
        sessionEvidence,
        expectedSessionIdHash: sessionA1Hash,
      })

      expect(result.pass).toBe(true)
      expect(result.target_short_term_ref).toEqual(shortMemRef)
    })

    it('fails if mnemosyne_remember was directly called to fake capture', async () => {
      const snapBefore = createRunStateSnapshot({ run_id: 'run_1', project_scope_id: scopeA, session_id_sha256: sessionA1Hash })
      const snapAfter = createRunStateSnapshot({
        run_id: 'run_1',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        short_term_refs: [shortMemRef],
        current_ref: { generation_id: 'gen_01', generation_sha256: 'sha256_' + '3'.repeat(64), manifest_id: 'manifest_01', manifest_sha256: 'sha256_' + '4'.repeat(64), index_sha256: 'sha256_' + '5'.repeat(64) },
        index_memory_refs: [shortMemRef],
      })

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_1',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_rem'),
            tool_name: 'mnemosyne_remember',
            argument_binding: { title_sha256: 'sha256_' + '0'.repeat(64), summary_sha256: 'sha256_' + '0'.repeat(64), body_sha256: 'sha256_' + '0'.repeat(64), tag_count: 0 },
            result_status: 'created',
            result_binding: { status: 'created', memory_id: 'mem_short_01', content_sha256: 'sha256_' + '1'.repeat(64), generation_id: 'gen_01' },
            result_sha256: 'sha256_' + '7'.repeat(64),
          },
        ],
      })

      const result = await predicateRun1_AutomaticCapture({
        snapshotBefore: snapBefore,
        snapshotAfter: snapAfter,
        sessionEvidence,
        expectedSessionIdHash: sessionA1Hash,
      })

      expect(result.pass).toBe(false)
      expect(result.reason).toBe('manual_remember_forbidden_in_automatic_capture')
    })
  })

  describe('Predicate Run 2: Restart + Progressive Disclosure', async () => {
    it('passes when status -> list -> search -> open sequence is strictly followed and bound', async () => {
      const searchExec = {
        ordinal: 3,
        call_id_sha256: computeSha256('call_search'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('auth'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: {
          retrieval_id: 'retrieval_01',
          search_disclosure_sha256: 'sha256_' + '10'.repeat(32),
          generation_ref: null,
          memory_refs: [shortMemRef],
          contains_body: false,
        },
        result_sha256: 'sha256_' + '11'.repeat(32),
      }

      const openExec = {
        ordinal: 4,
        call_id_sha256: computeSha256('call_open'),
        tool_name: 'mnemosyne_open',
        argument_binding: {
          retrieval_id: 'retrieval_01',
          search_disclosure_sha256: 'sha256_' + '10'.repeat(32),
          memory_id: 'mem_short_01',
        },
        result_status: 'pass',
        result_binding: {
          open_disclosure_sha256: 'sha256_' + '12'.repeat(32),
          parent_disclosure_sha256: 'sha256_' + '10'.repeat(32),
          memory_ref: shortMemRef,
          body_sha256: 'sha256_' + '13'.repeat(32),
          body_present: true,
        },
        result_sha256: 'sha256_' + '14'.repeat(32),
      }

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_2',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_status'),
            tool_name: 'mnemosyne_status',
            argument_binding: {},
            result_status: 'ready',
            result_binding: { availability: 'ready', generation_id: 'gen_01', short_term_count: 1, long_term_count: 0, total_count: 1 },
            result_sha256: 'sha256_' + '15'.repeat(32),
          },
          {
            ordinal: 2,
            call_id_sha256: computeSha256('call_list'),
            tool_name: 'mnemosyne_list',
            argument_binding: { tier: 'all', include_inactive: false, limit: 50 },
            result_status: 'pass',
            result_binding: { memory_refs: [shortMemRef], total_count: 1, truncated: false, result_sha256: 'sha256_' + '16'.repeat(32) },
            result_sha256: 'sha256_' + '17'.repeat(32),
          },
          searchExec,
          openExec,
        ],
      })

      const snapAfter = createRunStateSnapshot({
        run_id: 'run_2',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        short_term_refs: [shortMemRef],
        current_ref: { generation_id: 'gen_01', generation_sha256: 'sha256_' + '3'.repeat(64), manifest_id: 'manifest_01', manifest_sha256: 'sha256_' + '4'.repeat(64), index_sha256: 'sha256_' + '5'.repeat(64) },
        index_memory_refs: [shortMemRef],
      })

      const result = await predicateRun2_RestartPersistence({
        snapshotAfter: snapAfter,
        sessionEvidence,
        targetMemoryId: 'mem_short_01',
        resumeReceipt: { run_id: 'run_2', same_session: true, resumed_session_id_sha256: sessionA1Hash, run_1_session_id_sha256: sessionA1Hash },
      })

      expect(result.pass).toBe(true)
      expect(result.open_body_sha256).toBe('sha256_' + '13'.repeat(32))
    })

    it('fails if open is missing or tool order is inverted', async () => {
      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_2',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_search'),
            tool_name: 'mnemosyne_search',
            argument_binding: { query_sha256: computeSha256('auth'), component_hint: null, top_k: 5 },
            result_status: 'pass',
            result_binding: { retrieval_id: 'retrieval_01', search_disclosure_sha256: 'sha256_' + '10'.repeat(32), generation_ref: null, memory_refs: [shortMemRef], contains_body: false },
            result_sha256: 'sha256_' + '11'.repeat(32),
          },
        ],
      })

      const snapAfter = createRunStateSnapshot({ run_id: 'run_2', project_scope_id: scopeA, session_id_sha256: sessionA1Hash })
      const result = await predicateRun2_RestartPersistence({
        snapshotAfter: snapAfter,
        sessionEvidence,
        targetMemoryId: 'mem_short_01',
        resumeReceipt: { run_id: 'run_2', same_session: true, resumed_session_id_sha256: sessionA1Hash, run_1_session_id_sha256: sessionA1Hash },
      })

      expect(result.pass).toBe(false)
      expect(result.reason).toBe('required_tool_sequence_missing_or_out_of_order')
    })
  })

  describe('Predicate Run 3: Promote + NOOP', async () => {
    it('passes when first promote succeeds, second is noop, and source is retained on disk', async () => {
      const snapBefore = createRunStateSnapshot({
        run_id: 'run_3',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [],
        current_ref: { generation_id: 'gen_01', generation_sha256: 'sha256_' + '3'.repeat(64), manifest_id: 'manifest_01', manifest_sha256: 'sha256_' + '4'.repeat(64), index_sha256: 'sha256_' + '5'.repeat(64) },
        index_memory_refs: [shortMemRef],
      })

      const snapAfter = createRunStateSnapshot({
        run_id: 'run_3',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        short_term_refs: [shortMemRef], // physical retention!
        long_term_refs: [longMemRef],
        current_ref: { generation_id: 'gen_02', generation_sha256: 'sha256_' + '6'.repeat(64), manifest_id: 'manifest_02', manifest_sha256: 'sha256_' + '7'.repeat(64), index_sha256: 'sha256_' + '8'.repeat(64) },
        index_memory_refs: [longMemRef], // only long-term in index!
      })

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_3',
        project_scope_id: scopeA,
        session_id_sha256: sessionA1Hash,
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_list'),
            tool_name: 'mnemosyne_list',
            argument_binding: { tier: 'all', include_inactive: false, limit: 50 },
            result_status: 'pass',
            result_binding: { memory_refs: [shortMemRef], total_count: 1, truncated: false, result_sha256: 'sha256_' + '16'.repeat(32) },
            result_sha256: 'sha256_' + '17'.repeat(32),
          },
          {
            ordinal: 2,
            call_id_sha256: computeSha256('call_promote_1'),
            tool_name: 'mnemosyne_promote',
            argument_binding: { memory_id: 'mem_short_01' },
            result_status: 'promoted',
            result_binding: { status: 'promoted', source_memory_id: 'mem_short_01', promoted_memory_id: 'mem_long_01', generation_id: 'gen_02' },
            result_sha256: 'sha256_' + '18'.repeat(32),
          },
          {
            ordinal: 3,
            call_id_sha256: computeSha256('call_promote_2'),
            tool_name: 'mnemosyne_promote',
            argument_binding: { memory_id: 'mem_short_01' },
            result_status: 'noop',
            result_binding: { status: 'noop', source_memory_id: 'mem_short_01', promoted_memory_id: 'mem_long_01', generation_id: 'gen_02' },
            result_sha256: 'sha256_' + '19'.repeat(32),
          },
        ],
      })

      const result = await predicateRun3_Promotion({
        snapshotBefore: snapBefore,
        snapshotAfter: snapAfter,
        sessionEvidence,
        sourceMemoryId: 'mem_short_01',
        resumeReceipt: { run_id: 'run_3', same_session: true, resumed_session_id_sha256: sessionA1Hash, run_1_session_id_sha256: sessionA1Hash },
      })

      expect(result.pass).toBe(true)
      expect(result.promoted_long_term_ref).toEqual(longMemRef)
    })
  })

  describe('Predicate Run 4: Cross-session Long-term Read', async () => {
    it('passes when new session A3 reads long-term memory without reusing old grant', async () => {
      const searchExec = {
        ordinal: 1,
        call_id_sha256: computeSha256('call_search_4'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('auth'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: {
          retrieval_id: 'retrieval_run4_fresh',
          search_disclosure_sha256: 'sha256_' + '20'.repeat(32),
          generation_ref: null,
          memory_refs: [longMemRef],
          contains_body: false,
        },
        result_sha256: 'sha256_' + '21'.repeat(32),
      }

      const openExec = {
        ordinal: 2,
        call_id_sha256: computeSha256('call_open_4'),
        tool_name: 'mnemosyne_open',
        argument_binding: {
          retrieval_id: 'retrieval_run4_fresh',
          search_disclosure_sha256: 'sha256_' + '20'.repeat(32),
          memory_id: 'mem_long_01',
        },
        result_status: 'pass',
        result_binding: {
          open_disclosure_sha256: 'sha256_' + '22'.repeat(32),
          parent_disclosure_sha256: 'sha256_' + '20'.repeat(32),
          memory_ref: longMemRef,
          body_sha256: 'sha256_' + '23'.repeat(32),
          body_present: true,
        },
        result_sha256: 'sha256_' + '24'.repeat(32),
      }

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_4',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        completed_turns: 1,
        tool_executions: [searchExec, openExec],
      })

      const snapAfter = createRunStateSnapshot({
        run_id: 'run_4',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [longMemRef],
        current_ref: { generation_id: 'gen_02', generation_sha256: 'sha256_' + '6'.repeat(64), manifest_id: 'manifest_02', manifest_sha256: 'sha256_' + '7'.repeat(64), index_sha256: 'sha256_' + '8'.repeat(64) },
        index_memory_refs: [longMemRef],
      })

      const result = await predicateRun4_CrossSessionReading({
        snapshotAfter: snapAfter,
        sessionEvidence,
        targetMemoryId: 'mem_long_01',
        sessionA1Hash,
        oldRetrievalId: 'retrieval_01',
      })

      expect(result.pass).toBe(true)
    })
  })

  describe('Predicate Run 5: Forget + Old Grant Invalidation', async () => {
    it('passes when forget succeeds, old grant fails to open, and second forget is noop', async () => {
      const search1 = {
        ordinal: 1,
        call_id_sha256: computeSha256('call_s1'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('auth'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: { retrieval_id: 'retrieval_5_1', search_disclosure_sha256: 'sha256_' + '30'.repeat(32), generation_ref: null, memory_refs: [longMemRef], contains_body: false },
        result_sha256: 'sha256_' + '31'.repeat(32),
      }

      const forget1 = {
        ordinal: 2,
        call_id_sha256: computeSha256('call_f1'),
        tool_name: 'mnemosyne_forget',
        argument_binding: { tier: 'long_term', memory_id: 'mem_long_01' },
        result_status: 'forgotten',
        result_binding: { status: 'forgotten', forget_id: 'forget_01', target_tier: 'long_term', target_memory_id: 'mem_long_01', generation_id: 'gen_03' },
        result_sha256: 'sha256_' + '32'.repeat(32),
      }

      const forget2 = {
        ordinal: 3,
        call_id_sha256: computeSha256('call_f2'),
        tool_name: 'mnemosyne_forget',
        argument_binding: { tier: 'long_term', memory_id: 'mem_long_01' },
        result_status: 'noop',
        result_binding: { status: 'noop', forget_id: null, target_tier: 'long_term', target_memory_id: 'mem_long_01', generation_id: 'gen_03' },
        result_sha256: 'sha256_' + '33'.repeat(32),
      }

      const search2 = {
        ordinal: 4,
        call_id_sha256: computeSha256('call_s2'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('auth'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: { retrieval_id: 'retrieval_5_2', search_disclosure_sha256: 'sha256_' + '34'.repeat(32), generation_ref: null, memory_refs: [], contains_body: false },
        result_sha256: 'sha256_' + '35'.repeat(32),
      }

      const sessionEvidence = createStrictSessionEvidence({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        completed_turns: 1,
        tool_executions: [search1, forget1, forget2, search2],
      })

      const snapAfter = createRunStateSnapshot({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [longMemRef], // physically retained!
        forget_refs: [{ forget_id: 'forget_01', target_memory_id: 'mem_long_01', target_tier: 'long_term', generation_id: 'gen_03' }],
        current_ref: { generation_id: 'gen_03', generation_sha256: 'sha256_' + '9'.repeat(64), manifest_id: 'manifest_03', manifest_sha256: 'sha256_' + 'a'.repeat(64), index_sha256: 'sha256_' + 'b'.repeat(64) },
        index_memory_refs: [], // index no longer discloses forgotten long-term!
      })

      const result = await predicateRun5_ForgetAndGrantInvalidation({
        snapshotAfter: snapAfter,
        sessionEvidence,
        targetMemoryId: 'mem_long_01',
      })

      expect(result.pass).toBe(true)
      expect(result.forget_ref?.forget_id).toBe('forget_01')
    })
  })

  describe('Predicate Run 6: Scope Isolation', async () => {
    it('passes when Project B has completely isolated scope and Project A remains unaltered', async () => {
      const snapA_Before = createRunStateSnapshot({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [longMemRef],
        forget_refs: [{ forget_id: 'forget_01', target_memory_id: 'mem_long_01', target_tier: 'long_term', generation_id: 'gen_03' }],
        current_ref: { generation_id: 'gen_03', generation_sha256: 'sha256_' + '9'.repeat(64), manifest_id: 'manifest_03', manifest_sha256: 'sha256_' + 'a'.repeat(64), index_sha256: 'sha256_' + 'b'.repeat(64) },
        index_memory_refs: [],
      })

      const snapA_After = createRunStateSnapshot({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [longMemRef],
        forget_refs: [{ forget_id: 'forget_01', target_memory_id: 'mem_long_01', target_tier: 'long_term', generation_id: 'gen_03' }],
        current_ref: { generation_id: 'gen_03', generation_sha256: 'sha256_' + '9'.repeat(64), manifest_id: 'manifest_03', manifest_sha256: 'sha256_' + 'a'.repeat(64), index_sha256: 'sha256_' + 'b'.repeat(64) },
        index_memory_refs: [],
      })

      const snapB = createRunStateSnapshot({
        run_id: 'run_6',
        project_scope_id: scopeB,
        session_id_sha256: computeSha256('session_b_1'),
        short_term_refs: [],
        long_term_refs: [],
        forget_refs: [],
        current_ref: null,
        index_memory_refs: [],
      })

      const sessionEvidenceB = createStrictSessionEvidence({
        run_id: 'run_6',
        project_scope_id: scopeB,
        session_id_sha256: computeSha256('session_b_1'),
        completed_turns: 1,
        tool_executions: [
          {
            ordinal: 1,
            call_id_sha256: computeSha256('call_status_b'),
            tool_name: 'mnemosyne_status',
            argument_binding: {},
            result_status: 'ready',
            result_binding: { availability: 'empty', generation_id: null, short_term_count: 0, long_term_count: 0, total_count: 0 },
            result_sha256: 'sha256_' + '40'.repeat(32),
          },
        ],
      })

      const result = await predicateRun6_ScopeIsolation({
        snapshotProjectA_Before: snapA_Before,
        snapshotProjectA_After: snapA_After,
        snapshotProjectB: snapB,
        sessionEvidenceB,
        projectScopeA: scopeA,
        projectScopeB: scopeB,
      })

      expect(result.pass).toBe(true)
    })

    it('fails if Project A state drifted during Run 6', async () => {
      const snapA_Before = createRunStateSnapshot({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [shortMemRef],
        long_term_refs: [longMemRef],
        forget_refs: [],
        current_ref: null,
        index_memory_refs: [],
      })

      const snapA_After = createRunStateSnapshot({
        run_id: 'run_5',
        project_scope_id: scopeA,
        session_id_sha256: sessionA3Hash,
        short_term_refs: [], // Tampered!
        long_term_refs: [longMemRef],
        forget_refs: [],
        current_ref: null,
        index_memory_refs: [],
      })

      const snapB = createRunStateSnapshot({
        run_id: 'run_6',
        project_scope_id: scopeB,
        session_id_sha256: computeSha256('session_b_1'),
      })

      const sessionEvidenceB = createStrictSessionEvidence({
        run_id: 'run_6',
        project_scope_id: scopeB,
        session_id_sha256: computeSha256('session_b_1'),
        completed_turns: 1,
        tool_executions: [],
      })

      const result = await predicateRun6_ScopeIsolation({
        snapshotProjectA_Before: snapA_Before,
        snapshotProjectA_After: snapA_After,
        snapshotProjectB: snapB,
        sessionEvidenceB,
        projectScopeA: scopeA,
        projectScopeB: scopeB,
      })

      expect(result.pass).toBe(false)
      expect(result.reason).toBe('project_a_state_drifted_during_run_6')
    })
  })
})
