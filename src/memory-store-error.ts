export type MemoryStoreErrorCode =
  | 'memory_store_invalid_input'
  | 'memory_store_scope_mismatch'
  | 'memory_store_path_unsafe'
  | 'memory_store_symlink_rejected'
  | 'memory_store_insecure_permissions'
  | 'memory_store_not_found'
  | 'memory_store_file_too_large'
  | 'memory_store_decode_failed'
  | 'memory_store_hash_mismatch'
  | 'memory_store_noncanonical'
  | 'memory_store_identity_conflict'
  | 'memory_store_io_failed'
  | 'memory_compile_invalid_input'
  | 'memory_compile_busy'
  | 'memory_compile_not_found'
  | 'memory_compile_path_unsafe'
  | 'memory_compile_symlink_rejected'
  | 'memory_compile_insecure_permissions'
  | 'memory_compile_decode_failed'
  | 'memory_compile_hash_mismatch'
  | 'memory_compile_noncanonical'
  | 'memory_compile_identity_conflict'
  | 'memory_compile_generation_incomplete'
  | 'memory_compile_current_invalid'
  | 'memory_compile_io_failed'

const ERROR_MESSAGES: Record<MemoryStoreErrorCode, string> = {
  memory_store_invalid_input: 'Memory fact input is invalid',
  memory_store_scope_mismatch: 'Memory scope mismatch',
  memory_store_path_unsafe: 'Memory store path is unsafe',
  memory_store_symlink_rejected: 'Symlink path is rejected in memory store',
  memory_store_insecure_permissions: 'Insecure permissions on memory store path',
  memory_store_not_found: 'Memory fact not found',
  memory_store_file_too_large: 'Memory fact file exceeds maximum allowed size',
  memory_store_decode_failed: 'Memory fact decoding failed',
  memory_store_hash_mismatch: 'Memory fact hash mismatch',
  memory_store_noncanonical: 'Memory fact bytes are not canonical',
  memory_store_identity_conflict: 'Memory fact identity conflict',
  memory_store_io_failed: 'Memory store I/O operation failed',
  memory_compile_invalid_input: 'Memory compile input is invalid',
  memory_compile_busy: 'Memory compilation is in progress by another process',
  memory_compile_not_found: 'Compiled memory generation or manifest not found',
  memory_compile_path_unsafe: 'Memory compile path is unsafe',
  memory_compile_symlink_rejected: 'Symlink path is rejected during memory compilation',
  memory_compile_insecure_permissions: 'Insecure permissions on memory compilation path',
  memory_compile_decode_failed: 'Memory compile decoding failed',
  memory_compile_hash_mismatch: 'Memory compile hash mismatch',
  memory_compile_noncanonical: 'Memory compile file bytes are not canonical',
  memory_compile_identity_conflict: 'Memory compile identity conflict',
  memory_compile_generation_incomplete: 'Memory generation output is incomplete or corrupted',
  memory_compile_current_invalid: 'Memory CURRENT pointer is invalid',
  memory_compile_io_failed: 'Memory compile I/O operation failed',
}

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode
  override readonly cause?: unknown

  constructor(code: MemoryStoreErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code] || 'Memory store error')
    this.name = 'MemoryStoreError'
    this.code = code
    this.cause = cause
  }
}

export function isMemoryStoreErrorCode(value: unknown): value is MemoryStoreErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, value)
}
