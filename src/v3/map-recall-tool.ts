import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RecallRuntimeV2, RecallResultV2 } from '../v2/recall-runtime.js'
import type { ResolvedScope, ScopeRuntime } from '../runtime-scope.js'
import { resolveBoundToolCall } from '../tool-binding.js'
import { MemoryStoreError } from '../memory-store-error.js'
import { createMapFirstRecallV3, type MapFirstRecallResultV3 } from './map-first-recall.js'
import { createMapContextMessageV3 } from './map-context.js'
import { createMapOfferPagesV3, type MapOfferV3, type PinnedGenerationV3 } from './map-offer.js'
import { createDshSubagentFactoryV3, runDshSubagentV3, type DshSubagentFactoryV3 } from './dsh-subagent.js'

const PARAMETERS = { map_ref: { type: 'string', required: true } } as const
const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    status: { type: 'string', required: true, enum: ['completed', 'no_match', 'failed'] },
    route: { type: 'string', required: true, enum: ['map', 'legacy_fallback'] },
    generation_id: { type: 'string', required: true },
    selected_memory_refs: { type: 'array', required: true, items: { type: 'string' } },
    receipt_sha256: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    reason_code: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const

function textOf(message: UserMessage): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

function recallMessage(contents: Array<{ ref: string; content: string }>): UserMessage {
  const body = contents.map((item) => `<!-- memory_ref:${item.ref} -->\n${item.content}`).join('\n\n---\n\n')
  return createUserMessage({ content: [{ type: 'text', text: `[Mnemosyne Recall v3 — plugin generated; not user authored]\n\n${body}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } })
}

interface Binding {
  readonly agent: Agent
  readonly turn: number
  readonly task: string
  readonly scope: ResolvedScope
  readonly pin: PinnedGenerationV3
  readonly pages: readonly MapOfferV3[]
  readonly map_ref: string
  state: 'offered' | 'running' | 'completed'
  selected_memory_refs: string[]
}

export interface MapRecallToolRuntimeV3Options {
  scopeRuntime: ScopeRuntime
  legacyRuntime: RecallRuntimeV2
  loadWorld?: never
  subagentFactory?: DshSubagentFactoryV3
  onEvent?: (scope: ResolvedScope, event: { event: 'recall_start' | 'recall_layer' | 'recall_completed' | 'recall_no_match' | 'recall_failed' | 'recall_fallback'; stage?: string; disclosed_count?: number; selected_count?: number; reason_code?: string | null }) => void
}

export interface MapRecallToolRuntimeV3 {
  bind(input: { agent: Agent; turn: number; task: string; scope: ResolvedScope; pin: PinnedGenerationV3; pages: readonly MapOfferV3[]; map_ref: string }): readonly UserMessage[]
  createTool(): ToolDefinition
  consumeUsedRefs(agent: Agent, turn: number): string[]
  clearAgent(agent: Agent): void
  clear(): void
}

export function createMapRecallToolRuntimeV3(options: MapRecallToolRuntimeV3Options): MapRecallToolRuntimeV3 {
  const bindings = new WeakMap<Agent, Map<number, Binding>>()
  const factory = options.subagentFactory ?? createDshSubagentFactoryV3()

  const bind = (input: Parameters<MapRecallToolRuntimeV3['bind']>[0]): readonly UserMessage[] => {
    const byTurn = bindings.get(input.agent) ?? new Map<number, Binding>()
    byTurn.set(input.turn, { ...input, state: 'offered', selected_memory_refs: [] })
    bindings.set(input.agent, byTurn)
    return input.pages.map((page, index) => createMapContextMessageV3(page, input.map_ref, index, input.pages.length))
  }

  const execute = async (rawArgs: unknown, exec: ToolRunContext) => {
    const bound = resolveBoundToolCall(exec, 'mnemosyne_recall', options.scopeRuntime)
    if (!exec.agent || exec.agent.session.header.origin === 'subagent') throw new MemoryStoreError('memory_store_invalid_input')
    const data = bound.toolCall.data as { turn?: unknown }
    if (typeof data.turn !== 'number' || !Number.isInteger(data.turn) || data.turn <= 0) throw new MemoryStoreError('memory_store_invalid_input')
    const turn = data.turn
    const args = rawArgs as Record<string, unknown>
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs) || Object.keys(args).length !== 1 || typeof args.map_ref !== 'string') throw new MemoryStoreError('memory_store_invalid_input')
    const binding = bindings.get(exec.agent)?.get(turn)
    if (!binding || binding.agent !== exec.agent || binding.map_ref !== args.map_ref || binding.scope.project_scope_id !== bound.scope.project_scope_id || binding.state !== 'offered') throw new MemoryStoreError('memory_store_invalid_input')
    binding.state = 'running'
    options.onEvent?.(binding.scope, { event: 'recall_start' })
    let fallbackMessage: UserMessage | undefined
    const runtime = createMapFirstRecallV3({
      invoke: async (request) => {
        const output = await runDshSubagentV3(exec.agent!, { task: JSON.stringify({ schema_version: 1, stage: request.stage, task: request.task, items: request.items }), provider: exec.agent!.options.provider!, model: exec.agent!.options.model!, signal: exec.signal }, factory)
        const parsed = JSON.parse(output) as { selected_refs?: unknown }
        if (!Array.isArray(parsed.selected_refs)) throw new MemoryStoreError('memory_store_invalid_input')
        options.onEvent?.(binding.scope, { event: 'recall_layer', stage: request.stage, disclosed_count: request.items.length, selected_count: parsed.selected_refs.length })
        return parsed as { selected_refs: string[] }
      },
      fallback: async () => {
        options.onEvent?.(binding.scope, { event: 'recall_fallback', reason_code: 'subagent_unavailable' })
        const legacy = await options.legacyRuntime.recall({ scope: binding.scope, task: binding.task, provider: exec.agent!.options.provider!, model: exec.agent!.options.model!, signal: exec.signal })
        if (legacy.status === 'completed') fallbackMessage = legacy.message
        return { status: legacy.status === 'completed' ? 'completed' : legacy.status === 'empty' ? 'no_match' : 'failed', selected_memory_refs: legacy.selected_memory_refs, contents: [], fallback_used: true, reason_code: legacy.reason_code }
      },
    })
    let result: MapFirstRecallResultV3
    try { result = await runtime.recall(binding.pin, binding.task, exec.signal, binding.pages) } catch { result = { status: 'failed', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_navigation_failed' } }
    binding.state = 'completed'
    binding.selected_memory_refs = [...result.selected_memory_refs]
    if (fallbackMessage) exec.deferContext(fallbackMessage)
    else if (result.status === 'completed') exec.deferContext(recallMessage(result.contents))
    if (result.status === 'completed') options.onEvent?.(binding.scope, { event: 'recall_completed', selected_count: result.selected_memory_refs.length })
    else options.onEvent?.(binding.scope, { event: result.status === 'no_match' ? 'recall_no_match' : 'recall_failed', reason_code: result.reason_code })
    return { status: result.status, route: result.fallback_used ? 'legacy_fallback' : 'map', generation_id: binding.pin.generation_id, selected_memory_refs: result.selected_memory_refs, receipt_sha256: result.receipt?.receipt_sha256 ?? null, reason_code: result.reason_code }
  }

  return {
    bind,
    createTool: () => defineTool({
      name: 'mnemosyne_recall',
      description: 'When the Mnemosyne map contains a plausibly relevant title, call this tool to inspect it progressively. Do not call it when the map is irrelevant.',
      parameters: PARAMETERS,
      output: { schema: OUTPUT_SCHEMA as never, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute,
    } as never),
    consumeUsedRefs: (agent, turn) => { const binding = bindings.get(agent)?.get(turn); if (!binding) return []; bindings.get(agent)!.delete(turn); return binding.state === 'completed' ? [...binding.selected_memory_refs] : [] },
    clearAgent: (agent) => { bindings.delete(agent) },
    clear: () => { /* WeakMap entries are released with their agents. */ },
  }
}
