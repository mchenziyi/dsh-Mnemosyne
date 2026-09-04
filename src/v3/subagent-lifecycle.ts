import type { Agent } from '@deepseek-ai/dsh-agent'

export interface ParentTaskSetV3 {
  readonly signal: AbortSignal
  track<T>(task: Promise<T>): Promise<T>
  wait(): Promise<void>
  cancel(): void
  size(): number
}

export interface SubagentLifecycleV3 {
  for(agent: Agent): ParentTaskSetV3
  wait(agent: Agent): Promise<void>
  waitAll(): Promise<void>
  dispose(agent: Agent): Promise<void>
}

function createTaskSet(): ParentTaskSetV3 {
  const tasks = new Set<Promise<unknown>>()
  const controller = new AbortController()
  let cancelled = false
  return {
    signal: controller.signal,
    track<T>(task: Promise<T>): Promise<T> {
      if (cancelled) return Promise.reject(new Error('subagent_parent_disposed'))
      const settled = task.then(() => undefined, () => undefined)
      tasks.add(settled)
      void settled.then(() => tasks.delete(settled))
      return task
    },
    wait: async () => { await Promise.all([...tasks]) },
    cancel: () => { cancelled = true; controller.abort() },
    size: () => tasks.size,
  }
}

export function createSubagentLifecycleV3(): SubagentLifecycleV3 {
  const sets = new Map<Agent, ParentTaskSetV3>()
  return {
    for(agent) {
      const existing = sets.get(agent)
      if (existing) return existing
      const created = createTaskSet()
      sets.set(agent, created)
      return created
    },
    wait: async (agent) => { await sets.get(agent)?.wait() },
    waitAll: async () => { await Promise.all([...sets.values()].map((set) => set.wait())) },
    dispose: async (agent) => {
      const set = sets.get(agent)
      if (!set) return
      set.cancel()
      await set.wait()
      sets.delete(agent)
    },
  }
}
