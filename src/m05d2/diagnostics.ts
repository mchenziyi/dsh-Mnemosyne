import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  assertExactKeys,
  assertHash,
  assertInteger,
  assertObject,
  canonicalHash,
  containsSensitiveText,
  ProtocolValidationError,
  withoutHash,
} from '../protocol/canonical.js'

export const ALLOWED_CALL_KINDS = ['task', 'acquisition'] as const
export type CallKind = (typeof ALLOWED_CALL_KINDS)[number]

export const ALLOWED_STAGES = [
  'provider_stream',
  'task_output_validation',
  'acquisition_output_validation',
  'runner_protocol',
] as const
export type FailureStage = (typeof ALLOWED_STAGES)[number]

export const ALLOWED_CATEGORIES = [
  'authentication_rejected',
  'rate_limited',
  'provider_timeout',
  'network_failure',
  'provider_protocol_error',
  'request_rejected',
  'provider_server_error',
  'model_output_schema_error',
  'runner_protocol_error',
  'unknown_provider_error',
] as const
export type FailureCategory = (typeof ALLOWED_CATEGORIES)[number]

export const ALLOWED_PROVIDER_CODES = [
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'RATE_LIMIT',
  'QUOTA',
  'TIMEOUT',
  'TRANSPORT',
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
  'EMPTY_RESPONSE',
  'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_REASONING_EFFORT',
  'SERVER',
  'ABORTED',
] as const
export type AllowedProviderCode = (typeof ALLOWED_PROVIDER_CODES)[number]

const CODE_TO_CATEGORY_MAP: Record<AllowedProviderCode, FailureCategory> = {
  AUTH: 'authentication_rejected',
  INVALID_CREDENTIAL: 'authentication_rejected',
  MISSING_CREDENTIAL: 'authentication_rejected',
  RATE_LIMIT: 'rate_limited',
  QUOTA: 'rate_limited',
  TIMEOUT: 'provider_timeout',
  TRANSPORT: 'network_failure',
  MALFORMED_RESPONSE: 'provider_protocol_error',
  STREAM_CLOSED: 'provider_protocol_error',
  EMPTY_RESPONSE: 'provider_protocol_error',
  INVALID_REQUEST: 'request_rejected',
  CONTEXT_WINDOW_EXCEEDED: 'request_rejected',
  UNSUPPORTED_CONTENT: 'request_rejected',
  UNSUPPORTED_REASONING_EFFORT: 'request_rejected',
  SERVER: 'provider_server_error',
  ABORTED: 'request_rejected',
}

export interface SanitizedFailureDiagnostic {
  schema_version: 1
  sequence: number
  call_kind: CallKind
  stage: FailureStage
  category: FailureCategory
  provider_code: AllowedProviderCode | null
  content_sha256: string
}

export class ModelOutputValidationError extends Error {
  constructor(public readonly validationStage: 'task_output_validation' | 'acquisition_output_validation') {
    super('model_output_schema_error')
    this.name = 'ModelOutputValidationError'
  }
}

function assertSanitized(value: unknown): void {
  const json = JSON.stringify(value)
  if (containsSensitiveText(json) || /sk-[a-zA-Z0-9]{20,}/.test(json)) {
    throw new ProtocolValidationError()
  }
}

export interface FailureClassificationResult {
  stage: FailureStage
  category: FailureCategory
  provider_code: AllowedProviderCode | null
}

export function classifyFailure(
  error: unknown,
  fallbackStage: FailureStage = 'runner_protocol'
): FailureClassificationResult {
  if (error instanceof ModelOutputValidationError) {
    return {
      stage: error.validationStage,
      category: 'model_output_schema_error',
      provider_code: null,
    }
  }

  if (error instanceof ProtocolValidationError) {
    return {
      stage: 'runner_protocol',
      category: 'runner_protocol_error',
      provider_code: null,
    }
  }

  if (fallbackStage === 'task_output_validation' || fallbackStage === 'acquisition_output_validation') {
    return {
      stage: fallbackStage,
      category: 'model_output_schema_error',
      provider_code: null,
    }
  }

  let rawCode: unknown = null
  if (typeof error === 'object' && error !== null) {
    try {
      rawCode = (error as any).code
    } catch {
      rawCode = null
    }
  }

  if (
    typeof rawCode === 'string' &&
    rawCode.length <= 64 &&
    (ALLOWED_PROVIDER_CODES as readonly string[]).includes(rawCode)
  ) {
    const provider_code = rawCode as AllowedProviderCode
    return {
      stage: 'provider_stream',
      category: CODE_TO_CATEGORY_MAP[provider_code],
      provider_code,
    }
  }

  if (fallbackStage === 'provider_stream') {
    return {
      stage: 'provider_stream',
      category: 'unknown_provider_error',
      provider_code: null,
    }
  }

  return {
    stage: 'runner_protocol',
    category: 'runner_protocol_error',
    provider_code: null,
  }
}

