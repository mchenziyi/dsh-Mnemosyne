import { describe, expect, it } from 'vitest'
import {
  computeOKFCatalogNodeIdV1,
  computeOKFCatalogV1Hash,
  validateOKFCatalogV1,
  type OKFCatalogNodeV1,
  type OKFCatalogV1,
} from '../src/v2/okf-catalog.js'

const scope = `sha256_${'7'.repeat(64)}`

function catalog(nodes: OKFCatalogNodeV1[]): OKFCatalogV1 {
  const value: OKFCatalogV1 = {
    schema_version: 1,
    project_scope_id: scope,
    root_node_id: 'node_root',
    nodes,
    updated_at: '2026-08-31T03:00:00.000Z',
    content_sha256: '',
  }
  value.content_sha256 = computeOKFCatalogV1Hash(value)
  return value
}

describe('v0.2 catalog closure', () => {
  it('derives deterministic path-bound IDs for same-titled nodes under different parents', () => {
    const backend = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Backend')
    const frontend = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Frontend')
    const backendConfiguration = computeOKFCatalogNodeIdV1(scope, backend, 'Configuration')
    const frontendConfiguration = computeOKFCatalogNodeIdV1(scope, frontend, 'Configuration')

    expect(backendConfiguration).not.toBe(frontendConfiguration)
    expect(computeOKFCatalogNodeIdV1(scope, backend, 'Configuration')).toBe(backendConfiguration)
    expect(() => validateOKFCatalogV1(catalog([
      { node_id: 'node_root', title: '项目记忆', summary: '项目记忆。', parent_node_id: null, child_node_refs: [backend, frontend], memory_refs: [] },
      { node_id: backend, title: 'Backend', summary: '后端。', parent_node_id: 'node_root', child_node_refs: [backendConfiguration], memory_refs: [] },
      { node_id: frontend, title: 'Frontend', summary: '前端。', parent_node_id: 'node_root', child_node_refs: [frontendConfiguration], memory_refs: [] },
      { node_id: backendConfiguration, title: 'Configuration', summary: '后端配置。', parent_node_id: backend, child_node_refs: [], memory_refs: [] },
      { node_id: frontendConfiguration, title: 'Configuration', summary: '前端配置。', parent_node_id: frontend, child_node_refs: [], memory_refs: [] },
    ]))).not.toThrow()
  })

  it('accepts depth three and rejects depth four', () => {
    const level1 = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Authentication')
    const level2 = computeOKFCatalogNodeIdV1(scope, level1, 'JWT')
    const level3 = computeOKFCatalogNodeIdV1(scope, level2, 'Refresh Token')
    const validNodes: OKFCatalogNodeV1[] = [
      { node_id: 'node_root', title: '项目记忆', summary: '项目记忆。', parent_node_id: null, child_node_refs: [level1], memory_refs: [] },
      { node_id: level1, title: 'Authentication', summary: '认证。', parent_node_id: 'node_root', child_node_refs: [level2], memory_refs: [] },
      { node_id: level2, title: 'JWT', summary: '令牌。', parent_node_id: level1, child_node_refs: [level3], memory_refs: [] },
      { node_id: level3, title: 'Refresh Token', summary: '刷新令牌。', parent_node_id: level2, child_node_refs: [], memory_refs: [] },
    ]
    expect(() => validateOKFCatalogV1(catalog(validNodes))).not.toThrow()

    const level4 = computeOKFCatalogNodeIdV1(scope, level3, 'Rotation')
    const tooDeep = structuredClone(validNodes)
    tooDeep[3]!.child_node_refs = [level4]
    tooDeep.push({ node_id: level4, title: 'Rotation', summary: '轮换。', parent_node_id: level3, child_node_refs: [], memory_refs: [] })
    expect(() => computeOKFCatalogV1Hash(catalog(tooDeep))).toThrow()
  })

  it('rejects a node ID that is not derived from its project, parent, and title', () => {
    const valid = computeOKFCatalogNodeIdV1(scope, 'node_root', 'Dependencies')
    expect(() => catalog([
      { node_id: 'node_root', title: '项目记忆', summary: '项目记忆。', parent_node_id: null, child_node_refs: [valid], memory_refs: [] },
      { node_id: valid, title: 'Changed Title', summary: '依赖。', parent_node_id: 'node_root', child_node_refs: [], memory_refs: [] },
    ])).toThrow()
  })
})
