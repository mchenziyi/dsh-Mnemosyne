import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SubagentUnavailableError } from './map-first-recall.js'

export interface DshSubagentRequestV3 { task: string; provider: string; model: string; signal: AbortSignal; form?: 'recall' | 'consolidation' }
export type DshSubagentFactoryV3 = (parent: Agent, request: DshSubagentRequestV3) => Promise<AgentHandle>
export class SubagentAbortedError extends Error { readonly code = 'subagent_aborted' }

export function buildRecallSubagentPromptV3(request: { stage: string; task: string; items: readonly { ref: string; title: string; summary?: string; kind: string }[] }): string {
  return [
    'You are the Mnemosyne Recall Subagent.',
    'Return JSON only with exactly one key: selected_refs (an array of refs).',
    'Choose only refs present in the supplied items. Do not explain your choice.',
    JSON.stringify({ schema_version: 1, stage: request.stage, task: request.task, items: request.items }),
  ].join('\n')
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

export function createDshSubagentFactoryV3(): DshSubagentFactoryV3 {
  return async (parent, request) => {
    if (!request.provider || !request.model || request.signal.aborted) throw new SubagentUnavailableError()
    try {
      return await parent.ctx.agents.create({
        sessionId: SessionId(`mnemosyne-${randomUUID()}`),
        meta: { cwd: parent.session.header.cwd, parentSession: parent.session.id, origin: 'subagent', delegationDepth: (parent.session.header.delegationDepth ?? 0) + 1 },
        agentOptions: { provider: request.provider, model: request.model, maxTokens: 512 },
        signal: request.signal,
        setup: (agentCtx) => {
          agentCtx.tools.restrict({ allow: [] })
          agentCtx.tools.guard(() => 'mnemosyne_subagent_tools_disabled')
        },
      })
    } catch {
      if (request.signal.aborted) throw new SubagentAbortedError()
      throw new SubagentUnavailableError()
    }
  }
}

export async function runDshSubagentV3(parent: Agent, request: DshSubagentRequestV3, factory: DshSubagentFactoryV3): Promise<string> {
  if (request.signal.aborted) throw new SubagentAbortedError()
  const handle = await factory(parent, request)
  const onAbort = (): void => {
    try { handle.agent.cancel({ kind: 'parent' }) } catch { /* disposal below remains authoritative */ }
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (request.signal.aborted) onAbort()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: request.task }], source: request.form === 'consolidation'
      ? { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'notice', summary: 'Consolidation subagent task' }
      : { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } }))
    await handle.agent.whenIdle()
    if (request.signal.aborted) throw new SubagentAbortedError()
    const messages = handle.agent.session.events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => textOf((event.data as unknown as { message: { content: readonly { type: string; text?: string }[] } }).message))
      .filter(Boolean)
    const output = messages.at(-1)
    if (!output) throw new SubagentUnavailableError()
    return output
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    await handle.dispose()
  }
}
