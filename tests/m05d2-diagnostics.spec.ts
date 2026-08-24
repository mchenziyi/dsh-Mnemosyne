import { describe, expect, it } from 'vitest'
import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { canonicalBytes, canonicalHash, ProtocolValidationError, withoutHash } from '../src/protocol/canonical.js'
import {
  ALLOWED_CATEGORIES,
  ALLOWED_PROVIDER_CODES,
  ALLOWED_STAGES,
  classifyFailure,
  createSafeStreamFinishError,
  createSanitizedFailureDiagnostic,
  ModelOutputValidationError,
  resolveClaimKind,
  validateSanitizedFailureDiagnostic,
  type SanitizedFailureDiagnostic,
} from '../src/m05d2/diagnostics.js'

describe('M0.5D-D2-C: Sanitized Failure Diagnostics Specification & Classification', () => {
  describe('1. Code to Category Full Matrix', () => {
    const expectedMappings: Array<{
      code: (typeof ALLOWED_PROVIDER_CODES)[number]
      expectedCategory: (typeof ALLOWED_CATEGORIES)[number]
    }> = [
      { code: 'AUTH', expectedCategory: 'authentication_rejected' },
      { code: 'INVALID_CREDENTIAL', expectedCategory: 'authentication_rejected' },
      { code: 'MISSING_CREDENTIAL', expectedCategory: 'authentication_rejected' },
      { code: 'RATE_LIMIT', expectedCategory: 'rate_limited' },
      { code: 'QUOTA', expectedCategory: 'rate_limited' },
      { code: 'TIMEOUT', expectedCategory: 'provider_timeout' },
      { code: 'TRANSPORT', expectedCategory: 'network_failure' },
      { code: 'MALFORMED_RESPONSE', expectedCategory: 'provider_protocol_error' },
      { code: 'STREAM_CLOSED', expectedCategory: 'provider_protocol_error' },
      { code: 'EMPTY_RESPONSE', expectedCategory: 'provider_protocol_error' },
      { code: 'INVALID_REQUEST', expectedCategory: 'request_rejected' },
      { code: 'CONTEXT_WINDOW_EXCEEDED', expectedCategory: 'request_rejected' },
      { code: 'UNSUPPORTED_CONTENT', expectedCategory: 'request_rejected' },
      { code: 'UNSUPPORTED_REASONING_EFFORT', expectedCategory: 'request_rejected' },
      { code: 'SERVER', expectedCategory: 'provider_server_error' },
      { code: 'ABORTED', expectedCategory: 'request_rejected' },
    ]

    it('contains all 16 frozen DSH provider codes', () => {
      expect(ALLOWED_PROVIDER_CODES).toHaveLength(16)
      expect(expectedMappings).toHaveLength(16)
      expect(QUOTA_EXCEEDED_CODE).toBe('QUOTA')
      expect(ALLOWED_PROVIDER_CODES).toContain(QUOTA_EXCEEDED_CODE)
    })

    for (const { code, expectedCategory } of expectedMappings) {
      it(`classifies LlmError with code="${code}" to category="${expectedCategory}" and stage="provider_stream"`, () => {
        const error = new LlmError(`Sensitive message for ${code}`, code)
        const result = classifyFailure(error, 'provider_stream')
        expect(result.category).toBe(expectedCategory)
        expect(result.provider_code).toBe(code)
        expect(result.stage).toBe('provider_stream')

        const diag = createSanitizedFailureDiagnostic({
          sequence: 1,
          call_kind: 'task',
          stage: result.stage,
          category: result.category,
          provider_code: result.provider_code,
        })
        expect(diag.category).toBe(expectedCategory)
        expect(diag.provider_code).toBe(code)
        expect(diag.stage).toBe('provider_stream')
        expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
      })
    }
  })

  describe('2. Unknown Provider Codes and Generic Exceptions', () => {
    it('maps unknown provider code to category="unknown_provider_error" and provider_code=null', () => {
      const error = new LlmError('Unknown provider failure', 'UNRECOGNIZED_CODE_XYZ')
      const result = classifyFailure(error, 'provider_stream')
      expect(result.category).toBe('unknown_provider_error')
      expect(result.provider_code).toBeNull()
      expect(result.stage).toBe('provider_stream')

      const diag = createSanitizedFailureDiagnostic({
        sequence: 2,
        call_kind: 'task',
        stage: result.stage,
        category: result.category,
        provider_code: result.provider_code,
      })
      expect(diag.category).toBe('unknown_provider_error')
      expect(diag.provider_code).toBeNull()
      expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
    })

    it('maps generic TypeError/Error to category="unknown_provider_error" and provider_code=null during provider stream', () => {
      const error = new TypeError('fetch failed: network socket reset')
      const result = classifyFailure(error, 'provider_stream')
      expect(result.category).toBe('unknown_provider_error')
      expect(result.provider_code).toBeNull()
      expect(result.stage).toBe('provider_stream')
    })

    it('maps non-Error throws (strings, numbers, null) to unknown_provider_error with provider_code=null', () => {
      expect(classifyFailure('string error', 'provider_stream')).toEqual({
        stage: 'provider_stream',
        category: 'unknown_provider_error',
        provider_code: null,
      })
      expect(classifyFailure(null, 'provider_stream')).toEqual({
        stage: 'provider_stream',
        category: 'unknown_provider_error',
        provider_code: null,
      })
    })
  })

  describe('3. Local Stage Separation: Task and Acquisition Validation vs Runner Protocol', () => {
    it('classifies task output validation error to stage="task_output_validation" and category="model_output_schema_error"', () => {
      const error = new ModelOutputValidationError('task_output_validation')
      const result = classifyFailure(error, 'task_output_validation')
      expect(result.stage).toBe('task_output_validation')
      expect(result.category).toBe('model_output_schema_error')
      expect(result.provider_code).toBeNull()

      const diag = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: result.stage,
        category: result.category,
        provider_code: result.provider_code,
      })
      expect(diag.stage).toBe('task_output_validation')
      expect(diag.category).toBe('model_output_schema_error')
      expect(diag.provider_code).toBeNull()
      expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
    })

    it('classifies acquisition output validation error to stage="acquisition_output_validation" and category="model_output_schema_error"', () => {
      const error = new ModelOutputValidationError('acquisition_output_validation')
      const result = classifyFailure(error, 'acquisition_output_validation')
      expect(result.stage).toBe('acquisition_output_validation')
      expect(result.category).toBe('model_output_schema_error')
      expect(result.provider_code).toBeNull()

      const diag = createSanitizedFailureDiagnostic({
        sequence: 2,
        call_kind: 'acquisition',
        stage: result.stage,
        category: result.category,
        provider_code: result.provider_code,
      })
      expect(diag.stage).toBe('acquisition_output_validation')
      expect(diag.category).toBe('model_output_schema_error')
      expect(diag.provider_code).toBeNull()
      expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
    })

    it('classifies runner invariant / protocol failure to stage="runner_protocol" and category="runner_protocol_error"', () => {
      const error = new ProtocolValidationError()
      const result = classifyFailure(error, 'runner_protocol')
      expect(result.stage).toBe('runner_protocol')
      expect(result.category).toBe('runner_protocol_error')
      expect(result.provider_code).toBeNull()

      const diag = createSanitizedFailureDiagnostic({
        sequence: 3,
        call_kind: 'task',
        stage: result.stage,
        category: result.category,
        provider_code: result.provider_code,
      })
      expect(diag.stage).toBe('runner_protocol')
      expect(diag.category).toBe('runner_protocol_error')
      expect(diag.provider_code).toBeNull()
      expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
    })

    it('does not misattribute a local protocol failure to the provider when the caller fallback is provider_stream', () => {
      expect(classifyFailure(new ProtocolValidationError(), 'provider_stream')).toEqual({
        stage: 'runner_protocol',
        category: 'runner_protocol_error',
        provider_code: null,
      })
    })
  })

  describe('4. Strict Object Validation & Invariant Enforcements', () => {
    function makeSampleDiagnostic(overrides: Partial<SanitizedFailureDiagnostic> = {}): SanitizedFailureDiagnostic {
      const body = {
        schema_version: 1 as const,
        sequence: 1,
        call_kind: 'task' as const,
        stage: 'provider_stream' as const,
        category: 'rate_limited' as const,
        provider_code: 'RATE_LIMIT' as const,
        ...overrides,
      }
      return {
        ...body,
        content_sha256: canonicalHash(withoutHash(body, 'content_sha256')),
      }
    }

    it('accepts valid diagnostic and verifies canonicalHash idempotency', () => {
      const diag = makeSampleDiagnostic()
      expect(validateSanitizedFailureDiagnostic(diag)).toEqual(diag)
      expect(canonicalBytes(diag)).toBe(canonicalBytes(diag))
    })

    it('rejects unknown fields (strict decode)', () => {
      const bad = {
        ...makeSampleDiagnostic(),
        unknown_field: 'forbidden',
      }
      expect(() => validateSanitizedFailureDiagnostic(bad)).toThrow(ProtocolValidationError)
    })

    it('rejects sequence outside 1..30 or non-integer', () => {
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ sequence: 0 }))).toThrow(ProtocolValidationError)
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ sequence: 31 }))).toThrow(ProtocolValidationError)
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ sequence: 1.5 }))).toThrow(ProtocolValidationError)
    })

    it('rejects unknown stage, category, or call_kind', () => {
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ stage: 'unknown_stage' as any }))).toThrow(ProtocolValidationError)
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ category: 'unknown_cat' as any }))).toThrow(ProtocolValidationError)
      expect(() => validateSanitizedFailureDiagnostic(makeSampleDiagnostic({ call_kind: 'other_kind' as any }))).toThrow(ProtocolValidationError)
    })

    it('rejects invalid provider_code or cross-category mismatches', () => {
      // 1. Provider code mismatch with category
      expect(() =>
        validateSanitizedFailureDiagnostic(
          makeSampleDiagnostic({
            provider_code: 'AUTH',
            category: 'rate_limited',
          })
        )
      ).toThrow(ProtocolValidationError)

      // 2. Non-null provider_code on model_output_schema_error
      expect(() =>
        validateSanitizedFailureDiagnostic(
          makeSampleDiagnostic({
            stage: 'task_output_validation',
            category: 'model_output_schema_error',
            provider_code: 'AUTH' as any,
          })
        )
      ).toThrow(ProtocolValidationError)

      // 3. Null provider_code on category that requires code
      expect(() =>
        validateSanitizedFailureDiagnostic(
          makeSampleDiagnostic({
            stage: 'provider_stream',
            category: 'rate_limited',
            provider_code: null,
          })
        )
      ).toThrow(ProtocolValidationError)
    })

    it('rejects tampered content_sha256', () => {
      const tampered = {
        ...makeSampleDiagnostic(),
        content_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
      }
      expect(() => validateSanitizedFailureDiagnostic(tampered)).toThrow(ProtocolValidationError)
    })
  })

  describe('5. Zero Leakage & Security Invariant Tests', () => {
    it('guarantees zero leakage of secrets, keys, paths, messages, causes, prompts, or commands', () => {
      const secretPayload = 'sk-synthetic-attacker-key-12345678901234567890'
      const pathPayload = '/Users/victim/secret/workspace/credentials'
      const promptPayload = 'PROMPT: System instructions leak payload'
      const commandPayload = 'rm -rf /tmp/data'
      const rawHeaderPayload = 'Authorization: Bearer secret-token-header'

      const maliciousError = new LlmError(
        `Failed due to ${secretPayload} at ${pathPayload} with ${promptPayload} and ${commandPayload} in ${rawHeaderPayload}`,
        'AUTH',
        {
          cause: new Error(`Nested cause with ${secretPayload}`),
        }
      )
      ;(maliciousError as any).requestId = 'req_sensitive_123456'
      ;(maliciousError as any).providerRetryAfterMs = 5000
      ;(maliciousError as any).status = 401

      const result = classifyFailure(maliciousError, 'provider_stream')
      const diag = createSanitizedFailureDiagnostic({
        sequence: 1,
        call_kind: 'task',
        stage: result.stage,
        category: result.category,
        provider_code: result.provider_code,
      })

      const diagJson = JSON.stringify(diag)
      const canonical = canonicalBytes(diag)

      for (const payload of [
        secretPayload,
        pathPayload,
        promptPayload,
        commandPayload,
        rawHeaderPayload,
        'req_sensitive_123456',
        'Nested cause',
        'Failed due to',
        '401',
        '5000',
      ]) {
        expect(diagJson).not.toContain(payload)
        expect(canonical).not.toContain(payload)
      }

      expect(diag.provider_code).toBe('AUTH')
      expect(diag.category).toBe('authentication_rejected')
      expect(diag.stage).toBe('provider_stream')
    })
  })

  describe('6. Stream Finish Error Extraction & Trap Proofs', () => {
    it('reads failure.code exactly once, never accesses failure.message or reason.message, and produces safe LlmError', () => {
      let codeAccessCount = 0
      let messageAccessed = false

      const failureObj = {}
      Object.defineProperty(failureObj, 'code', {
        get() {
          codeAccessCount++
          return 'RATE_LIMIT'
        },
      })
      Object.defineProperty(failureObj, 'message', {
        get() {
          messageAccessed = true
          throw new Error('LEAK_TRAP: failure.message must never be accessed!')
        },
      })

      const reason = { kind: 'error', failure: failureObj }
      Object.defineProperty(reason, 'message', {
        get() {
          messageAccessed = true
          throw new Error('LEAK_TRAP: reason.message must never be accessed!')
        },
      })

      const err = createSafeStreamFinishError(reason)
      expect(messageAccessed).toBe(false)
      expect(codeAccessCount).toBe(1)
      expect(err).toBeInstanceOf(LlmError)
      expect(err.code).toBe('RATE_LIMIT')
      expect(err.message).toBe('Provider stream terminated with error')
    })

    it('returns fixed UNKNOWN LlmError if failure.code getter throws', () => {
      let messageAccessed = false
      const throwingFailure = {}
      Object.defineProperty(throwingFailure, 'code', {
        get() {
          throw new Error('Getter error')
        },
      })
      Object.defineProperty(throwingFailure, 'message', {
        get() {
          messageAccessed = true
          throw new Error('LEAK_TRAP: message accessed!')
        },
      })

      const err = createSafeStreamFinishError({ kind: 'error', failure: throwingFailure })
      expect(messageAccessed).toBe(false)
      expect(err).toBeInstanceOf(LlmError)
      expect(err.code).toBe('UNKNOWN')
      expect(err.message).toBe('Provider stream terminated with error')
    })

    it('returns fixed UNKNOWN LlmError for non-string, unknown, or ultra-long codes', () => {
      expect(createSafeStreamFinishError({ failure: { code: 12345 } }).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError({ failure: { code: null } }).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError({ failure: { code: 'FORBIDDEN_UNKNOWN_CODE_ABC' } }).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError({ failure: { code: 'AUTH' + 'X'.repeat(100) } }).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError(null).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError(undefined).code).toBe('UNKNOWN')
      expect(createSafeStreamFinishError('string reason').code).toBe('UNKNOWN')
    })
  })

  describe('7. classifyFailure Single Read & Code Getter Trap Proofs', () => {
    it('reads error.code at most once and maps throwing getter to unknown_provider_error with provider_code=null', () => {
      let codeReadCount = 0
      const throwingErr = {}
      Object.defineProperty(throwingErr, 'code', {
        get() {
          codeReadCount++
          throw new Error('code getter error')
        },
      })

      const res = classifyFailure(throwingErr, 'provider_stream')
      expect(codeReadCount).toBe(1)
      expect(res.category).toBe('unknown_provider_error')
      expect(res.provider_code).toBeNull()
      expect(res.stage).toBe('provider_stream')
    })

    it('reads valid error.code exactly once', () => {
      let codeReadCount = 0
      const validErr = {}
      Object.defineProperty(validErr, 'code', {
        get() {
          codeReadCount++
          return 'TRANSPORT'
        },
      })

      const res = classifyFailure(validErr, 'provider_stream')
      expect(codeReadCount).toBe(1)
      expect(res.category).toBe('network_failure')
      expect(res.provider_code).toBe('TRANSPORT')
      expect(res.stage).toBe('provider_stream')
    })

    it('maps ultra-long or non-string error.code to unknown_provider_error', () => {
      const longErr = { code: 'AUTH_' + 'y'.repeat(100) }
      const res = classifyFailure(longErr, 'provider_stream')
      expect(res.category).toBe('unknown_provider_error')
      expect(res.provider_code).toBeNull()
    })
  })

  describe('8. resolveClaimKind Fail-Closed Invariants', () => {
    it('resolves valid sequence mapping to correct call kind', () => {
      const claimKinds = new Map<number, 'task' | 'acquisition'>([
        [1, 'task'],
        [2, 'task'],
        [3, 'acquisition'],
      ])

      expect(resolveClaimKind(claimKinds, 1)).toBe('task')
      expect(resolveClaimKind(claimKinds, 2)).toBe('task')
      expect(resolveClaimKind(claimKinds, 3)).toBe('acquisition')
    })

    it('throws ProtocolValidationError on missing sequence without defaulting to task', () => {
      const claimKinds = new Map<number, 'task' | 'acquisition'>([[1, 'task']])
      expect(() => resolveClaimKind(claimKinds, 2)).toThrow(ProtocolValidationError)
      expect(() => resolveClaimKind(new Map(), 1)).toThrow(ProtocolValidationError)
    })

    it('throws ProtocolValidationError if map contains invalid call kind value', () => {
      const corruptedMap = new Map<number, any>([[1, 'invalid_kind']])
      expect(() => resolveClaimKind(corruptedMap, 1)).toThrow(ProtocolValidationError)
    })
  })
})
