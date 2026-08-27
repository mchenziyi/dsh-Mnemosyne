import { readFile, writeFile } from 'node:fs/promises'
import { validateRedactedCanaryReport, validateRedactedCanaryReportV2 } from './canary-protocol.js'

export async function writeRedactedCanaryReport(reportPath, report) {
  const validated =
    report && report.schema_version === 2
      ? validateRedactedCanaryReportV2(report)
      : validateRedactedCanaryReport(report)
  const payload = JSON.stringify(validated, null, 2) + '\n'

  // Write with exclusive creation (no-overwrite)
  await writeFile(reportPath, payload, { flag: 'wx' })
}

export async function readRedactedCanaryReport(reportPath) {
  const raw = await readFile(reportPath, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed && parsed.schema_version === 2) {
    return validateRedactedCanaryReportV2(parsed)
  }
  return validateRedactedCanaryReport(parsed)
}
