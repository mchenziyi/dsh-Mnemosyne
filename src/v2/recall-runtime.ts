import { createUserMessage, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ResolvedScope, ScopeRuntime } from '../runtime-scope.js'
import { readCurrentOKFGenerationV2, type CompiledOKFGenerationV2 } from './okf-compiler.js'

export type RecallNavigationStageV2 = 'root_titles' | 'node_summary' | 'node_titles' | 'memory_summaries'

const MAX_RECALL_EXPANSION_STEPS = 8

export interface RecallNavigationItemV2 {
  ref: string
  title: string
  summary?: string
  kind: 'node' | 'memory'
}

export interface RecallNavigationRequestV2 {
  schema_version: 1
  stage: RecallNavigationStageV2
  task: string
  step: number
  items: RecallNavigationItemV2[]
}

export interface RecallNavigationDecisionV2 {
  selected_refs: string[]
}

export type RecallNavigatorV2 = (
  request: RecallNavigationRequestV2,
  route: { provider: string; model: string; signal: AbortSignal },
) => Promise<RecallNavigationDecisionV2>

export interface RecallRequestV2 {
  scope: ResolvedScope
  task: string
  provider: string
  model: string
  signal: AbortSignal
}

export type RecallResultV2 = {
  status: 'completed'
  reason_code: null
  selected_memory_refs: string[]
  expansion_steps: number
  message: UserMessage
} | {
  status: 'empty' | 'no_match' | 'failed'
  reason_code: 'memory_empty' | 'recall_no_match' | 'recall_selection_invalid' | 'recall_navigation_failed' | 'recall_generation_invalid'
  selected_memory_refs: string[]
  expansion_steps: number
  message?: undefined
}

export interface RecallRuntimeV2 {
  recall(request: RecallRequestV2): Promise<RecallResultV2>
}

export interface RecallRuntimeV2Options {
  loadWorld?: (scope: ResolvedScope) => Promise<CompiledOKFGenerationV2>
  navigator: RecallNavigatorV2
  onEvent?: (request: RecallRequestV2, event: RecallRuntimeEventV2) => void | Promise<void>
}

export type RecallRuntimeEventV2 =
  | { event: 'recall_start' }
  | { event: 'recall_layer'; stage: RecallNavigationStageV2; step: number; disclosed_refs: string[]; selected_refs: string[] }
  | { event: 'recall_completed'; selected_memory_refs: string[]; expansion_steps: number }
  | { event: 'recall_no_match'; expansion_steps: number }
  | { event: 'recall_failed'; reason_code: string; expansion_steps: number }

interface IndexEntry { ref: string; title: string }
interface RootIndex { schema_version: 1; root_node_id: string; children: IndexEntry[] }
interface NodeIndex { schema_version: 1; node_id: string; title: string; summary: string; children: IndexEntry[]; memories: IndexEntry[] }
interface SummaryView { schema_version: 1; memory_id: string; title: string; summary: string }

function parseJson<T>(value: string | undefined): T {
  if (value === undefined) throw new Error('missing_view')
  return JSON.parse(value) as T
}

function validateDecision(raw: unknown, offered: readonly string[], limit: number): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'selected_refs')) {
    throw new Error('invalid_selection')
  }
  const refs = (raw as { selected_refs?: unknown }).selected_refs
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string') || new Set(refs).size !== refs.length) {
    throw new Error('invalid_selection')
  }
  const allowed = new Set(offered)
  if (refs.some((ref) => !allowed.has(ref as string))) throw new Error('invalid_selection')
  return (refs as string[]).slice(0, limit)
}

function recallMessage(selected: Array<{ ref: string; content: string }>): UserMessage {
  const sections = selected.map(({ ref, content }) => `<!-- memory_ref:${ref} -->\n${content}`)
  return createUserMessage({
    content: [{ type: 'text', text: `[Mnemosyne Recall v2 — plugin generated; not user authored]\n\n${sections.join('\n\n---\n\n')}` }],
    source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' },
  })
}

