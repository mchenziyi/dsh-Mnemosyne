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
  const [projectRoot, projectScopeId, sessionScopeId, factJson] = process.argv.slice(2)

  if (!projectRoot || !projectScopeId || !sessionScopeId || !factJson) {
    process.stderr.write('Usage: node concurrency-worker.mjs <projectRoot> <projectScopeId> <sessionScopeId> <factJson>\n')
    process.exit(2)
  }

  const { openMemoryFactStore } = await import('../../src/memory-store.js')

  try {
    const fact = JSON.parse(factJson)
    const store = openMemoryFactStore({ project_root: projectRoot, project_scope_id: projectScopeId })
    const result = await store.putShortTerm(sessionScopeId, fact)
    process.stdout.write(JSON.stringify(result))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.code || err.message }))
    process.exit(0)
  }
}

main()
