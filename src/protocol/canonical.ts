import { createHash } from 'node:crypto'

export class ProtocolValidationError extends Error {
  readonly code = 'protocol_invalid'
  constructor(message = 'protocol validation failed') {
    super(message)
    this.name = 'ProtocolValidationError'
  }
}

const invalid = (message = 'protocol validation failed'): never => {
  throw new ProtocolValidationError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || 'get' in descriptor || 'set' in descriptor) return false
  }
  return true
}

export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const delta = a[index].codePointAt(0)! - b[index].codePointAt(0)!
    if (delta) return delta
  }
  return a.length - b.length
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    if (Object.is(value, -0)) return 0
    // JSON.stringify uses exponent notation outside this interval. Rejecting it
    // keeps the v1 byte protocol independent of a producer's number formatter.
    if (value !== 0 && (Math.abs(value) >= 1e21 || Math.abs(value) < 1e-6)) invalid()
    return value
  }
  if (typeof value !== 'object') invalid()
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) invalid()
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!(index in value)) invalid()
    return value.map(canonicalValue)
  }
  if (!isPlainObject(value)) invalid()
  const object = value as Record<string, unknown>
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(object).sort(compareCodePoints)) {
    Object.defineProperty(result, key, { value: canonicalValue(object[key]), enumerable: true, writable: true, configurable: true })
  }
  return result
}

export function canonicalBytes(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function sha256(value: string): string {
  return `sha256_${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalBytes(value))
}

export function withoutHash(value: Record<string, unknown>, key = 'content_sha256'): Record<string, unknown> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

export function assertExactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) invalid()
  const object = value as Record<string, unknown>
  const actual = Object.keys(object).sort(compareCodePoints)
  const expected = [...keys].sort(compareCodePoints)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid()
}

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) invalid()
}

export function assertString(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) invalid()
}

export function assertInteger(value: unknown, min: number = 0, max: number = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
}

export function assertEnum(value: unknown, values: readonly string[]): asserts value is string {
  if (typeof value !== 'string' || !values.includes(value)) invalid()
}

export function assertId(value: unknown, prefix: string): asserts value is string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[a-z0-9][a-z0-9._-]{0,63}$`).test(value)) invalid()
}

export function assertHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256_[0-9a-f]{64}$/.test(value)) invalid()
}

export function assertArray(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid()
  const array = value as unknown[]
  for (let index = 0; index < array.length; index++) if (!(index in array)) invalid()
}

export function assertNoDuplicate(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid()
}

export function sortedUnique(values: readonly string[]): string[] {
  assertNoDuplicate(values)
  return [...values].sort(compareCodePoints)
}

export function containsSensitiveText(value: string): boolean {
  return /(?:bearer\s+[a-z0-9._-]{8,}|-----begin\s+(?:rsa|ec|openssh|private)|(?:password|passwd|token|api[_-]?key|secret)\s*[:=]|(?:^|\s)(?:rm\s+-rf|curl\s+|wget\s+|git\s+(?:commit|push|reset)|(?:npm|pnpm|yarn|go|python3?)\s+(?:run|install|test|build))|(?:\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|\/etc\/|[A-Za-z]:\\Users\\))/i.test(value)
}

export function assertSafeText(value: unknown, max: number): asserts value is string {
  assertString(value, max)
  if (value.length === 0) invalid()
  if (containsSensitiveText(value)) invalid()
}

export function parseStrict<T>(value: unknown, validate: (value: unknown) => T): T {
  return validate(value)
}
