export declare const name: 'canary-resume-headless-driver'
export declare const inject: readonly ['agents', 'sessions']
export declare function apply(
  ctx: any,
  config: {
    resumeSessionId?: string
    expectedCwd?: string
    task?: string
    runId?: 'run_2' | 'run_3'
    expectedModuleSha256?: string
  }
): void
