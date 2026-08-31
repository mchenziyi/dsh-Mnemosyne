import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { canonicalHash, compareCodePoints } from '../protocol/canonical.js'
import type { ResolvedScope } from '../runtime-scope.js'
import { assertUtcTimestamp } from '../memory-fact.js'
import { MemoryStoreError } from '../memory-store-error.js'
import { createMutationCoordinator } from '../mutation-coordinator.js'
import {
  computeOKFCatalogNodeIdV1,
  computeOKFCatalogV1Hash,
  OKF_CATALOG_MAX_DEPTH,
  type OKFCatalogNodeV1,
  type OKFCatalogV1,
} from './okf-catalog.js'
import { computeOKFMemoryV2Hash, type OKFMemoryV2 } from './okf-memory.js'
import { openOKFMemoryV2Store } from './okf-memory-store.js'
import { publishOKFGenerationV2, readCurrentOKFGenerationV2 } from './okf-compiler.js'
import { consumeStrictModelTextV2 } from './recall-runtime.js'

export interface ConsolidationEvidenceV2 {
  task: string
  outcome: string
}

export type ConsolidationModelRequestV2 = {
  schema_version: 1
  stage: 'judgment'
  evidence: ConsolidationEvidenceV2
  used_memory_refs: string[]
} | {
  schema_version: 1
  stage: 'category_titles'
  memory: { title: string; summary: string }
  current_node_ref: string
  current_depth: number
  categories: Array<{ ref: string; title: string }>
} | {
  schema_version: 1
  stage: 'category_summary'
  memory: { title: string; summary: string }
  category: { ref: string; title: string; summary: string }
  current_depth: number
}

export type ConsolidationModelDecisionV2 = {
  decision: 'skip'
  reason_code: 'no_reusable_knowledge' | 'insufficient_evidence' | 'task_incomplete'
} | {
  decision: 'create'
  title: string
  summary: string
  content: string
  related_memory_refs: string[]
} | {
  decision: 'existing'
  node_ref: string
} | {
  decision: 'new'
  title: string
  summary: string
} | {
  decision: 'attach' | 'expand'
}

export type ConsolidationModelV2 = (
  request: ConsolidationModelRequestV2,
  route: { provider: string; model: string; signal: AbortSignal },
) => Promise<ConsolidationModelDecisionV2>

export interface ConsolidationRequestV2 {
  scope: ResolvedScope
  evidence: ConsolidationEvidenceV2
  used_memory_refs: string[]
  provider: string
  model: string
  now: string
  signal: AbortSignal
}

export interface ConsolidationResultV2 {
  status: 'created' | 'noop' | 'skipped' | 'failed'
  reason_code: string | null
  memory_id?: string
  generation_id?: string
  catalog_id?: string
}

export interface ConsolidationRuntimeV2 {
  consolidate(request: ConsolidationRequestV2): Promise<ConsolidationResultV2>
}

export interface ConsolidationRuntimeV2Options {
  model: ConsolidationModelV2
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('invalid_model_output')
  }
  return value
}

function safeLlmFailureCode(error: unknown): string | null {
  const value = (error as { failure?: { code?: unknown }; code?: unknown } | null)?.failure?.code
    ?? (error as { code?: unknown } | null)?.code
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized.length > 0 && normalized.length <= 48 ? normalized : null
}

function validateJudgment(raw: ConsolidationModelDecisionV2, offeredRefs: string[]): Extract<ConsolidationModelDecisionV2, { decision: 'skip' | 'create' }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_model_output')
  if (raw.decision === 'skip') {
    if (Object.keys(raw).sort().join('|') !== 'decision|reason_code' || !['no_reusable_knowledge', 'insufficient_evidence', 'task_incomplete'].includes(raw.reason_code)) {
      throw new Error('invalid_model_output')
    }
    return raw
  }
  if (raw.decision !== 'create' || Object.keys(raw).sort().join('|') !== 'content|decision|related_memory_refs|summary|title') {
    throw new Error('invalid_model_output')
  }
  boundedText(raw.title, 320)
  boundedText(raw.summary, 2000)
  boundedText(raw.content, 65536)
  if (!Array.isArray(raw.related_memory_refs) || new Set(raw.related_memory_refs).size !== raw.related_memory_refs.length) throw new Error('invalid_model_output')
  const allowed = new Set(offeredRefs)
  if (raw.related_memory_refs.some((ref) => typeof ref !== 'string' || !allowed.has(ref))) throw new Error('invalid_model_output')
  return raw
}

