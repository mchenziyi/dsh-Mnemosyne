import { readdir, readFile, writeFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const runtimeName = (await readdir(dist)).find((name) => /^rolldown-runtime(?:-[^.]+)?\.cjs$/.test(name))
const [client, remote] = await Promise.all([
  readFile(new URL('client.cjs', dist), 'utf8'),
  readFile(new URL('typert.remote-client.cjs', dist), 'utf8'),
])
const runtime = runtimeName ? await readFile(new URL(runtimeName, dist), 'utf8') : null

const chunk = (source) => `(() => {\n  const module = { exports: {} };\n  let exports = module.exports;\n${source}\n  return module.exports;\n})()`
const body = client
  .replace(/^const require_rolldown_runtime = require\("\.\/rolldown-runtime(?:-[^"]+)?\.cjs"\);\n/m, '')
  .replace(/^const require_typert_remote_client = require\("\.\/typert\.remote-client\.cjs"\);\n/m, '')
const runtimeChunk = runtime === null ? '' : `    const require_rolldown_runtime = ${chunk(runtime)};\n`
const wrapped = `window.__ModuleLoader__.load({\n  id: "@cziyi/dsh-mnemosyne",\n  factory: (require) => {\n    const module = { exports: {} };\n    let exports = module.exports;\n    const process = { env: { NODE_ENV: "production" } };\n${runtimeChunk}    const require_typert_remote_client = ${chunk(remote)};\n${body}\n    return module.exports;\n  },\n});\n`
await writeFile(new URL('client.mjs', dist), wrapped)
