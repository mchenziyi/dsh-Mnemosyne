// tsdown's CJS declaration pass currently emits plain ESM imports for the
// bundled library's external type-only dependencies. In a `.d.cts` file those
// are interpreted as `require()` calls, which breaks strict CJS consumers when
// the referenced packages are ESM-only. Convert these declaration imports to
// type-only resolution-mode imports so CJS TypeScript resolution is valid.
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../dist/index.d.cts', import.meta.url)
let source = await readFile(file, 'utf8')

source = source.replace(
  'import { Context } from "@deepseek-ai/cordis";',
  'import type { Context } from "@deepseek-ai/cordis" with { "resolution-mode": "import" };',
)
source = source.replace(
  'import z from "@deepseek-ai/schemastery";',
  'import type z from "@deepseek-ai/schemastery" with { "resolution-mode": "import" };',
)

await writeFile(file, source)
