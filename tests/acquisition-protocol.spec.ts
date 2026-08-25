import { describe, expect, it } from 'vitest'
import {
  ACQUISITION_SYSTEM_PROMPT,
  ACQUISITION_SYSTEM_PROMPT_SHA256,
  buildAcquisitionUserPrompt,
  computeAutoMemoryId,
  computeCandidateFingerprint,
  computeCandidateSha256,
  computeEventKey,
  computeEvidenceHash,
  computeManualEventKey,
  computeManualMemoryId,
  createAcquisitionEvidence,
  validateAcquisitionEvidence,
  validateMemoryCandidate,
  type AcquisitionEvidence,
  type MemoryCandidate,
} from '../src/protocol/acquisition.js'

describe('MVP-05 acquisition protocol', () => {
  const validEvidencePayload: Omit<AcquisitionEvidence, 'evidence_sha256'> = {
    schema_version: 1,
    project_scope_id: 'sha256_' + 'a'.repeat(64),
    session_scope_id: 'sha256_' + 'b'.repeat(64),
    turn: 3,
    turn_end_seq: 42,
    turn_end_time: '2026-08-25T08:00:00.000Z',
    route: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    user_text: 'How should we configure the cache?',
    assistant_text: 'Use the smallest targeted build after updating compiler options.',
  }

  it('calculates deterministic evidence hash and creates valid evidence object', () => {
    const evidence = createAcquisitionEvidence(validEvidencePayload)
    expect(evidence.schema_version).toBe(1)
    expect(evidence.evidence_sha256).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(validateAcquisitionEvidence(evidence)).toEqual(evidence)
    expect(evidence.evidence_sha256).toBe(computeEvidenceHash(validEvidencePayload))
  })

  it('rejects tampered or invalid evidence fields', () => {
    const evidence = createAcquisitionEvidence(validEvidencePayload)
    expect(() => validateAcquisitionEvidence({ ...evidence, evidence_sha256: 'sha256_' + '0'.repeat(64) })).toThrow()
    expect(() => validateAcquisitionEvidence({ ...evidence, turn: 0 })).toThrow()
    expect(() => validateAcquisitionEvidence({ ...evidence, turn_end_time: 'invalid-time' })).toThrow()
    expect(() => validateAcquisitionEvidence({ ...evidence, route: { provider: '', model: 'deepseek-chat' } })).toThrow()
    expect(() => validateAcquisitionEvidence({ ...evidence, unknown_field: 'extra' })).toThrow()
  })

  it('calculates deterministic event keys', () => {
    const key1 = computeEventKey({
      schema_version: 1,
      project_scope_id: 'sha256_' + 'a'.repeat(64),
      session_scope_id: 'sha256_' + 'b'.repeat(64),
      turn: 3,
      turn_end_seq: 42,
      turn_end_time: '2026-08-25T08:00:00.000Z',
    })
    const key2 = computeEventKey({
      schema_version: 1,
      project_scope_id: 'sha256_' + 'a'.repeat(64),
      session_scope_id: 'sha256_' + 'b'.repeat(64),
      turn: 3,
      turn_end_seq: 42,
      turn_end_time: '2026-08-25T08:00:00.000Z',
    })
    expect(key1).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(key1).toBe(key2)
  })

  it('validates MemoryCandidate remember branch with exact schema and safe text', () => {
    const remember: MemoryCandidate = {
      schema_version: 1,
      decision: 'remember',
      title: 'Targeted compiler cache usage',
      summary: 'Keep compiler cache and run smallest affected target.',
      body: 'When compiler config changes, preserve existing cache and build affected targets first.',
      tags: ['build', 'cache'],
    }
    const validated = validateMemoryCandidate(remember)
    expect(validated).toEqual({
      schema_version: 1,
      decision: 'remember',
      title: 'Targeted compiler cache usage',
      summary: 'Keep compiler cache and run smallest affected target.',
      body: 'When compiler config changes, preserve existing cache and build affected targets first.',
      tags: ['build', 'cache'],
    })
  })

  it('validates MemoryCandidate skip branch with exact reason codes', () => {
    const skip1: MemoryCandidate = {
      schema_version: 1,
      decision: 'skip',
      reason_code: 'no_reusable_knowledge',
    }
    const skip2: MemoryCandidate = {
      schema_version: 1,
      decision: 'skip',
      reason_code: 'insufficient_evidence',
    }
    const skip3: MemoryCandidate = {
      schema_version: 1,
      decision: 'skip',
      reason_code: 'external_failure',
    }
    expect(validateMemoryCandidate(skip1)).toEqual(skip1)
    expect(validateMemoryCandidate(skip2)).toEqual(skip2)
    expect(validateMemoryCandidate(skip3)).toEqual(skip3)

    expect(() => validateMemoryCandidate({ schema_version: 1, decision: 'skip', reason_code: 'unknown_reason' })).toThrow()
  })

  it('strictly rejects unknown fields, freeform reason, model-controlled identities, and sensitive text in candidates', () => {
    // Unknown fields
    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Valid title',
      summary: 'Valid summary',
      body: 'Valid body',
      tags: ['tag1'],
      extra_field: 'forbidden',
    })).toThrow()

    // Model trying to dictate memory_id or tier or TTL
    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      memory_id: 'mem_model_123',
      title: 'Valid title',
      summary: 'Valid summary',
      body: 'Valid body',
      tags: [],
    })).toThrow()

    // Model trying to include sensitive path or credential
    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Token leak',
      summary: 'bearer abcdefghijklmnop',
      body: 'Valid body text',
      tags: [],
    })).toThrow()

    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Path leak',
      summary: 'Found at /Users/czy/Desktop/demo',
      body: 'Valid body text',
      tags: [],
    })).toThrow()

    // Control characters
    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Null byte \0 in title',
      summary: 'Summary',
      body: 'Body',
      tags: [],
    })).toThrow()

    // Duplicate tags or malformed tags
    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Title',
      summary: 'Summary',
      body: 'Body',
      tags: ['tag', 'tag'],
    })).toThrow()

    expect(() => validateMemoryCandidate({
      schema_version: 1,
      decision: 'remember',
      title: 'Title',
      summary: 'Summary',
      body: 'Body',
      tags: ['INVALID TAG'],
    })).toThrow()
  })

  it('computes exact candidate fingerprint ignoring tag order', () => {
    const fp1 = computeCandidateFingerprint({
      title: 'Compiler cache',
      summary: 'Targeted build',
      body: 'Preserve cache',
      tags: ['cache', 'build'],
    })
    const fp2 = computeCandidateFingerprint({
      title: 'Compiler cache',
      summary: 'Targeted build',
      body: 'Preserve cache',
      tags: ['build', 'cache'],
    })
    expect(fp1).toBe(fp2)

    const fpDifferent = computeCandidateFingerprint({
      title: 'Compiler cache modified',
      summary: 'Targeted build',
      body: 'Preserve cache',
      tags: ['build', 'cache'],
    })
    expect(fp1).not.toBe(fpDifferent)
  })

  it('computes deterministic auto and manual memory IDs with mem_auto_ and mem_manual_ prefixes', () => {
    const autoId = computeAutoMemoryId('sha256_' + '1'.repeat(64), 'sha256_' + '2'.repeat(64), 'sha256_' + '3'.repeat(64))
    expect(autoId).toMatch(/^mem_auto_[0-9a-f]{32}$/)

    const manualEventKey = computeManualEventKey({
      schema_version: 1,
      project_scope_id: 'sha256_' + 'a'.repeat(64),
      session_scope_id: 'sha256_' + 'b'.repeat(64),
      call_id: 'call_test_123',
      tool_call_seq: 15,
      tool_call_time: '2026-08-25T08:00:00.000Z',
    })
    expect(manualEventKey).toMatch(/^sha256_[0-9a-f]{64}$/)

    const candidateSha = computeCandidateSha256({
      schema_version: 1,
      decision: 'remember',
      title: 'Title',
      summary: 'Summary',
      body: 'Body',
      tags: ['test'],
    })
    expect(candidateSha).toMatch(/^sha256_[0-9a-f]{64}$/)

    const manualId = computeManualMemoryId(manualEventKey, candidateSha)
    expect(manualId).toMatch(/^mem_manual_[0-9a-f]{32}$/)
  })

  it('verifies fixed System Prompt text and golden hash', () => {
    expect(typeof ACQUISITION_SYSTEM_PROMPT).toBe('string')
    expect(ACQUISITION_SYSTEM_PROMPT.length).toBeGreaterThan(100)
    // Golden hash check
    const promptHash = computeEvidenceHash({
      schema_version: 1,
      prompt: ACQUISITION_SYSTEM_PROMPT,
    } as never)
    expect(promptHash).toBe(ACQUISITION_SYSTEM_PROMPT_SHA256)

    const evidence = createAcquisitionEvidence(validEvidencePayload)
    const userPrompt = buildAcquisitionUserPrompt(evidence)
    expect(userPrompt).toContain(evidence.user_text)
    expect(userPrompt).toContain(evidence.assistant_text)
  })

  it('strictly validates code point bounds for user_text (max 4000) and assistant_text (max 6000) with BMP and emojis', () => {
    // 1. Boundary: exactly 4000 code points for user_text with mixed emojis
    const user4000 = '😀'.repeat(1000) + 'A'.repeat(3000)
    expect(Array.from(user4000).length).toBe(4000)
    expect(user4000.length).toBe(5000) // JS UTF-16 length is 5000, but code points is 4000
    const evValidUser = createAcquisitionEvidence({
      ...validEvidencePayload,
      user_text: user4000,
    })
    expect(validateAcquisitionEvidence(evValidUser)).toBeDefined()

    // 2. Boundary + 1: 4001 code points for user_text strictly throws
    const user4001 = '😀'.repeat(1000) + 'A'.repeat(3001)
    expect(Array.from(user4001).length).toBe(4001)
    expect(() => createAcquisitionEvidence({
      ...validEvidencePayload,
      user_text: user4001,
    })).toThrow()

    // 3. Boundary: exactly 6000 code points for assistant_text with mixed emojis
    const asst6000 = '🌟'.repeat(1500) + 'B'.repeat(4500)
    expect(Array.from(asst6000).length).toBe(6000)
    const evValidAsst = createAcquisitionEvidence({
      ...validEvidencePayload,
      assistant_text: asst6000,
    })
    expect(validateAcquisitionEvidence(evValidAsst)).toBeDefined()

    // 4. Boundary + 1: 6001 code points for assistant_text strictly throws
    const asst6001 = '🌟'.repeat(1500) + 'B'.repeat(4501)
    expect(Array.from(asst6001).length).toBe(6001)
    expect(() => createAcquisitionEvidence({
      ...validEvidencePayload,
      assistant_text: asst6001,
    })).toThrow()
  })
})
