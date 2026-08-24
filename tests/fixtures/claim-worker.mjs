import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
const tsPath = req.resolve('typescript')

const loaderCode = `
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '${pathToFileURL(tsPath).href}';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
      const tsSpecifier = specifier.slice(0, -3) + '.ts';
      try {
        return await nextResolve(tsSpecifier, context);
      } catch {}
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const filePath = fileURLToPath(url);
    const source = await readFile(filePath, 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      fileName: filePath,
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: result.outputText,
    };
  }
  return nextLoad(url, context);
}
`

const loaderDataUrl = 'data:text/javascript,' + encodeURIComponent(loaderCode)
register(loaderDataUrl, import.meta.url)

async function main() {
  const args = process.argv.slice(2)
  const flags = new Map()
  for (let i = 0; i < args.length; i += 2) {
    flags.set(args[i], args[i + 1])
  }

  const root = flags.get('--persistence-root')
  const authSha = flags.get('--auth-sha')
  const appSha = flags.get('--approval-sha')
  const rootSha = flags.get('--root-sha')
  const claimedAt = flags.get('--claimed-at')

  if (!root || !authSha || !appSha || !rootSha || !claimedAt) {
    console.error('Missing required arguments in claim worker')
    process.exit(2)
  }

  const { createRealCanaryExecutionClaim } = await import('../../src/m05d2/approval.js')
  const { persistExecutionClaim } = await import('../../src/m05d2/persistence.js')

  try {
    const claim = createRealCanaryExecutionClaim({
      authorization_sha256: authSha,
      approval_sha256: appSha,
      execution_root_sha256: rootSha,
      claimed_at: claimedAt,
    })

    await persistExecutionClaim(root, claim)
    console.log('CLAIM_CREATED')
    process.exit(0)
  } catch {
    console.error('CLAIM_CONFLICT')
    process.exit(1)
  }
}

main()