export function createSafeStreamFinishError(reason: unknown): LlmError {
  let safeCode = 'UNKNOWN'
  if (typeof reason === 'object' && reason !== null) {
    try {
      const failure = (reason as any).failure
      if (typeof failure === 'object' && failure !== null) {
        let rawCode: unknown = null
        try {
          rawCode = failure.code
        } catch {
          rawCode = null
        }
        if (
          typeof rawCode === 'string' &&
          rawCode.length <= 64 &&
          (ALLOWED_PROVIDER_CODES as readonly string[]).includes(rawCode)
        ) {
          safeCode = rawCode
        }
      }
    } catch {
      safeCode = 'UNKNOWN'
    }
  }
  return new LlmError('Provider stream terminated with error', safeCode)
}

export function resolveClaimKind(
  claimKinds: ReadonlyMap<number, CallKind>,
  seq: number
): CallKind {
  const kind = claimKinds.get(seq)
  if (kind === undefined || !ALLOWED_CALL_KINDS.includes(kind)) {
    throw new ProtocolValidationError()
  }
  return kind
}

export function createSanitizedFailureDiagnostic(options: {
  sequence: number
  call_kind: CallKind
  stage: FailureStage
  category: FailureCategory
  provider_code: AllowedProviderCode | null
}): SanitizedFailureDiagnostic {
  assertInteger(options.sequence, 1, 30)
  if (!ALLOWED_CALL_KINDS.includes(options.call_kind)) throw new ProtocolValidationError()
  if (!ALLOWED_STAGES.includes(options.stage)) throw new ProtocolValidationError()
  if (!ALLOWED_CATEGORIES.includes(options.category)) throw new ProtocolValidationError()
  if (options.provider_code !== null && !(ALLOWED_PROVIDER_CODES as readonly string[]).includes(options.provider_code)) {
    throw new ProtocolValidationError()
  }

  if (options.provider_code !== null) {
    if (options.stage !== 'provider_stream') throw new ProtocolValidationError()
    if (CODE_TO_CATEGORY_MAP[options.provider_code] !== options.category) {
      throw new ProtocolValidationError()
    }
  } else {
    if (
      options.category !== 'model_output_schema_error' &&
      options.category !== 'runner_protocol_error' &&
      options.category !== 'unknown_provider_error'
    ) {
      throw new ProtocolValidationError()
    }
    if (
      options.category === 'model_output_schema_error' &&
      options.stage !== 'task_output_validation' &&
      options.stage !== 'acquisition_output_validation'
    ) {
      throw new ProtocolValidationError()
    }
    if (options.category === 'runner_protocol_error' && options.stage !== 'runner_protocol') {
      throw new ProtocolValidationError()
    }
  }

  const body = {
    schema_version: 1 as const,
    sequence: options.sequence,
    call_kind: options.call_kind,
    stage: options.stage,
    category: options.category,
    provider_code: options.provider_code,
  }

  const content_sha256 = canonicalHash(body)
  const diagnostic: SanitizedFailureDiagnostic = {
    ...body,
    content_sha256,
  }

  return validateSanitizedFailureDiagnostic(diagnostic)
}

export function validateSanitizedFailureDiagnostic(value: unknown): SanitizedFailureDiagnostic {
  assertObject(value)
  assertExactKeys(value, [
    'schema_version',
    'sequence',
    'call_kind',
    'stage',
    'category',
    'provider_code',
    'content_sha256',
  ])

  if (value.schema_version !== 1) throw new ProtocolValidationError()
  assertInteger(value.sequence, 1, 30)

  if (!ALLOWED_CALL_KINDS.includes(value.call_kind as CallKind)) throw new ProtocolValidationError()
  if (!ALLOWED_STAGES.includes(value.stage as FailureStage)) throw new ProtocolValidationError()
  if (!ALLOWED_CATEGORIES.includes(value.category as FailureCategory)) throw new ProtocolValidationError()

  const providerCode = value.provider_code
  if (providerCode !== null) {
    if (typeof providerCode !== 'string' || !(ALLOWED_PROVIDER_CODES as readonly string[]).includes(providerCode)) {
      throw new ProtocolValidationError()
    }
    if (value.stage !== 'provider_stream') throw new ProtocolValidationError()
    if (CODE_TO_CATEGORY_MAP[providerCode as AllowedProviderCode] !== value.category) {
      throw new ProtocolValidationError()
    }
  } else {
    if (
      value.category !== 'model_output_schema_error' &&
      value.category !== 'runner_protocol_error' &&
      value.category !== 'unknown_provider_error'
    ) {
      throw new ProtocolValidationError()
    }
    if (
      value.category === 'model_output_schema_error' &&
      value.stage !== 'task_output_validation' &&
      value.stage !== 'acquisition_output_validation'
    ) {
      throw new ProtocolValidationError()
    }
    if (value.category === 'runner_protocol_error' && value.stage !== 'runner_protocol') {
      throw new ProtocolValidationError()
    }
  }

  assertHash(value.content_sha256)
  const expectedHash = canonicalHash(withoutHash(value, 'content_sha256'))
  if (value.content_sha256 !== expectedHash) {
    throw new ProtocolValidationError()
  }

  assertSanitized(value)
  return value as unknown as SanitizedFailureDiagnostic
}
