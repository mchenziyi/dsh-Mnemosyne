import { register } from 'node:module'

const loaderCode = `
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
`

const loaderDataUrl = 'data:text/javascript,' + encodeURIComponent(loaderCode)
register(loaderDataUrl, import.meta.url)

async function main() {
  const [projectRoot, projectScopeId, evaluationAt] = process.argv.slice(2)

  if (!projectRoot || !projectScopeId || !evaluationAt) {
    process.stderr.write('Usage: node generation-worker.mjs <projectRoot> <projectScopeId> <evaluationAt>\n')
    process.exit(2)
  }

  const { createOKFCompiler } = await import('../../src/okf-compiler.js')

  try {
    const compiler = createOKFCompiler()
    const result = await compiler.compile({
      project_root: projectRoot,
      project_scope_id: projectScopeId,
      evaluation_at: evaluationAt,
      compiler_version: 'dsh-mnemosyne-okf/1',
    })
    process.stdout.write(JSON.stringify(result))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.code || err.message }))
    process.exit(0)
  }
}

main()
