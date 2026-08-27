export interface RunRootLayout {
  readonly rootPath: string
  readonly rootIdentity: string
  readonly homePath: string
  readonly dshHomePath: string
  readonly tmpPath: string
  readonly projectAPath: string
  readonly projectBPath: string
  readonly evidencePath: string
}

export interface CredentialMetadata {
  readonly valid: true
  readonly mode: '0600'
  readonly size: number
}

export interface CleanupResult {
  readonly success: boolean
  readonly reason?: string
}

export declare function setupRunRootLayout(parentDir: string, runRootName?: string): Promise<RunRootLayout>
export declare function verifyCredentialMetadataOnly(dshHome: string): Promise<CredentialMetadata>
export declare function cleanupRunRoot(rootPath: string, expectedRootIdentity?: string): Promise<CleanupResult>

export declare function isInsideOrSameDirectory(parent: string, child: string): boolean
export declare function resolveExecutableRealpath(executableNameOrPath: string): Promise<string>
export declare function createSanitizedEnv(overrides?: Record<string, string | undefined>, baseEnv?: Record<string, string | undefined>): Record<string, string>
export declare function spawnProcessGroup(cmd: string, args?: string[], options?: { cwd?: string; env?: Record<string, string>; timeout?: number; maxBuffer?: number; killOptions?: { graceMs?: number; pollIntervalMs?: number; maxWaitMs?: number; isAliveForTesting?: (pid: number) => boolean } }): Promise<{ promise: Promise<{ stdout: string; stderr: string; exitCode: number }>; child: any; pid?: number }>
export declare function killProcessGroup(pidOrChild: number | { pid?: number }, options?: { graceMs?: number; pollIntervalMs?: number; maxWaitMs?: number; isAliveForTesting?: (pid: number) => boolean }): Promise<void>
