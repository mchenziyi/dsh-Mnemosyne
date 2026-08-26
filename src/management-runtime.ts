import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ResolvedScope, ScopeRuntime } from './runtime-scope.js'
import { openMemoryFactStore, type MemoryFactStore } from './memory-store.js'
import { createOKFCompiler, type OKFCompiler } from './okf-compiler.js'
import { COMPILER_VERSION } from './okf-schema.js'
import {
  canonicalHash,
  compareCodePoints,
} from './protocol/canonical.js'
import {
  computeFactHash,
  type LongTermMemoryFact,
  type ShortTermMemoryFact,
  type ShortTermSourceRef,
} from './memory-fact.js'
import {
  computeForgetId,
  computePromotedMemoryId,
  createMemoryForgetFact,
  isPlainObject,
  validateListMemoriesParams,
  type ListMemoriesItem,
  type ListMemoriesOutput,
  type ListMemoriesParams,
  type MemoryFactState,
  type MemoryForgetFact,
  type MemoryForgetTargetRef,
} from './protocol/management.js'
import { resolveBoundToolCall } from './tool-binding.js'
import { MemoryStoreError } from './memory-store-error.js'
import { validateMemoryId } from './memory-store-path.js'
import {
  createMutationCoordinator,
  type MutationCoordinator,
} from './mutation-coordinator.js'

export interface ManagementRuntimeOptions {
  scopeRuntime: ScopeRuntime
  storeFactory?: (scope: ResolvedScope) => MemoryFactStore
  compiler?: OKFCompiler
  coordinator?: MutationCoordinator
  onForgetCommitted?: (projectRoot: string) => void | Promise<void>
}

export interface PromoteResult {
  status: 'created' | 'noop'
  memory_id: string
  source_short_term_ref: ShortTermSourceRef
  generation_id: string
}

export interface ForgetResult {
  status: 'created' | 'noop'
  forget_id: string
  target: MemoryForgetTargetRef
  generation_id: string
}

export interface ManagementRuntime {
  list(params: unknown, exec: ToolRunContext): Promise<ListMemoriesOutput>
  promote(params: unknown, exec: ToolRunContext): Promise<PromoteResult>
  forget(params: unknown, exec: ToolRunContext): Promise<ForgetResult>
  dispose(): Promise<void>
}

