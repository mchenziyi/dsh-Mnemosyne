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

const [projectRoot, projectScopeId, memoryId, contentSha256] = process.argv.slice(2)
const { computeProjectScopeId } = await import('../../src/runtime-scope.js')
const { createGovernanceProductionRuntimeV1 } = await import('../../src/governance/runtime.js')

try {
  if (computeProjectScopeId(projectRoot) !== projectScopeId) throw new Error('scope_mismatch')
  const runtime = createGovernanceProductionRuntimeV1()
  const result = await runtime.commit({
    scope: { project_root: projectRoot, project_scope_id: projectScopeId },
    payload: { action: 'deactivate', memory: { memory_id: memoryId, content_sha256: contentSha256 } },
    evidence_refs: [{ kind: 'memory', memory_id: memoryId, content_sha256: contentSha256 }],
    reason_code: 'concurrent_test',
    created_at: new Date().toISOString(),
  })
  process.stdout.write(JSON.stringify({ status: 'committed', sequence: result.event.sequence }))
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 'failed', code: error?.code ?? error?.message ?? 'unknown' }))
}
