import { computeProjectScopeId } from './canary-protocol.js'
import { openMemoryFactStore } from '../memory-store.js'
import { readCurrentPointer, verifyAndLoadGenerationWorld } from '../generation-store.js'

export async function inspectFactStoreState(projectRoot) {
  const project_scope_id = computeProjectScopeId(projectRoot)
  const store = openMemoryFactStore({ project_root: projectRoot, project_scope_id })

  const sessions = await store.listShortTermSessionScopes()
  const now = new Date().toISOString()
  const shortTerm = []
  for (const s of sessions) {
    const facts = await store.listShortTerm(s, now)
    shortTerm.push(...facts)
  }
  const longTerm = await store.listLongTerm()
  const forget = await store.listForget()

  return {
    project_scope_id,
    shortTerm,
    longTerm,
    forget,
  }
}

export async function inspectCurrentGeneration(projectRoot) {
  const project_scope_id = computeProjectScopeId(projectRoot)
  const current = await readCurrentPointer(projectRoot, project_scope_id)
  if (!current) {
    return null
  }

  const world = await verifyAndLoadGenerationWorld(projectRoot, current.generation_id, project_scope_id)
  return {
    current,
    world,
  }
}
