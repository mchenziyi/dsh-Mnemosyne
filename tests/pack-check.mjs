import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const artifactDir = new URL('../', import.meta.url)
const names = await readdir(artifactDir)
const tarball = names.find((name) => name.endsWith('.tgz'))
if (!tarball) throw new Error('pack:check: no tarball found')
const { stdout } = await execFileAsync('tar', ['-tzf', join(artifactDir.pathname, tarball)])
const entries = stdout.trim().split('\n').filter(Boolean)
const allowed = /^(package\/(dist\/|cordis\.patch\.yml$|README\.md$|package\.json$))/
const forbidden = entries.filter((entry) => !allowed.test(entry))
if (forbidden.length) throw new Error(`pack:check: unexpected files: ${forbidden.join(', ')}`)
console.log(`pack:check: PASS (${entries.length} files)`)
