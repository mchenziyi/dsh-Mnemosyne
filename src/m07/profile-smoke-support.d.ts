export const SMOKE_TIMEOUT_MS: number
export const SMOKE_MAX_BUFFER: number
export const SMOKE_ERROR_ALLOWLIST: ReadonlySet<string>

export class SmokeError extends Error {
  readonly code: string
  constructor(code: string)
}

export function mapSmokeError(err: unknown): string
export function countLayersInDump(dumpText: string): number
export function verifyProfileDependencyBinding(
  depVal: unknown,
  profileDir: string,
  expectedRealTarballPath: string
): Promise<true>
export function cleanupRunRoot(runRoot: string): Promise<{ success: boolean; reason?: string }>
export function runInstalledRuntimeSmoke(
  profileDir: string,
  sanitizedEnv: Record<string, string>
): Promise<void>
