import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { canonicalBytes, canonicalHash } from './protocol/canonical.js'
import { MemoryStoreError } from './memory-store-error.js'
import { openMemoryFactStore } from './memory-store.js'
import {
  getGenerationLayout,
  readStrictFile,
  readVerifiedCurrentWorld,
  readVerifiedGenerationWorld,
} from './generation-store.js'
import { executeOKFSearch } from './okf-search.js'
import {
  canonicalizeOpenDisclosure,
  computeOpenDisclosureId,
  validateOpenDisclosure,
  validateOpenInput,
  type OKFGenerationRef,
  type OKFMemoryRef,
  type OKFOpenDisclosure,
  type OKFOpenInput,
  type OKFSearchDisclosure,
  type OKFSearchInput,
} from './protocol/okf-retrieval.js'
import type { ScopeRuntime } from './runtime-scope.js'

export interface DisclosureGrant {
  retrievalId: string
  searchDisclosureSHA256: string
  projectRoot: string
  projectScopeId: string
  sessionScopeId: string
  generationRef: OKFGenerationRef
  allowedMemoryRefs: readonly OKFMemoryRef[]
}

export interface ProductionRetrievalRuntime {
  search(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFSearchDisclosure>
  open(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFOpenDisclosure>
  clear(): void
}

export interface RetrievalTestHooks {
  simulatePageTamperingBeforeRead?: boolean
}

let activeTestHooks: RetrievalTestHooks | null = null

export function __setRetrievalTestHooks(hooks: RetrievalTestHooks | null): void {
  activeTestHooks = hooks
}

const MAX_REGISTRY_GRANTS = 256

export function createProductionRetrievalRuntime(scopeRuntime: ScopeRuntime): ProductionRetrievalRuntime {
  // Registry map with fixed capacity of 256 and deterministic FIFO eviction
  const grants = new Map<string, DisclosureGrant>()

  return {
    async search(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFSearchDisclosure> {
      const resolution = scopeRuntime.resolveExecution(exec)
      if (resolution.status !== 'ready') {
        throw new MemoryStoreError('memory_store_scope_mismatch', new Error(`scope ${resolution.status}: ${resolution.reason}`))
      }

      const { project_root, project_scope_id, session_scope_id } = resolution.scope
      const currentWorld = await readVerifiedCurrentWorld(project_root, project_scope_id)

      if (!currentWorld) {
        return executeOKFSearch({
          index: null,
          generationRef: null,
          projectScopeId: project_scope_id,
          sessionScopeId: session_scope_id,
          searchParams: rawArgs as OKFSearchInput,
        })
      }

      const generationRef: OKFGenerationRef = {
        generation_id: currentWorld.generation.generation_id,
        generation_sha256: currentWorld.generation.content_sha256,
        manifest_id: currentWorld.generation.manifest_id,
        manifest_sha256: currentWorld.generation.manifest_sha256,
        index_sha256: currentWorld.index.content_sha256,
      }

      const searchResult = executeOKFSearch({
        index: currentWorld.index,
        generationRef,
        projectScopeId: project_scope_id,
        sessionScopeId: session_scope_id,
        searchParams: rawArgs as OKFSearchInput,
      })
      if (searchResult.items.length > 0) {
        const grantKey = `${searchResult.retrieval_id}:${searchResult.content_sha256}`
        if (!grants.has(grantKey)) {
          if (grants.size >= MAX_REGISTRY_GRANTS) {
            const oldestKey = grants.keys().next().value
            if (oldestKey !== undefined) {
              grants.delete(oldestKey)
            }
          }
        }
        grants.set(grantKey, {
          retrievalId: searchResult.retrieval_id,
          searchDisclosureSHA256: searchResult.content_sha256,
          projectRoot: project_root,
          projectScopeId: project_scope_id,
          sessionScopeId: session_scope_id,
          generationRef,
          allowedMemoryRefs: searchResult.items.map((item) => item.memory_ref),
        })
      }

      return searchResult
    },

    async open(rawArgs: unknown, exec?: ToolRunContext): Promise<OKFOpenDisclosure> {
      const input = validateOpenInput(rawArgs)
      const resolution = scopeRuntime.resolveExecution(exec)
      if (resolution.status !== 'ready') {
        throw new MemoryStoreError('memory_store_scope_mismatch', new Error(`scope ${resolution.status}: ${resolution.reason}`))
      }

      const { project_root, project_scope_id, session_scope_id } = resolution.scope
      const grantKey = `${input.retrieval_id}:${input.search_disclosure_sha256}`
      const grant = grants.get(grantKey)

      if (!grant) {
        throw new MemoryStoreError('memory_store_not_found', new Error('no matching search disclosure grant found in registry'))
      }

      if (
        grant.projectRoot !== project_root ||
        grant.projectScopeId !== project_scope_id ||
        grant.sessionScopeId !== session_scope_id
      ) {
        throw new MemoryStoreError('memory_store_scope_mismatch', new Error('scope mismatch for search disclosure grant'))
      }

      const targetMemRef = grant.allowedMemoryRefs.find((ref) => ref.memory_id === input.memory_id)
      if (!targetMemRef) {
        throw new MemoryStoreError('memory_store_not_found', new Error(`memory ${input.memory_id} was not returned by parent search disclosure`))
      }

      // Re-verify the historical Generation fixed by the Search Disclosure grant
      const fixedWorld = await readVerifiedGenerationWorld(
        grant.projectRoot,
        grant.generationRef.generation_id,
        grant.projectScopeId
      )

      if (
        fixedWorld.generation.content_sha256 !== grant.generationRef.generation_sha256 ||
        fixedWorld.manifest.content_sha256 !== grant.generationRef.manifest_sha256 ||
        fixedWorld.index.content_sha256 !== grant.generationRef.index_sha256
      ) {
        throw new MemoryStoreError('memory_compile_hash_mismatch', new Error('historical generation identity drifted from grant'))
      }

      const indexEntry = fixedWorld.index.entries.find((e) => e.memory_id === input.memory_id)
      if (!indexEntry) {
        throw new MemoryStoreError('memory_store_not_found', new Error('memory not found in verified index'))
      }

      const store = openMemoryFactStore({
        project_root: grant.projectRoot,
        project_scope_id: grant.projectScopeId,
      })

      let fact
      if (targetMemRef.tier === 'short_term') {
        fact = await store.getShortTerm(targetMemRef.session_scope_id!, input.memory_id)
      } else {
        fact = await store.getLongTerm(input.memory_id)
      }

      if (!fact || fact.content_sha256 !== targetMemRef.content_sha256) {
        throw new MemoryStoreError('memory_compile_hash_mismatch', new Error('fact content sha mismatch'))
      }

      // Verify Markdown page in manifest outputs and on disk in the fixed generation directory
      const pageOutputRef = fixedWorld.manifest.outputs.find((out) => out.relative_path === targetMemRef.page_ref)
      if (!pageOutputRef) {
        throw new MemoryStoreError('memory_compile_generation_incomplete', new Error('output page missing from manifest'))
      }

      const layout = getGenerationLayout(grant.projectRoot)
      const pageFilePath = join(layout.generationsRoot, grant.generationRef.generation_id, ...targetMemRef.page_ref.split('/'))

      if (activeTestHooks?.simulatePageTamperingBeforeRead) {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(pageFilePath, '# TAMPERED PAGE CONTENT\n', { mode: 0o600 })
      }

      const pageResult = await readStrictFile(grant.projectRoot, pageFilePath)
      if (pageResult.byteLength !== pageOutputRef.byte_length || pageResult.sha256 !== pageOutputRef.content_sha256) {
        throw new MemoryStoreError('memory_store_hash_mismatch', new Error('page file byte length or sha mismatch'))
      }

      const disclosureId = computeOpenDisclosureId({
        retrieval_id: grant.retrievalId,
        parent_disclosure_sha256: grant.searchDisclosureSHA256,
        project_scope_id: grant.projectScopeId,
        session_scope_id: grant.sessionScopeId,
        generation_ref: grant.generationRef,
        memory_ref: targetMemRef,
      })

      const rawOpen: OKFOpenDisclosure = {
        schema_version: 1,
        disclosure_id: disclosureId,
        retrieval_id: grant.retrievalId,
        parent_disclosure_sha256: grant.searchDisclosureSHA256,
        project_scope_id: grant.projectScopeId,
        session_scope_id: grant.sessionScopeId,
        generation_ref: grant.generationRef,
        level: 3,
        memory_ref: targetMemRef,
        title: fact.title,
        summary: fact.summary,
        component: indexEntry.component,
        tags: indexEntry.tags,
        body: fact.body,
        content_sha256: '',
      }

      const canonical = canonicalizeOpenDisclosure(rawOpen)
      return validateOpenDisclosure(JSON.parse(canonical))
    },

    clear(): void {
      grants.clear()
    },
  }
}