export function createRecallRuntimeV2(options: RecallRuntimeV2Options): RecallRuntimeV2 {
  const loadWorld = options.loadWorld ?? ((scope: ResolvedScope) => readCurrentOKFGenerationV2({
    project_root: scope.project_root,
    project_scope_id: scope.project_scope_id,
  }))

  return {
    async recall(request: RecallRequestV2): Promise<RecallResultV2> {
      await options.onEvent?.(request, { event: 'recall_start' })
      let world: CompiledOKFGenerationV2
      try {
        world = await loadWorld(request.scope)
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'memory_compile_not_found') {
          await options.onEvent?.(request, { event: 'recall_no_match', expansion_steps: 0 })
          return { status: 'empty', reason_code: 'memory_empty', selected_memory_refs: [], expansion_steps: 0 }
        }
        await options.onEvent?.(request, { event: 'recall_failed', reason_code: 'recall_generation_invalid', expansion_steps: 0 })
        return { status: 'failed', reason_code: 'recall_generation_invalid', selected_memory_refs: [], expansion_steps: 0 }
      }

      let steps = 0
      const selected: Array<{ ref: string; content: string }> = []
      const route = { provider: request.provider, model: request.model, signal: request.signal }

      const choose = async (stage: RecallNavigationStageV2, items: RecallNavigationItemV2[], limit: number): Promise<string[]> => {
        if (steps >= MAX_RECALL_EXPANSION_STEPS || items.length === 0) return []
        steps++
        const decision = await options.navigator({ schema_version: 1, stage, task: request.task, step: steps, items }, route)
        const selectedRefs = validateDecision(decision, items.map((item) => item.ref), limit)
        await options.onEvent?.(request, { event: 'recall_layer', stage, step: steps, disclosed_refs: items.map((item) => item.ref), selected_refs: selectedRefs })
        return selectedRefs
      }

      try {
        const root = parseJson<RootIndex>(world.files.get('indexes/root.json'))
        let nodeSelection = await choose('root_titles', root.children.map((item) => ({ ...item, kind: 'node' as const })), 1)
        if (nodeSelection.length === 0) {
          await options.onEvent?.(request, { event: 'recall_no_match', expansion_steps: steps })
          return { status: 'no_match', reason_code: 'recall_no_match', selected_memory_refs: [], expansion_steps: steps }
        }

        let memoryCandidates: string[] = []
        while (nodeSelection.length > 0 && steps < MAX_RECALL_EXPANSION_STEPS) {
          const node = parseJson<NodeIndex>(world.files.get(`indexes/nodes/${nodeSelection[0]}.json`))
          const expand = await choose('node_summary', [{ ref: node.node_id, title: node.title, summary: node.summary, kind: 'node' }], 1)
          if (expand.length === 0 || steps >= MAX_RECALL_EXPANSION_STEPS) break
          const choices = await choose('node_titles', [
            ...node.children.map((item) => ({ ...item, kind: 'node' as const })),
            ...node.memories.map((item) => ({ ...item, kind: 'memory' as const })),
          ], 6)
          const child = choices.find((ref) => node.children.some((item) => item.ref === ref))
          if (child) {
            nodeSelection = [child]
            continue
          }
          memoryCandidates = choices.filter((ref) => node.memories.some((item) => item.ref === ref)).slice(0, 5)
          break
        }

        if (memoryCandidates.length > 0 && steps < MAX_RECALL_EXPANSION_STEPS) {
          const summaryItems = memoryCandidates.map((id) => {
            const view = parseJson<SummaryView>(world.files.get(`summaries/${id}.json`))
            return { ref: view.memory_id, title: view.title, summary: view.summary, kind: 'memory' as const }
          })
          const confirmed = await choose('memory_summaries', summaryItems, 3)
          for (const id of confirmed) {
            const content = world.files.get(`contents/${id}.md`)
            if (content === undefined) throw new Error('missing_content')
            selected.push({ ref: id, content })
          }
        }

        if (selected.length === 0) {
          await options.onEvent?.(request, { event: 'recall_no_match', expansion_steps: steps })
          return { status: 'no_match', reason_code: 'recall_no_match', selected_memory_refs: [], expansion_steps: steps }
        }
        await options.onEvent?.(request, { event: 'recall_completed', selected_memory_refs: selected.map((item) => item.ref), expansion_steps: steps })
        return {
          status: 'completed', reason_code: null, selected_memory_refs: selected.map((item) => item.ref),
          expansion_steps: steps, message: recallMessage(selected),
        }
      } catch (error: unknown) {
        const reason = error instanceof Error && error.message === 'invalid_selection' ? 'recall_selection_invalid' : 'recall_navigation_failed'
        await options.onEvent?.(request, { event: 'recall_failed', reason_code: reason, expansion_steps: steps })
        return { status: 'failed', reason_code: reason, selected_memory_refs: [], expansion_steps: steps }
      }
    },
  }
}

