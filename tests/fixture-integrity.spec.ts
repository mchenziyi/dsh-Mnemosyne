import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFixtureManifest, validateEvaluationProtocol, validateFixtureManifest, validateMemoryCatalog, validatePairedTasks, validateRetrievalCases, validateFixtureSet, fixtureManifestHash } from '../src/protocol/evaluation.js'

const root = resolve(process.cwd(), 'fixtures/m0.5/v1')
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(root, name), 'utf8'))

describe('M0.5A synthetic fixture set', () => {
  it('closes all references and verifies the immutable five-document manifest', () => {
    const protocol = validateEvaluationProtocol(read('protocol.json'))
    const catalog = validateMemoryCatalog(read('memory-catalog.json'))
    const cases = validateRetrievalCases(read('retrieval-cases.json'))
    const tasks = validatePairedTasks(read('paired-tasks.json'))
    const manifest = validateFixtureManifest(read('fixture-manifest.json'))
    const expected = createFixtureManifest(protocol, catalog, cases, tasks)
    expect(expected).toEqual(manifest)
    const fixture = validateFixtureSet({ protocol, memoryCatalog: catalog, retrievalCases: cases, pairedTasks: tasks, manifest })
    expect(fixture.manifest).toEqual(manifest)
    expect(fixtureManifestHash(manifest)).toMatch(/^sha256_[0-9a-f]{64}$/)
    expect(cases.cases.filter((item) => ['rephrase', 'alias', 'cross_component'].includes(item.difficulty)).length).toBeGreaterThanOrEqual(12)
    expect(() => validateFixtureSet({ protocol, memoryCatalog: catalog, retrievalCases: cases, pairedTasks: tasks } as never)).toThrow()
  })

  it('rejects manifest hash drift without modifying fixture files', () => {
    const manifest = read('fixture-manifest.json') as Record<string, unknown>
    const files = manifest.files as Array<Record<string, unknown>>
    const protocol = validateEvaluationProtocol(read('protocol.json'))
    const catalog = validateMemoryCatalog(read('memory-catalog.json'))
    const cases = validateRetrievalCases(read('retrieval-cases.json'))
    const tasks = validatePairedTasks(read('paired-tasks.json'))
    expect(() => validateFixtureSet({ protocol, memoryCatalog: catalog, retrievalCases: cases, pairedTasks: tasks, manifest: { ...manifest, files: files.map((file) => file.relative_name === 'protocol.json' ? { ...file, content_sha256: 'sha256_' + 'f'.repeat(64) } : file) } as never })).toThrow()
  })

  it('validates all four input documents before creating a manifest', () => {
    const protocol = validateEvaluationProtocol(read('protocol.json'))
    const catalog = validateMemoryCatalog(read('memory-catalog.json'))
    const cases = validateRetrievalCases(read('retrieval-cases.json'))
    const tasks = validatePairedTasks(read('paired-tasks.json'))
    expect(() => createFixtureManifest(protocol, { ...catalog, memories: [] } as never, cases, tasks)).toThrow()
  })
})