function validateCategorySelection(raw: ConsolidationModelDecisionV2, categories: Array<{ ref: string; title: string }>): Extract<ConsolidationModelDecisionV2, { decision: 'existing' | 'new' }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_model_output')
  if (raw.decision === 'existing') {
    if (Object.keys(raw).sort().join('|') !== 'decision|node_ref' || !categories.some((category) => category.ref === raw.node_ref)) throw new Error('invalid_model_output')
    return raw
  }
  if (raw.decision !== 'new' || Object.keys(raw).sort().join('|') !== 'decision|summary|title') throw new Error('invalid_model_output')
  boundedText(raw.title, 320)
  boundedText(raw.summary, 2000)
  return raw
}

function validateCategoryExpansion(raw: ConsolidationModelDecisionV2, depth: number): Extract<ConsolidationModelDecisionV2, { decision: 'attach' | 'expand' }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join('|') !== 'decision') throw new Error('invalid_model_output')
  if (raw.decision !== 'attach' && raw.decision !== 'expand') throw new Error('invalid_model_output')
  if (depth === OKF_CATALOG_MAX_DEPTH && raw.decision !== 'attach') throw new Error('invalid_model_output')
  return raw
}

function memoryFingerprint(scope: string, value: { title: string; summary: string; content: string; related_memory_refs: string[] }): string {
  return canonicalHash({
    schema_version: 1,
    project_scope_id: scope,
    title: value.title,
    summary: value.summary,
    content: value.content,
    related_memory_refs: [...value.related_memory_refs].sort(compareCodePoints),
  })
}

function memoryId(fingerprint: string): string {
  return `mem_${fingerprint.slice('sha256_'.length)}`
}

function initialCatalog(scope: string, now: string): OKFCatalogV1 {
  const catalog: OKFCatalogV1 = {
    schema_version: 1,
    project_scope_id: scope,
    root_node_id: 'node_root',
    nodes: [{ node_id: 'node_root', title: '项目记忆', summary: '项目级持久记忆。', parent_node_id: null, child_node_refs: [], memory_refs: [] }],
    updated_at: now,
    content_sha256: '',
  }
  catalog.content_sha256 = computeOKFCatalogV1Hash(catalog)
  return catalog
}

function addCategory(catalog: OKFCatalogV1, parent: OKFCatalogNodeV1, category: Extract<ConsolidationModelDecisionV2, { decision: 'existing' | 'new' }>): OKFCatalogNodeV1 {
  if (category.decision === 'existing') {
    const node = catalog.nodes.find((candidate) => candidate.node_id === category.node_ref)
    if (!node || node.parent_node_id !== parent.node_id || !parent.child_node_refs.includes(node.node_id)) throw new Error('invalid_category')
    return node
  }
  const id = computeOKFCatalogNodeIdV1(catalog.project_scope_id, parent.node_id, category.title)
  const existing = catalog.nodes.find((candidate) => candidate.node_id === id)
  if (existing) {
    if (existing.parent_node_id !== parent.node_id || !parent.child_node_refs.includes(existing.node_id)) throw new Error('invalid_category')
    return existing
  }
  const node: OKFCatalogNodeV1 = { node_id: id, title: category.title, summary: category.summary, parent_node_id: parent.node_id, child_node_refs: [], memory_refs: [] }
  catalog.nodes.push(node)
  parent.child_node_refs.push(id)
  return node
}

function updatedCatalog(catalog: OKFCatalogV1, node: OKFCatalogNodeV1, memory: OKFMemoryV2, now: string): OKFCatalogV1 {
  const next = structuredClone(catalog)
  const target = next.nodes.find((candidate) => candidate.node_id === node.node_id)
  if (!target || target.node_id === next.root_node_id) throw new Error('invalid_category')
  target.memory_refs.push(memory.memory_id)
  next.updated_at = now
  next.content_sha256 = ''
  next.content_sha256 = computeOKFCatalogV1Hash(next)
  return next
}

