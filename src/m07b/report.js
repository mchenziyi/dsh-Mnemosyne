import { readFile, writeFile } from 'node:fs/promises'
import { validateRedactedCanaryReport } from './canary-protocol.js'

export async function writeRedactedCanaryReport(reportPath, report) {
  const validated = validateRedactedCanaryReport(report)
  const payload = JSON.stringify(validated, null, 2) + '\n'

  // Write with exclusive creation (no-overwrite)
  await writeFile(reportPath, payload, { flag: 'wx' })
}

export async function readRedactedCanaryReport(reportPath) {
  const raw = await readFile(reportPath, 'utf8')
  const parsed = JSON.parse(raw)
  return validateRedactedCanaryReport(parsed)
}
