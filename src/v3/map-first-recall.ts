import { MemoryStoreError } from '../memory-store-error.js'
import { createMapOfferPagesV3, createMapOfferV3, type MapOfferV3, type PinnedGenerationV3 } from './map-offer.js'
import { createDisclosureReceiptV3, type DisclosureReceiptV3 } from './recall-subagent.js'

export class SubagentUnavailableError extends Error { readonly code = 'subagent_unavailable' }
export type MapRecallStageV3 = 'root_titles' | 'node_summary' | 'node_titles' | 'memory_summaries'
export interface MapRecallItemV3 { ref: string; title: string; summary?: string; kind: 'node' | 'memory' }
export interface MapRecallDecisionV3 { selected_refs: readonly string[] }
export type MapRecallInvokerV3 = (request: { stage: MapRecallStageV3; task: string; items: readonly MapRecallItemV3[]; signal: AbortSignal }) => Promise<MapRecallDecisionV3>
export interface MapFirstRecallResultV3 { status: 'completed' | 'no_match' | 'failed'; selected_memory_refs: string[]; contents: Array<{ ref: string; content: string }>; receipt?: DisclosureReceiptV3; fallback_used: boolean; reason_code: string | null }

const MAX_DEPTH = 3
const fail = (): never => { throw new MemoryStoreError('memory_store_invalid_input') }
const parse = <T>(raw: string | undefined): T => { if (!raw) return fail(); try { return JSON.parse(raw) as T } catch { return fail() } }
function select(decision: MapRecallDecisionV3, offered: readonly string[], limit: number): string[] {
  if (!decision || !Array.isArray(decision.selected_refs) || new Set(decision.selected_refs).size !== decision.selected_refs.length) return fail()
  const allowed = new Set(offered)
  if (decision.selected_refs.some((ref) => typeof ref !== 'string' || !allowed.has(ref))) return fail()
  return [...decision.selected_refs].slice(0, limit)
}
interface Index { node_id: string; title?: string; summary?: string; children: Array<{ ref: string; title: string }>; memories: Array<{ ref: string; title: string }> }
interface Summary { memory_id: string; title: string; summary: string }

export function createMapFirstRecallV3(options: { invoke: MapRecallInvokerV3; fallback: (task: string, signal: AbortSignal) => Promise<MapFirstRecallResultV3> }) {
  return { async recall(pin: PinnedGenerationV3, task: string, signal: AbortSignal, rootOffers?: readonly MapOfferV3[]): Promise<MapFirstRecallResultV3> {
    try {
      const root = parse<Index>(pin.files.get('indexes/root.json'))
      const rootPages = rootOffers && rootOffers.length > 0 ? rootOffers : createMapOfferPagesV3(pin).pages
      const rootChoices = rootPages.flatMap((page) => page.entries)
      const rootSelected: string[] = []
      for (const page of rootPages) {
        const pageRefs = page.entries.map((item) => item.ref)
        rootSelected.push(...select(await options.invoke({ stage: 'root_titles', task, items: page.entries.map((item) => ({ ...item })), signal }), pageRefs, 1))
      }
      let selected = rootSelected.length <= 1 ? rootSelected : select(
        await options.invoke({ stage: 'root_titles', task, items: rootChoices.filter((item) => rootSelected.includes(item.ref)).map((item) => ({ ...item })), signal }),
        rootSelected,
        1,
      )
      if (!selected.length) return { status: 'no_match', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_no_match' }
      let memoryRefs: string[] = []
      let depth = 0
      while (selected.length && depth < MAX_DEPTH) {
        const node = parse<Index>(pin.files.get(`indexes/nodes/${selected[0]}.json`))
        if (!select(await options.invoke({ stage: 'node_summary', task, items: [{ ref: node.node_id, title: node.title ?? '', summary: node.summary, kind: 'node' }], signal }), [node.node_id], 1).length) break
        const choices = [...node.children.map((item) => ({ ...item, kind: 'node' as const })), ...node.memories.map((item) => ({ ...item, kind: 'memory' as const }))]
        const pages = createMapOfferPagesV3(pin, node.node_id).pages
        const selectedByPage: string[] = []
        for (const page of pages) {
          const offered = page.entries.filter((item) => choices.some((choice) => choice.ref === item.ref))
          if (offered.length === 0) continue
          selectedByPage.push(...select(await options.invoke({ stage: 'node_titles', task, items: offered.map((item) => ({ ...item })), signal }), offered.map((item) => item.ref), 6))
        }
        selected = selectedByPage.length <= 6 ? selectedByPage : select(
          await options.invoke({ stage: 'node_titles', task, items: choices.filter((item) => selectedByPage.includes(item.ref)), signal }),
          selectedByPage,
          6,
        )
        const child = selected.find((ref) => node.children.some((item) => item.ref === ref))
        if (child) { selected = [child]; depth++; continue }
        memoryRefs = selected.filter((ref) => node.memories.some((item) => item.ref === ref)).slice(0, 5)
        break
      }
      if (!memoryRefs.length) return { status: 'no_match', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_no_match' }
      const summaries = memoryRefs.map((ref) => parse<Summary>(pin.files.get(`summaries/${ref}.json`)))
      const confirmed = select(await options.invoke({ stage: 'memory_summaries', task, items: summaries.map((item) => ({ ref: item.memory_id, title: item.title, summary: item.summary, kind: 'memory' as const })), signal }), memoryRefs, 3)
      if (!confirmed.length) return { status: 'no_match', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_no_match' }
      const contents = confirmed.map((ref) => ({ ref, content: pin.files.get(`contents/${ref}.md`) ?? fail() }))
      const receipt = createDisclosureReceiptV3({ schema_version: 1, generation_id: pin.generation_id, project_scope_id: pin.project_scope_id, offered_refs: [...new Set([...memoryRefs])], summary_refs: confirmed, content_refs: confirmed })
      return { status: 'completed', selected_memory_refs: confirmed, contents, receipt, fallback_used: false, reason_code: null }
    } catch (error: unknown) {
      if (error instanceof SubagentUnavailableError) {
        try { return { ...(await options.fallback(task, signal)), fallback_used: true } } catch { return { status: 'failed', selected_memory_refs: [], contents: [], fallback_used: true, reason_code: 'recall_navigation_failed' } }
      }
      if (error instanceof MemoryStoreError) return { status: 'failed', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: error.code }
      return { status: 'failed', selected_memory_refs: [], contents: [], fallback_used: false, reason_code: 'recall_navigation_failed' }
    }
  } }
}
