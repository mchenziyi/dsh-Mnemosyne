export declare const name: 'canary-audit-sidecar'
export declare const inject: readonly ['sessionPersistence', 'llm']
export declare function apply(
  ctx: any,
  config: {
    evidenceDir: string
    runId: string
    expectedModuleSha256?: string
  }
): void
