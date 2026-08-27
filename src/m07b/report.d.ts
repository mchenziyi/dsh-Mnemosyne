import type { RedactedCanaryReport, RedactedCanaryReportV2 } from './canary-protocol.js'

export declare function writeRedactedCanaryReport(
  reportPath: string,
  report: RedactedCanaryReport | RedactedCanaryReportV2
): Promise<void>

export declare function readRedactedCanaryReport(
  reportPath: string
): Promise<RedactedCanaryReport | RedactedCanaryReportV2>
