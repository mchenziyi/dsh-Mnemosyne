import type { RedactedCanaryReport } from './canary-protocol.js'

export declare function writeRedactedCanaryReport(
  reportPath: string,
  report: RedactedCanaryReport
): Promise<void>

export declare function readRedactedCanaryReport(
  reportPath: string
): Promise<RedactedCanaryReport>