function taskText(messages: readonly UserMessage[]): string {
  const values: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) if (block.type === 'text') values.push(block.text)
  }
  return values.join('\n').slice(0, 32768)
}

export interface RecallPreStepHandlerV2Options {
  runtime: RecallRuntimeV2
  scopeRuntime: ScopeRuntime
  beforeRecall?: (scope: ResolvedScope, signal: AbortSignal) => Promise<void>
  onResult?: (payload: { agent: Agent; turn: number }, result: RecallResultV2) => void | Promise<void>
}

export function createRecallPreStepHandlerV2(options: RecallPreStepHandlerV2Options): (
  payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision> {
  return async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.step !== 1) return decision
    const provider = payload.agent.options.provider
    const model = payload.agent.options.model
    if (!provider || !model) return decision
    const resolved = options.scopeRuntime.observeSession(payload.agent.session)
    if (resolved.status !== 'ready') return decision
    if (payload.signal.aborted) return decision
    await options.beforeRecall?.(resolved.scope, payload.signal)
    if (payload.signal.aborted) return decision
    const result = await options.runtime.recall({
      scope: resolved.scope,
      task: taskText(decision.messages),
      provider,
      model,
      signal: payload.signal,
    })
    await options.onResult?.({ agent: payload.agent, turn: payload.turn }, result)
    if (result.status !== 'completed') return decision
    return { kind: 'enter', messages: [result.message, ...decision.messages] }
  }
}

export async function consumeStrictModelTextV2(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const fail = (code: string): never => { throw Object.assign(new Error('invalid model stream'), { code }) }
  let text: string | null = null
  const active = new Map<number, 'text' | 'reasoning'>()
  const closed = new Set<number>()
  let finish = false
  for await (const chunk of stream) {
    if (finish) fail('stream_trailing_data')
    if (chunk.type === 'block-start') {
      if (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') fail('stream_block_type_invalid')
      if (active.has(chunk.index) || closed.has(chunk.index)) fail('stream_block_reused')
      active.set(chunk.index, chunk.blockType as 'text' | 'reasoning')
    } else if (chunk.type === 'text-delta') {
      if (active.get(chunk.index) !== 'text') fail('stream_text_delta_invalid')
    } else if (chunk.type === 'reasoning-delta') {
      if (active.get(chunk.index) !== 'reasoning') fail('stream_reasoning_delta_invalid')
    } else if (chunk.type === 'block-end') {
      if (active.get(chunk.index) !== chunk.block.type) fail('stream_block_end_invalid')
      if (chunk.block.type === 'text') {
        if (text !== null) fail('stream_multiple_text_blocks')
        if (Buffer.byteLength(chunk.block.text, 'utf8') > 8192) fail('stream_text_size_exceeded')
        text = chunk.block.text
      }
      active.delete(chunk.index)
      closed.add(chunk.index)
    } else if (chunk.type === 'finish') {
      if (active.size > 0) fail('stream_finish_with_open_block')
      if (finish || chunk.reason?.kind !== 'stop') fail('stream_finish_invalid')
      finish = true
    } else if (chunk.type === 'usage') {
      if (active.size > 0) fail('stream_usage_inside_block')
    } else {
      fail('stream_chunk_invalid')
    }
  }
  if (!finish) fail('stream_finish_missing')
  if (active.size > 0) fail('stream_open_block')
  if (text === null) fail('stream_text_missing')
  return text as string
}

export function createLlmRecallNavigatorV2(llm: LlmRuntime): RecallNavigatorV2 {
  return async (request, route): Promise<RecallNavigationDecisionV2> => {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: 'You navigate project memory. Return exactly one JSON object: {"selected_refs":[...]}. Select only offered refs. Do not include reasoning or markdown.',
      messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(request) }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice', summary: 'memory navigation request' } })],
      tools: [],
      maxTokens: 256,
      signal: route.signal,
    })
    const text = (await consumeStrictModelTextV2(stream)).trim()
    if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('invalid_selection')
    return JSON.parse(text) as RecallNavigationDecisionV2
  }
}