export function createManagementRuntime(options: ManagementRuntimeOptions): ManagementRuntime {
  const { scopeRuntime } = options
  const storeFactory = options.storeFactory ?? ((scope: ResolvedScope) =>
    openMemoryFactStore({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  )
  const compiler = options.compiler ?? createOKFCompiler()
  const coordinator = options.coordinator ?? createMutationCoordinator()
  const onForgetCommitted = options.onForgetCommitted

  let disposed = false
  const inFlight = new Set<Promise<unknown>>()

  function trackInFlight<T>(op: () => Promise<T>): Promise<T> {
    if (disposed) {
      throw new MemoryStoreError('memory_store_invalid_input')
    }
    const promise = op()
    inFlight.add(promise)
    return promise.finally(() => {
      inFlight.delete(promise)
    })
  }

  return {
    async list(params: unknown, exec: ToolRunContext): Promise<ListMemoriesOutput> {
      if (disposed) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      return trackInFlight(async () => {
        const { scope, evaluationAt } = resolveBoundToolCall(exec, 'mnemosyne_list', scopeRuntime)
        const validatedParams = validateListMemoriesParams(params)
        const store = storeFactory(scope)

        let shortFacts: ShortTermMemoryFact[] = []
        let longFacts: LongTermMemoryFact[] = []
        let forgetFacts: MemoryForgetFact[] = []

        try {
          shortFacts = await store.listShortTerm(scope.session_scope_id, evaluationAt, { includeExpired: true })
          longFacts = await store.listLongTerm()
          forgetFacts = await store.listForget()
        } catch (err: unknown) {
          if (err instanceof MemoryStoreError) throw err
          throw new MemoryStoreError('memory_store_io_failed', err)
        }

        // Build index of forgotten targets
        const forgottenSet = new Set<string>()
        for (const f of forgetFacts) {
          const t = f.target
          forgottenSet.add(`${t.tier}:${t.session_scope_id ?? 'null'}:${t.memory_id}:${t.content_sha256}`)
        }

        // Build index of promoted short-term source refs from ALL long facts
        const promotedSet = new Set<string>()
        for (const l of longFacts) {
          for (const ref of l.source_short_term_refs) {
            if (ref.project_scope_id === scope.project_scope_id) {
              promotedSet.add(`${ref.session_scope_id}:${ref.memory_id}:${ref.content_sha256}`)
            }
          }
        }

        const allItems: ListMemoriesItem[] = []
        const evalMillis = Date.parse(evaluationAt)

        // 1. Process short-term facts
        for (const sf of shortFacts) {
          let state: MemoryFactState = 'active'
          const forgetKey = `short_term:${sf.session_scope_id}:${sf.memory_id}:${sf.content_sha256}`
          const promoteKey = `${sf.session_scope_id}:${sf.memory_id}:${sf.content_sha256}`

          if (forgottenSet.has(forgetKey)) {
            state = 'forgotten'
          } else if (promotedSet.has(promoteKey)) {
            state = 'promoted'
          } else if (evalMillis >= Date.parse(sf.expires_at)) {
            state = 'expired'
          } else {
            state = 'active'
          }

          allItems.push({
            tier: 'short_term',
            session_scope_id: sf.session_scope_id,
            memory_id: sf.memory_id,
            title: sf.title,
            summary: sf.summary,
            tags: sf.tags,
            created_at: sf.created_at,
            expires_at: sf.expires_at,
            state,
            content_sha256: sf.content_sha256,
          })
        }

        // 2. Process long-term facts
        for (const lf of longFacts) {
          let state: MemoryFactState = 'active'
          const forgetKey = `long_term:null:${lf.memory_id}:${lf.content_sha256}`

          if (forgottenSet.has(forgetKey)) {
            state = 'forgotten'
          } else {
            state = 'active'
          }

          allItems.push({
            tier: 'long_term',
            session_scope_id: null,
            memory_id: lf.memory_id,
            title: lf.title,
            summary: lf.summary,
            tags: lf.tags,
            created_at: lf.created_at,
            expires_at: null,
            state,
            content_sha256: lf.content_sha256,
          })
        }

        // Filter by tier and include_inactive
        const filtered = allItems.filter((item) => {
          if (validatedParams.tier !== 'all' && item.tier !== validatedParams.tier) {
            return false
          }
          if (!validatedParams.include_inactive && item.state !== 'active') {
            return false
          }
          return true
        })

        // Sort: created_at desc, then tier asc, then memory_id asc
        filtered.sort((a, b) => {
          const timeCmp = compareCodePoints(b.created_at, a.created_at)
          if (timeCmp !== 0) return timeCmp
          const tierCmp = compareCodePoints(a.tier, b.tier)
          if (tierCmp !== 0) return tierCmp
          return compareCodePoints(a.memory_id, b.memory_id)
        })

        const total_count = filtered.length
        const items = filtered.slice(0, validatedParams.limit)
        const truncated = total_count > items.length

        const preOutput = {
          schema_version: 1 as const,
          project_scope_id: scope.project_scope_id,
          session_scope_id: scope.session_scope_id,
          evaluation_at: evaluationAt,
          params: validatedParams,
          total_count,
          truncated,
          items,
        }

        const content_sha256 = canonicalHash(preOutput)

        return {
          ...preOutput,
          content_sha256,
        }
      })
    },

    async promote(params: unknown, exec: ToolRunContext): Promise<PromoteResult> {
      if (disposed) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      if (!isPlainObject(params)) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      const keys = Object.keys(params)
      if (keys.length !== 1 || keys[0] !== 'memory_id') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      const memoryId = (params as { memory_id?: unknown }).memory_id
      if (typeof memoryId !== 'string') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      validateMemoryId(memoryId)

      const { scope, evaluationAt } = resolveBoundToolCall(exec, 'mnemosyne_promote', scopeRuntime)

      return trackInFlight(() =>
        coordinator.run(scope.project_scope_id, async () => {
          const store = storeFactory(scope)
          let sourceFact: ShortTermMemoryFact
          try {
            sourceFact = await store.getShortTerm(scope.session_scope_id, memoryId)
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_store_io_failed', err)
          }

          const sourceRef: ShortTermSourceRef = {
            project_scope_id: scope.project_scope_id,
            session_scope_id: scope.session_scope_id,
            memory_id: sourceFact.memory_id,
            content_sha256: sourceFact.content_sha256,
          }

          const promotedMemoryId = computePromotedMemoryId(sourceRef)

          const longFactBase = {
            schema_version: 1 as const,
            tier: 'long_term' as const,
            memory_id: promotedMemoryId,
            project_scope_id: scope.project_scope_id,
            title: sourceFact.title,
            summary: sourceFact.summary,
            body: sourceFact.body,
            tags: sourceFact.tags,
            created_at: sourceFact.created_at, // MUST use source created_at
            source_short_term_refs: [sourceRef],
          }

          const longFact: LongTermMemoryFact = {
            ...longFactBase,
            content_sha256: computeFactHash(longFactBase),
          }

          let putRes
          try {
            putRes = await store.putLongTerm(longFact)
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_store_io_failed', err)
          }

          let compileRes
          try {
            compileRes = await compiler.compile({
              project_root: scope.project_root,
              project_scope_id: scope.project_scope_id,
              evaluation_at: evaluationAt,
              compiler_version: COMPILER_VERSION,
            })
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_compile_io_failed', err)
          }

          return {
            status: putRes.status,
            memory_id: promotedMemoryId,
            source_short_term_ref: sourceRef,
            generation_id: compileRes.generation_id,
          }
        })
      )
    },

    async forget(params: unknown, exec: ToolRunContext): Promise<ForgetResult> {
      if (disposed) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      if (!isPlainObject(params)) {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      const keys = Object.keys(params).sort()
      if (keys.length !== 2 || keys[0] !== 'memory_id' || keys[1] !== 'tier') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      const { tier, memory_id } = params as { tier?: unknown; memory_id?: unknown }
      if (tier !== 'short_term' && tier !== 'long_term') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      if (typeof memory_id !== 'string') {
        throw new MemoryStoreError('memory_store_invalid_input')
      }
      validateMemoryId(memory_id)

      const { scope, evaluationAt } = resolveBoundToolCall(exec, 'mnemosyne_forget', scopeRuntime)

      return trackInFlight(() =>
        coordinator.run(scope.project_scope_id, async () => {
          const store = storeFactory(scope)
          let targetContentSha256 = ''

          try {
            if (tier === 'short_term') {
              const sf = await store.getShortTerm(scope.session_scope_id, memory_id)
              targetContentSha256 = sf.content_sha256
            } else {
              const lf = await store.getLongTerm(memory_id)
              targetContentSha256 = lf.content_sha256
            }
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_store_io_failed', err)
          }

          const target: MemoryForgetTargetRef = {
            tier,
            session_scope_id: tier === 'short_term' ? scope.session_scope_id : null,
            memory_id,
            content_sha256: targetContentSha256,
          }

          const forgetFact = createMemoryForgetFact({
            project_scope_id: scope.project_scope_id,
            target,
          })

          let putRes
          try {
            putRes = await store.putForget(forgetFact)
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_store_io_failed', err)
          }

          let compileRes
          try {
            compileRes = await compiler.compile({
              project_root: scope.project_root,
              project_scope_id: scope.project_scope_id,
              evaluation_at: evaluationAt,
              compiler_version: COMPILER_VERSION,
            })
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) throw err
            throw new MemoryStoreError('memory_compile_io_failed', err)
          }

          if (onForgetCommitted) {
            try {
              await onForgetCommitted(scope.project_root)
            } catch (err: unknown) {
              if (err instanceof MemoryStoreError) throw err
              throw new MemoryStoreError('memory_store_io_failed', err)
            }
          }

          return {
            status: putRes.status,
            forget_id: forgetFact.forget_id,
            target,
            generation_id: compileRes.generation_id,
          }
        })
      )
    },

    async dispose(): Promise<void> {
      disposed = true
      await Promise.allSettled(Array.from(inFlight))
      inFlight.clear()
    },
  }
}