async function currentCatalog(scope: ResolvedScope): Promise<OKFCatalogV1> {
  const store = openOKFMemoryV2Store({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
  try {
    const world = await readCurrentOKFGenerationV2({ project_root: scope.project_root, project_scope_id: scope.project_scope_id })
    return await store.getCatalog(world.manifest.catalog_id)
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'memory_compile_not_found') throw error
    throw error
  }
}

export function createConsolidationRuntimeV2(options: ConsolidationRuntimeV2Options): ConsolidationRuntimeV2 {
  const coordinator = createMutationCoordinator()
  return {
    async consolidate(request: ConsolidationRequestV2): Promise<ConsolidationResultV2> {
      return await coordinator.run(request.scope.project_scope_id, async () => {
        let stage = 'input'
        try {
          assertUtcTimestamp(request.now)
          boundedText(request.evidence.task, 32768)
          boundedText(request.evidence.outcome, 32768)
          if (new Set(request.used_memory_refs).size !== request.used_memory_refs.length) throw new Error('invalid_input')
          const store = openOKFMemoryV2Store({ project_root: request.scope.project_root, project_scope_id: request.scope.project_scope_id })
          for (const ref of request.used_memory_refs) await store.getMemory(ref)
          const route = { provider: request.provider, model: request.model, signal: request.signal }
          let rawJudgment: ConsolidationModelDecisionV2
          try {
            rawJudgment = await options.model({
              schema_version: 1,
              stage: 'judgment',
              evidence: request.evidence,
              used_memory_refs: request.used_memory_refs,
            }, route)
          } catch (error: unknown) {
            const code = safeLlmFailureCode(error)
            return { status: 'failed', reason_code: code ? `consolidation_judgment_model_${code}` : 'consolidation_judgment_model_failed' }
          }
          let judgment: Extract<ConsolidationModelDecisionV2, { decision: 'skip' | 'create' }>
          try { judgment = validateJudgment(rawJudgment, request.used_memory_refs) } catch {
            return { status: 'failed', reason_code: 'consolidation_judgment_invalid' }
          }
          if (judgment.decision === 'skip') return { status: 'skipped', reason_code: judgment.reason_code }

          stage = 'catalog_read'
          const fingerprint = memoryFingerprint(request.scope.project_scope_id, judgment)
          let catalog: OKFCatalogV1
          try { catalog = await currentCatalog(request.scope) } catch (error: unknown) {
            if ((error as { code?: string }).code !== 'memory_compile_not_found') throw error
            catalog = initialCatalog(request.scope.project_scope_id, request.now)
          }
          const existing = await store.listMemories()
          const duplicate = existing.find((memory) => memoryFingerprint(memory.project_scope_id, memory) === fingerprint)
          const visibleMemoryRefs = new Set(catalog.nodes.flatMap((node) => node.memory_refs))
          if (duplicate && visibleMemoryRefs.has(duplicate.memory_id)) {
            return { status: 'noop', reason_code: 'duplicate_memory', memory_id: duplicate.memory_id }
          }
          let current = catalog.nodes.find((node) => node.node_id === catalog.root_node_id)!
          let depth = 0
          while (true) {
            stage = 'category_selection'
            const categories = current.child_node_refs.map((ref) => ({ ref, title: catalog.nodes.find((node) => node.node_id === ref)!.title }))
            let rawCategory: ConsolidationModelDecisionV2
            try {
              rawCategory = await options.model({
                schema_version: 1,
                stage: 'category_titles',
                memory: { title: judgment.title, summary: judgment.summary },
                current_node_ref: current.node_id,
                current_depth: depth,
                categories,
              }, route)
            } catch {
              return { status: 'failed', reason_code: 'consolidation_category_model_failed' }
            }
            let category: Extract<ConsolidationModelDecisionV2, { decision: 'existing' | 'new' }>
            try { category = validateCategorySelection(rawCategory, categories) } catch {
              return { status: 'failed', reason_code: 'consolidation_category_invalid' }
            }
            current = addCategory(catalog, current, category)
            depth++
            stage = 'category_expansion'
            let rawExpansion: ConsolidationModelDecisionV2
            try {
              rawExpansion = await options.model({
                schema_version: 1,
                stage: 'category_summary',
                memory: { title: judgment.title, summary: judgment.summary },
                category: { ref: current.node_id, title: current.title, summary: current.summary },
                current_depth: depth,
              }, route)
            } catch {
              return { status: 'failed', reason_code: 'consolidation_category_model_failed' }
            }
            let expansion: Extract<ConsolidationModelDecisionV2, { decision: 'attach' | 'expand' }>
            try { expansion = validateCategoryExpansion(rawExpansion, depth) } catch {
              return { status: 'failed', reason_code: 'consolidation_category_invalid' }
            }
            if (expansion.decision === 'attach') break
          }

          const memory: OKFMemoryV2 = duplicate ?? {
            schema_version: 2,
            memory_id: memoryId(fingerprint),
            project_scope_id: request.scope.project_scope_id,
            title: judgment.title,
            summary: judgment.summary,
            content: judgment.content,
            related_memory_refs: [...judgment.related_memory_refs].sort(compareCodePoints),
            created_at: request.now,
            content_sha256: '',
          }
          if (!duplicate) memory.content_sha256 = computeOKFMemoryV2Hash(memory)
          const nextCatalog = updatedCatalog(catalog, current, memory, request.now)
          let catalogWrite: Awaited<ReturnType<typeof store.putCatalog>>
          let generation: Awaited<ReturnType<typeof publishOKFGenerationV2>>
          try {
            await store.putMemory(memory)
            catalogWrite = await store.putCatalog(nextCatalog)
            generation = await publishOKFGenerationV2({
              project_root: request.scope.project_root,
              project_scope_id: request.scope.project_scope_id,
              catalog_id: catalogWrite.catalog_id,
              created_at: request.now,
            })
          } catch (error: unknown) {
            const reason = error instanceof MemoryStoreError ? error.code : 'consolidation_publish_failed'
            return { status: 'failed', reason_code: reason }
          }
          return { status: 'created', reason_code: null, memory_id: memory.memory_id, catalog_id: catalogWrite.catalog_id, generation_id: generation.generation_id }
        } catch (error: unknown) {
          const reason = error instanceof MemoryStoreError ? error.code : `consolidation_${stage}_failed`
          return { status: 'failed', reason_code: reason }
        }
      })
    },
  }
}

export function createLlmConsolidationModelV2(llm: LlmRuntime): ConsolidationModelV2 {
  return async (request, route): Promise<ConsolidationModelDecisionV2> => {
    const system = request.stage === 'judgment'
      ? 'Judge whether the completed turn produced reusable project knowledge. Return strict JSON only. Use decision skip or create. For create include title, summary, structured Markdown content, and related_memory_refs selected only from used_memory_refs.'
      : request.stage === 'category_titles'
        ? 'Choose one offered direct child category by returning {"decision":"existing","node_ref":"..."}, or create one direct child with {"decision":"new","title":"...","summary":"..."}. Return strict JSON only.'
        : 'After reading the selected category summary, return exactly {"decision":"attach"} to place the memory here, or {"decision":"expand"} to inspect or create a more specific child category. Return strict JSON only.'
    let stream: AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>
    try {
      stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(request) }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice', summary: 'memory consolidation request' } })],
        tools: [],
        maxTokens: request.stage === 'judgment' ? 2048 : 256,
        signal: route.signal,
      })
    } catch {
      throw Object.assign(new Error('llm stream start failed'), { code: 'stream_start_failed' })
    }
    let text: string
    try {
      text = (await consumeStrictModelTextV2(stream)).trim()
    } catch (error: unknown) {
      const code = safeLlmFailureCode(error)
      throw Object.assign(new Error('llm stream consume failed'), { code: code?.startsWith('stream_') ? code : 'stream_consume_failed' })
    }
    if (!text.startsWith('{') || !text.endsWith('}')) throw Object.assign(new Error('invalid model output'), { code: 'json_parse_failed' })
    try {
      return JSON.parse(text) as ConsolidationModelDecisionV2
    } catch {
      throw Object.assign(new Error('invalid model output'), { code: 'json_parse_failed' })
    }
  }
}
