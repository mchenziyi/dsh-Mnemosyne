import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConsolidationModelDecisionV2, ConsolidationModelRequestV2 } from '../v2/consolidation-runtime.js'
import { createDshSubagentFactoryV3, runDshSubagentV3, type DshSubagentFactoryV3 } from './dsh-subagent.js'

export class SubagentProtocolError extends Error { readonly code = 'subagent_protocol_invalid' }
export interface ConsolidationJudgmentV3 { decision: 'skip' | 'create'; title?: string; summary?: string; content?: string; related_memory_refs?: string[]; reason_code?: string }

function parseJudgment(text: string): ConsolidationJudgmentV3 {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new SubagentProtocolError() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentProtocolError()
  const object = value as Record<string, unknown>
  if (object.decision === 'skip') {
    if (Object.keys(object).sort().join('\0') !== ['decision', 'reason_code'].join('\0') || typeof object.reason_code !== 'string') throw new SubagentProtocolError()
    return { decision: 'skip', reason_code: object.reason_code }
  }
  if (object.decision !== 'create' || Object.keys(object).sort().join('\0') !== ['content', 'decision', 'related_memory_refs', 'summary', 'title'].join('\0')) throw new SubagentProtocolError()
  if ([object.title, object.summary, object.content].some((item) => typeof item !== 'string' || item.length === 0) || !Array.isArray(object.related_memory_refs) || object.related_memory_refs.some((item) => typeof item !== 'string')) throw new SubagentProtocolError()
  return { decision: 'create', title: object.title as string, summary: object.summary as string, content: object.content as string, related_memory_refs: object.related_memory_refs as string[] }
}

export function buildConsolidationSubagentPromptV3(input: { task: string; outcome: string; used_memory_refs: readonly string[] }): string {
  return ['You are the Mnemosyne Consolidation Subagent.', 'Return JSON only. Return either {"decision":"skip","reason_code":"..."} or {"decision":"create","title":"...","summary":"...","content":"...","related_memory_refs":[]}.', 'Use skip when existing memories were only referenced and no new reusable condition, limitation, failure lesson, correction, or variant was discovered.', 'Use create only for genuinely new reusable experience; when it extends a used memory, include that memory ref in related_memory_refs. Never create only because a memory was read.', 'Do not include hidden reasoning.', JSON.stringify({ schema_version: 1, task: input.task, outcome: input.outcome, used_memory_refs: input.used_memory_refs })].join('\n')
}

export async function runConsolidationSubagentV3(parent: Agent, input: { task: string; outcome: string; used_memory_refs: readonly string[]; provider: string; model: string; signal: AbortSignal }, factory: DshSubagentFactoryV3 = createDshSubagentFactoryV3()): Promise<ConsolidationJudgmentV3> {
  const output = await runDshSubagentV3(parent, { task: buildConsolidationSubagentPromptV3(input), provider: input.provider, model: input.model, signal: input.signal }, factory)
  return parseJudgment(output)
}

export function createConsolidationSubagentModelV3(parent: Agent, factory: DshSubagentFactoryV3 = createDshSubagentFactoryV3()) {
  return async (request: ConsolidationModelRequestV2, route: { provider: string; model: string; signal: AbortSignal }): Promise<ConsolidationModelDecisionV2> => {
    const prompt = ['You are the Mnemosyne Consolidation Subagent.', 'Return JSON only and use the exact decision shape required by the stage.', 'Do not include hidden reasoning.', JSON.stringify(request)].join('\n')
    const output = await runDshSubagentV3(parent, { task: prompt, provider: route.provider, model: route.model, signal: route.signal }, factory)
    let value: unknown
    try { value = JSON.parse(output) } catch { throw new SubagentProtocolError() }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { decision?: unknown }).decision !== 'string') throw new SubagentProtocolError()
    const decision = (value as { decision: string }).decision
    const allowed: Record<string, string[]> = { judgment: ['skip', 'create'], category_titles: ['candidate', 'no_candidate'], category_summary: ['attach', 'expand', 'reject'], category_new: ['new'] }
    if (!allowed[request.stage]?.includes(decision)) throw new SubagentProtocolError()
    return value as ConsolidationModelDecisionV2
  }
}
