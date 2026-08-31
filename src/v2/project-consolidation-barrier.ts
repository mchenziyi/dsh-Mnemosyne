export interface ProjectConsolidationBarrierV2 {
  track(projectScopeId: string, operation: Promise<void>): void
  wait(projectScopeId: string): Promise<void>
  waitAll(): Promise<void>
}

export function createProjectConsolidationBarrierV2(): ProjectConsolidationBarrierV2 {
  const pending = new Map<string, Set<Promise<void>>>()

  return {
    track(projectScopeId, operation) {
      const operations = pending.get(projectScopeId) ?? new Set<Promise<void>>()
      operations.add(operation)
      pending.set(projectScopeId, operations)
      const remove = (): void => {
        operations.delete(operation)
        if (operations.size === 0) pending.delete(projectScopeId)
      }
      void operation.then(remove, remove)
    },
    async wait(projectScopeId) {
      await Promise.allSettled([...(pending.get(projectScopeId) ?? [])])
    },
    async waitAll() {
      await Promise.allSettled([...pending.values()].flatMap((operations) => [...operations]))
    },
  }
}
