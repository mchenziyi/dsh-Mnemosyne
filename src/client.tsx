import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ChatNodeViewProps, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationMatch, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import React from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from './typert.remote-client.js'

type Status = { status: 'running' | 'created' | 'skipped' | 'failed'; turn: number } | null
type StatusRemote = { get: (id: string) => Promise<RemoteResult<Status>> }

interface MnemosyneConsolidationChatData {
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'mnemosyne-consolidation': MnemosyneConsolidationChatData
  }
}

interface MnemosyneConsolidationState {
  readonly turn: number
  readonly end?: ConversationMatch
}

const consolidationDefinition: ConversationNodeDefinition<MnemosyneConsolidationState> = {
  kind: 'mnemosyne-consolidation',
  target: 'chat',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'turn/start') throw new Error('mnemosyne consolidation start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update(context, match) {
    return match.event.type === 'turn/end' ? { ...context.state, end: match } : context.state
  },
  publication(match) {
    return match.event.type === 'turn/end' ? 'immediate' : 'none'
  },
  buildViewNode(context) {
    const state = context.state
    if (!state?.end) return null
    return {
      key: context.key,
      kind: 'mnemosyne-consolidation',
      id: context.id,
      target: 'chat',
      // Keep a distinct render position from the built-in turn-tail, which is
      // anchored at turn/end as well. A fractional offset is supported by the
      // chat sorter and places the status strip immediately after the answer.
      anchorSeq: state.end.event.seq + 0.2,
      location: context.start?.location ?? state.end.location,
      visibility: 'visible',
      data: { turn: state.turn },
    }
  },
}

type StatusNodeProps = ChatNodeViewProps<'mnemosyne-consolidation'> & { statusRemote: StatusRemote }

function StatusNode({ node, sessionId, statusRemote, useChat }: StatusNodeProps): React.ReactElement | null {
  // The node is only published after turn/end, at which point the background
  // operation may not have written its first remote snapshot yet. Start in the
  // visible running state so a fast consolidation never renders a blank gap.
  const [status, setStatus] = React.useState<Status>({ status: 'running', turn: node.data.turn })
  const [unavailable, setUnavailable] = React.useState(false)
  const isLatestTurn = useChat((snapshot: ChatSnapshot) => snapshot.timeline.turnOrder.at(-1) === node.data.turn)

  React.useEffect(() => {
    if (!isLatestTurn) {
      setStatus(null)
      setUnavailable(false)
      return
    }
    setStatus({ status: 'running', turn: node.data.turn })
    setUnavailable(false)
    let active = true
    let timer: number | undefined
    const read = async () => {
      try {
        const result = await statusRemote.get(sessionId)
        if (!result.ok) throw result.error
        if (!active) return
        const next = result.value?.turn === node.data.turn ? result.value : null
        setStatus(next)
        setUnavailable(false)
        if (next && next.status !== 'running' && timer !== undefined) {
          window.clearInterval(timer)
          timer = undefined
        }
      } catch {
        if (active) {
          setStatus(null)
          setUnavailable(true)
        }
      }
    }
    void read()
    timer = window.setInterval(read, 1000)
    return () => {
      active = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [isLatestTurn, node.data.turn, sessionId, statusRemote])

  if (!isLatestTurn) return null
  const text = unavailable ? '暂时无法获取项目记忆整理状态'
    : status?.status === 'running' ? '正在整理项目记忆…'
      : status?.status === 'created' ? '项目记忆已更新'
        : status?.status === 'skipped' ? '本轮无需新增项目记忆'
          : status?.status === 'failed' ? '项目记忆整理失败（主任务已结束）'
            : null
  if (text === null) return null
  return React.createElement('div', {
    role: 'status',
    'aria-live': 'polite',
    'data-mnemosyne-status': unavailable ? 'unavailable' : status?.status,
    style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  },
  React.createElement('span', { style: { fontWeight: 600 } }, 'Mnemosyne'),
  React.createElement('span', null, text))
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['slots', 'uiConversation', 'remote', 'remote.mnemosyneStatus'], (scoped) => {
    const statusRemote = (scoped.remote as unknown as { mnemosyneStatus: StatusRemote }).mnemosyneStatus
    scoped.uiConversation.events.register(consolidationDefinition)
    scoped.slots.inject('conversation.chat.node', () => scoped.slots.register({
      name: 'conversation.chat.node',
      key: 'mnemosyne-consolidation',
      inject: () => ({ statusRemote }),
    }, StatusNode))
  })
}

export const inject = ['remote'] as const
