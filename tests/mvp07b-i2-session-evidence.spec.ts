import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  extractStrictSessionEvidence,
  validateStrictSessionEvidence,
  computeSessionEvidenceSha256,
  createStrictSessionEvidence,
  writeStrictSessionEvidence,
  readStrictSessionEvidence,
  validateSearchOpenBinding,
  type StrictSessionEvidence,
  type ToolExecutionEvidence,
} from '../src/m07b/business-evidence.js'
import { computeSha256 } from '../src/m07b/canary-protocol.js'
import {
  canonicalizeSearchDisclosure,
  canonicalizeOpenDisclosure,
  computeRetrievalId,
} from '../src/protocol/okf-retrieval.js'

describe('MVP-07B-I2 Phase I2-A: Strict Session Evidence v2', () => {
  const dummyProjectScopeId = 'sha256_' + '1'.repeat(64)
  const dummySessionId = 'session_test_abc123'
  const dummySessionIdHash = computeSha256(dummySessionId)

  const makeValidStatusOutput = () =>
    JSON.stringify({
      plugin: 'dsh-Mnemosyne',
      version: '0.0.0-dev',
      protocol_version: 3,
      memory_enabled: true,
      status: 'ready',
      scope: {
        status: 'ready',
        source: 'session_header',
        project_scope_id: dummyProjectScopeId,
        session_scope_id: dummySessionIdHash,
        reason: null,
      },
      memory: {
        availability: 'ready',
        generation_id: 'gen_01',
        short_term_count: 1,
        long_term_count: 0,
        total_count: 1,
        reason: null,
      },
    })

  describe('1. Call/Result 1:1 Exact Binding and Sequencing', () => {
    it('rejects events when a tool result has no prior tool call (orphan result)', () => {
      const rawEvents = [
        {
          type: 'tool/result',
          data: {
            callId: 'call_orphan_1',
            message: {
              callId: 'call_orphan_1',
              content: [{ type: 'text', text: makeValidStatusOutput() }],
            },
          },
        },
      ]

      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('orphan_tool_result')
    })

    it('rejects events when a tool call has duplicate results', () => {
      const statusOutput = makeValidStatusOutput()
      const rawEvents = [
        {
          type: 'tool/call',
          data: { callId: 'call_status_1', name: 'mnemosyne_status', args: {} },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'call_status_1',
            message: { callId: 'call_status_1', content: [{ type: 'text', text: statusOutput }] },
          },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'call_status_1',
            message: { callId: 'call_status_1', content: [{ type: 'text', text: statusOutput }] },
          },
        },
      ]

      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('duplicate_tool_result')
    })

    it('rejects events when a tool call has no matching result (unresolved call)', () => {
      const rawEvents = [
        {
          type: 'tool/call',
          data: { callId: 'call_unresolved_1', name: 'mnemosyne_status', args: {} },
        },
        {
          type: 'turn/end',
          data: { status: 'completed' },
        },
      ]

      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('unresolved_tool_call')
    })

    it('rejects duplicate tool call IDs within the same session', () => {
      const statusOutput = makeValidStatusOutput()
      const rawEvents = [
        {
          type: 'tool/call',
          data: { callId: 'call_same_id', name: 'mnemosyne_status', args: {} },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'call_same_id',
            message: { callId: 'call_same_id', content: [{ type: 'text', text: statusOutput }] },
          },
        },
        {
          type: 'tool/call',
          data: { callId: 'call_same_id', name: 'mnemosyne_status', args: {} },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'call_same_id',
            message: { callId: 'call_same_id', content: [{ type: 'text', text: statusOutput }] },
          },
        },
      ]

      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('duplicate_call_id')
    })

    it('rejects unknown tools or tools without callId', () => {
      const rawEvents = [
        {
          type: 'tool/call',
          data: { callId: '', name: 'mnemosyne_status', args: {} },
        },
      ]
      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('invalid_call_id')

      const rawEvents2 = [
        {
          type: 'tool/call',
          data: { callId: 'c1', name: 'malicious_exec_tool', args: {} },
        },
      ]
      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents2,
        })
      ).toThrow('unknown_mnemosyne_tool')
    })
  })

  describe('2. Elimination of Free-text and Keyword Fallbacks', () => {
    it('rejects arbitrary text output that does not match formal tool schema', () => {
      const rawEvents = [
        {
          type: 'tool/call',
          data: { callId: 'c1', name: 'mnemosyne_status', args: {} },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'c1',
            message: {
              callId: 'c1',
              content: [{ type: 'text', text: 'status: pass! Everything is good and generation is ready!' }],
            },
          },
        },
      ]

      expect(() =>
        extractStrictSessionEvidence({
          runId: 'run_1',
          projectScopeId: dummyProjectScopeId,
          sessionId: dummySessionId,
          sessionEvents: rawEvents,
        })
      ).toThrow('invalid_tool_result_format')
    })
  })

  describe('3. Safe Projections for 7 Mnemosyne Tools', () => {
    it('projects mnemosyne_status correctly and redacts freeform texts', () => {
      const statusOutput = {
        plugin: 'dsh-Mnemosyne',
        version: '0.0.0-dev',
        protocol_version: 3,
        memory_enabled: true,
        status: 'ready',
        scope: {
          status: 'ready',
          source: 'session_header',
          project_scope_id: dummyProjectScopeId,
          session_scope_id: dummySessionIdHash,
          reason: null,
        },
        memory: {
          availability: 'ready',
          generation_id: 'gen_01',
          short_term_count: 2,
          long_term_count: 1,
          total_count: 3,
          reason: null,
        },
      }
      const rawEvents = [
        { type: 'tool/call', data: { callId: 'c1', name: 'mnemosyne_status', args: {} } },
        { type: 'tool/result', data: { callId: 'c1', message: { callId: 'c1', content: [{ type: 'text', text: JSON.stringify(statusOutput) }] } } },
        { type: 'turn/end', data: { status: 'completed' } },
      ]

      const ev = extractStrictSessionEvidence({
        runId: 'run_1',
        projectScopeId: dummyProjectScopeId,
        sessionId: dummySessionId,
        sessionEvents: rawEvents,
      })

      expect(ev.schema_version).toBe(2)
      expect(ev.run_id).toBe('run_1')
      expect(ev.completed_turns).toBe(1)
      expect(ev.tool_executions).toHaveLength(1)
      const exec1 = ev.tool_executions[0]
      expect(exec1.ordinal).toBe(1)
      expect(exec1.tool_name).toBe('mnemosyne_status')
      expect(exec1.result_status).toBe('ready')
      expect(exec1.result_binding).toEqual({
        availability: 'ready',
        generation_id: 'gen_01',
        short_term_count: 2,
        long_term_count: 1,
        total_count: 3,
      })
    })


    it('projects mnemosyne_search correctly without body content', () => {
      const queryFp = computeSha256('how does auth work?')
      const genRef = {
        generation_id: 'gen_' + 'a'.repeat(32),
        generation_sha256: 'sha256_' + 'a'.repeat(64),
        manifest_id: 'manifest_' + 'a'.repeat(32),
        manifest_sha256: 'sha256_' + 'b'.repeat(64),
        index_sha256: 'sha256_' + 'c'.repeat(64),
      }
      const rawSearchOutput = {
        schema_version: 1 as const,
        disclosure_id: 'disclosure_' + '1'.repeat(64),
        retrieval_id: 'retrieval_' + '1'.repeat(64),
        project_scope_id: dummyProjectScopeId,
        session_scope_id: dummySessionIdHash,
        generation_ref: genRef,
        query_fingerprint: queryFp,
        component_hint: 'auth',
        top_k: 5,
        level: 2 as const,
        result_count: 1,
        items: [
          {
            memory_ref: {
              tier: 'short_term' as const,
              session_scope_id: dummySessionIdHash,
              memory_id: 'mem_short_01',
              content_sha256: 'sha256_' + 'e'.repeat(64),
              page_ref: 'wiki/memories/mem_short_01.md',
            },
            title: 'Secret Title That Should Be Redacted',
            summary: 'Secret Summary That Should Be Redacted',
            component: 'auth',
            tags: ['auth', 'jwt'],
            score_fixed: 9500,
            rank: 1,
          },
        ],
        content_sha256: '',
      }

      const searchJson = canonicalizeSearchDisclosure(rawSearchOutput)
      const searchOutput = JSON.parse(searchJson)

      const rawEvents = [
        {
          type: 'tool/call',
          data: {
            callId: 'c_search_1',
            name: 'mnemosyne_search',
            args: { query: 'how does auth work?', component_hint: 'auth', top_k: 5 },
          },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'c_search_1',
            message: { callId: 'c_search_1', content: [{ type: 'text', text: searchJson }] },
          },
        },
        { type: 'turn/end', data: { status: 'completed' } },
      ]

      const ev = extractStrictSessionEvidence({
        runId: 'run_2',
        projectScopeId: dummyProjectScopeId,
        sessionId: dummySessionId,
        sessionEvents: rawEvents,
      })

      const exec = ev.tool_executions[0]
      expect(exec.tool_name).toBe('mnemosyne_search')
      expect(exec.argument_binding.query_sha256).toBe(queryFp)
      expect(exec.argument_binding.component_hint).toBe('auth')
      expect(exec.argument_binding.top_k).toBe(5)
      expect(exec.result_binding.retrieval_id).toBe(searchOutput.retrieval_id)
      expect(exec.result_binding.search_disclosure_sha256).toBe(searchOutput.content_sha256)
      expect(exec.result_binding.contains_body).toBe(false)
      expect(exec.result_binding.memory_refs).toHaveLength(1)
      expect(exec.result_binding.memory_refs[0].memory_id).toBe('mem_short_01')
      // Ensure title/summary are not in safe projection
      expect((exec.result_binding as any).title).toBeUndefined()
      expect((exec.result_binding as any).summary).toBeUndefined()
    })

    it('projects mnemosyne_open correctly and binds to search disclosure', () => {
      const genRef = {
        generation_id: 'gen_' + 'a'.repeat(32),
        generation_sha256: 'sha256_' + 'a'.repeat(64),
        manifest_id: 'manifest_' + 'a'.repeat(32),
        manifest_sha256: 'sha256_' + 'b'.repeat(64),
        index_sha256: 'sha256_' + 'c'.repeat(64),
      }
      const rawOpenOutput = {
        schema_version: 1 as const,
        disclosure_id: 'disclosure_' + '2'.repeat(64),
        retrieval_id: 'retrieval_' + '1'.repeat(64),
        parent_disclosure_sha256: 'sha256_' + 'f'.repeat(64),
        project_scope_id: dummyProjectScopeId,
        session_scope_id: dummySessionIdHash,
        generation_ref: genRef,
        level: 3 as const,
        memory_ref: {
          tier: 'short_term' as const,
          session_scope_id: dummySessionIdHash,
          memory_id: 'mem_short_01',
          content_sha256: 'sha256_' + 'e'.repeat(64),
          page_ref: 'wiki/memories/mem_short_01.md',
        },
        title: 'Sensitive Title',
        summary: 'Sensitive Summary',
        component: 'auth',
        tags: ['auth'],
        body: 'Very sensitive body text that must NOT be saved into evidence files directly.',
        content_sha256: '',
      }

      const openJson = canonicalizeOpenDisclosure(rawOpenOutput)
      const openOutput = JSON.parse(openJson)

      const rawEvents = [
        {
          type: 'tool/call',
          data: {
            callId: 'c_open_1',
            name: 'mnemosyne_open',
            args: {
              retrieval_id: openOutput.retrieval_id,
              search_disclosure_sha256: openOutput.parent_disclosure_sha256,
              memory_id: 'mem_short_01',
            },
          },
        },
        {
          type: 'tool/result',
          data: {
            callId: 'c_open_1',
            message: { callId: 'c_open_1', content: [{ type: 'text', text: openJson }] },
          },
        },
        { type: 'turn/end', data: { status: 'completed' } },
      ]

      const ev = extractStrictSessionEvidence({
        runId: 'run_2',
        projectScopeId: dummyProjectScopeId,
        sessionId: dummySessionId,
        sessionEvents: rawEvents,
      })

      const exec = ev.tool_executions[0]
      expect(exec.tool_name).toBe('mnemosyne_open')
      expect(exec.argument_binding.retrieval_id).toBe(openOutput.retrieval_id)
      expect(exec.argument_binding.search_disclosure_sha256).toBe(openOutput.parent_disclosure_sha256)
      expect(exec.argument_binding.memory_id).toBe('mem_short_01')
      expect(exec.result_binding.body_present).toBe(true)
      expect(exec.result_binding.body_sha256).toBe(computeSha256(openOutput.body))
      expect((exec.result_binding as any).body).toBeUndefined()
    })
  })

  describe('4. Search/Open Cross-Tool Binding Validator', () => {
    it('validates matching Search and Open executions successfully', () => {
      const searchExec: ToolExecutionEvidence = {
        ordinal: 1,
        call_id_sha256: computeSha256('call_search'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('q'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: {
          retrieval_id: 'ret_100',
          search_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          generation_ref: {
            generation_id: 'gen_01',
            generation_sha256: 'sha256_' + 'a'.repeat(64),
            manifest_id: 'manifest_01',
            manifest_sha256: 'sha256_' + 'b'.repeat(64),
            index_sha256: 'sha256_' + 'c'.repeat(64),
          },
          memory_refs: [
            { tier: 'short_term', session_scope_id: dummySessionIdHash, memory_id: 'mem_1', content_sha256: 'sha256_' + 'd'.repeat(64) },
          ],
          contains_body: false,
        },
        result_sha256: 'sha256_' + '4'.repeat(64),
      }

      const openExec: ToolExecutionEvidence = {
        ordinal: 2,
        call_id_sha256: computeSha256('call_open'),
        tool_name: 'mnemosyne_open',
        argument_binding: {
          retrieval_id: 'ret_100',
          search_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          memory_id: 'mem_1',
        },
        result_status: 'pass',
        result_binding: {
          open_disclosure_sha256: 'sha256_' + '5'.repeat(64),
          parent_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          memory_ref: { tier: 'short_term', session_scope_id: dummySessionIdHash, memory_id: 'mem_1', content_sha256: 'sha256_' + 'd'.repeat(64) },
          body_sha256: 'sha256_' + '6'.repeat(64),
          body_present: true,
        },
        result_sha256: 'sha256_' + '7'.repeat(64),
      }

      expect(() => validateSearchOpenBinding(searchExec, openExec)).not.toThrow()
    })

    it('rejects Open if retrieval_id or search_disclosure_sha256 or memory_id mismatches Search', () => {
      const searchExec: ToolExecutionEvidence = {
        ordinal: 1,
        call_id_sha256: computeSha256('call_search'),
        tool_name: 'mnemosyne_search',
        argument_binding: { query_sha256: computeSha256('q'), component_hint: null, top_k: 5 },
        result_status: 'pass',
        result_binding: {
          retrieval_id: 'ret_100',
          search_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          generation_ref: null,
          memory_refs: [
            { tier: 'short_term', session_scope_id: dummySessionIdHash, memory_id: 'mem_1', content_sha256: 'sha256_' + 'd'.repeat(64) },
          ],
          contains_body: false,
        },
        result_sha256: 'sha256_' + '4'.repeat(64),
      }

      const openMismatchedRetrieval: ToolExecutionEvidence = {
        ordinal: 2,
        call_id_sha256: computeSha256('call_open'),
        tool_name: 'mnemosyne_open',
        argument_binding: {
          retrieval_id: 'ret_999_wrong',
          search_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          memory_id: 'mem_1',
        },
        result_status: 'pass',
        result_binding: {
          open_disclosure_sha256: 'sha256_' + '5'.repeat(64),
          parent_disclosure_sha256: 'sha256_' + '3'.repeat(64),
          memory_ref: { tier: 'short_term', session_scope_id: dummySessionIdHash, memory_id: 'mem_1', content_sha256: 'sha256_' + 'd'.repeat(64) },
          body_sha256: 'sha256_' + '6'.repeat(64),
          body_present: true,
        },
        result_sha256: 'sha256_' + '7'.repeat(64),
      }

      expect(() => validateSearchOpenBinding(searchExec, openMismatchedRetrieval)).toThrow('search_open_retrieval_id_mismatch')
    })
  })

  describe('5. Canonical JSON, Hash, Persistence & No-overwrite', () => {
    it('verifies deterministic Canonical Hash and rejects tampered content_sha256', () => {
      const sample = createStrictSessionEvidence({
        run_id: 'run_1',
        project_scope_id: dummyProjectScopeId,
        session_id_sha256: dummySessionIdHash,
        completed_turns: 1,
        tool_executions: [],
        recorded_at: '2026-08-27T00:00:00.000Z',
      })

      expect(validateStrictSessionEvidence(sample)).toEqual(sample)

      const tampered = { ...sample, content_sha256: 'sha256_' + '0'.repeat(64) }
      expect(() => validateStrictSessionEvidence(tampered)).toThrow('invalid_evidence_hash')
    })

    it('writes with no-overwrite wx and mode 0600', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'evidence_test_'))
      try {
        const sample = createStrictSessionEvidence({
          run_id: 'run_1',
          project_scope_id: dummyProjectScopeId,
          session_id_sha256: dummySessionIdHash,
          completed_turns: 1,
          tool_executions: [],
          recorded_at: '2026-08-27T00:00:00.000Z',
        })

        await writeStrictSessionEvidence(tempDir, sample)
        const readBack = await readStrictSessionEvidence(tempDir, 'run_1')
        expect(readBack).toEqual(sample)

        // Attempt overwrite must throw
        await expect(writeStrictSessionEvidence(tempDir, sample)).rejects.toThrow()
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})
