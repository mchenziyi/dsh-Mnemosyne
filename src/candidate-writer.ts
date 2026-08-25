import type { ResolvedScope } from './runtime-scope.js'
import {
  computeCandidateFingerprint,
  type RememberCandidate,
} from './protocol/acquisition.js'
import { openMemoryFactStore, type MemoryFactStore } from './memory-store.js'
import { createOKFCompiler, type OKFCompiler } from './okf-compiler.js'
import { COMPILER_VERSION } from './okf-schema.js'
import { computeFactHash, type ShortTermMemoryFact } from './memory-fact.js'
import { MemoryStoreError } from './memory-store-error.js'

export interface CandidateWriterOptions {
  storeFactory?: (scope: ResolvedScope) => MemoryFactStore
  compiler?: OKFCompiler
}

export interface WriteCandidateParams {
  source: 'auto' | 'manual'
  scope: ResolvedScope
  candidate: RememberCandidate
  eventKey: string
  candidateSha256: string
  memoryId: string
  createdAt: string
}

export interface WriteCandidateResult {
  status: 'created' | 'noop'
  memory_id: string
  content_sha256: string
  generation_id: string
}

export interface CandidateWriter {
  write(params: WriteCandidateParams): Promise<WriteCandidateResult>
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export function createCandidateWriter(options: CandidateWriterOptions = {}): CandidateWriter {
  const storeFactory = options.storeFactory ?? ((scope: ResolvedScope) =>
    openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  )
  const compiler = options.compiler ?? createOKFCompiler()

  // Project-level mutex chain to serialize "check + write" and prevent concurrency TOCTOU
  let writeQueue: Promise<unknown> = Promise.resolve()

  async function executeWrite(params: WriteCandidateParams): Promise<WriteCandidateResult> {
    const { scope, candidate, memoryId, createdAt } = params
    const store = storeFactory(scope)
    const candidateFp = computeCandidateFingerprint(candidate)

    // 1. Exact candidate deduplication check against existing short-term and long-term facts
    let existingShortTerm: ShortTermMemoryFact[] = []
    let existingLongTerm: unknown[] = []
    try {
      existingShortTerm = await store.listShortTerm(scope.session_scope_id, createdAt)
      existingLongTerm = await store.listLongTerm()
    } catch (err: unknown) {
      throw new MemoryStoreError('memory_store_io_failed', err)
    }

    const existingMatch =
      existingShortTerm.find((f) => {
        try {
          return computeCandidateFingerprint({ title: f.title, summary: f.summary, body: f.body, tags: f.tags }) === candidateFp
        } catch {
          return false
        }
      }) ||
      (existingLongTerm.find((f: any) => {
        try {
          return computeCandidateFingerprint({ title: f.title, summary: f.summary, body: f.body, tags: f.tags }) === candidateFp
        } catch {
          return false
        }
      }) as ShortTermMemoryFact | undefined)

    if (existingMatch) {
      // Re-compile or ensure generation is up to date and return noop
      let compileRes
      try {
        compileRes = await compiler.compile({
          project_root: scope.project_root,
          project_scope_id: scope.project_scope_id,
          evaluation_at: createdAt,
          compiler_version: COMPILER_VERSION,
        })
      } catch (err: unknown) {
        throw new MemoryStoreError('memory_compile_io_failed', err)
      }

      return {
        status: 'noop',
        memory_id: existingMatch.memory_id,
        content_sha256: existingMatch.content_sha256,
        generation_id: compileRes.generation_id,
      }
    }

    // 2. Construct ShortTermMemoryFact with programmatically frozen identity & 7-day TTL
    const expiresAt = new Date(Date.parse(createdAt) + SEVEN_DAYS_MS).toISOString()
    const baseFact = {
      schema_version: 1 as const,
      tier: 'short_term' as const,
      memory_id: memoryId,
      project_scope_id: scope.project_scope_id,
      session_scope_id: scope.session_scope_id,
      title: candidate.title,
      summary: candidate.summary,
      body: candidate.body,
      tags: candidate.tags,
      created_at: createdAt,
      expires_at: expiresAt,
      content_sha256: 'sha256_' + '0'.repeat(64),
    }
    const contentHash = computeFactHash(baseFact)
    const fact: ShortTermMemoryFact = { ...baseFact, content_sha256: contentHash }

    // 3. Put short-term Fact into Store
    const writeRes = await store.putShortTerm(scope.session_scope_id, fact)

    // 4. Compile OKF Generation
    let compileRes
    try {
      compileRes = await compiler.compile({
        project_root: scope.project_root,
        project_scope_id: scope.project_scope_id,
        evaluation_at: createdAt,
        compiler_version: COMPILER_VERSION,
      })
    } catch (err: unknown) {
      // Fact is published and immutable. Throw compile error so caller fails closed while Fact remains.
      throw new MemoryStoreError('memory_compile_io_failed', err)
    }

    return {
      status: writeRes.status,
      memory_id: fact.memory_id,
      content_sha256: fact.content_sha256,
      generation_id: compileRes.generation_id,
    }
  }

  return {
    async write(params: WriteCandidateParams): Promise<WriteCandidateResult> {
      // Chain promise to serialize candidate writes per plugin instance
      const current = writeQueue.then(
        () => executeWrite(params),
        () => executeWrite(params)
      )
      writeQueue = current.catch(() => {})
      return await current
    },
  }
}
