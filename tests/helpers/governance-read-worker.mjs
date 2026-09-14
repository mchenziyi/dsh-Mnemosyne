import { register } from 'node:module'

const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context) } catch (error) {
    if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
      try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}
    }
    throw error
  }
}
`
register('data:text/javascript,' + encodeURIComponent(loaderCode), import.meta.url)

const [projectRoot, projectScopeId] = process.argv.slice(2)
const { readCurrentVersionedGenerationV1 } = await import('../../src/v2/versioned-generation-store.js')

try {
  const world = await readCurrentVersionedGenerationV1({ project_root: projectRoot, project_scope_id: projectScopeId })
  process.stdout.write(JSON.stringify({ kind: world.kind, generation_id: world.generation_id, sequence: world.governance_head?.sequence ?? null, visible: world.visible_memory_refs.map((ref) => ref.memory_id) }))
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error?.code ?? error?.message ?? 'unknown' }))
}
