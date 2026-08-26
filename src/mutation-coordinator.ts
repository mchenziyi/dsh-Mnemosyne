export interface MutationCoordinator {
  run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T>
}

export function createMutationCoordinator(): MutationCoordinator {
  const queues = new Map<string, Promise<unknown>>()

  return {
    async run<T>(projectScopeId: string, operation: () => Promise<T>): Promise<T> {
      const prev = queues.get(projectScopeId) ?? Promise.resolve()
      let tail!: Promise<unknown>
      const next = prev.then(
        () => operation(),
        () => operation()
      )
      tail = next.catch(() => {}).finally(() => {
        if (queues.get(projectScopeId) === tail) {
          queues.delete(projectScopeId)
        }
      })
      queues.set(projectScopeId, tail)
      return await next
    },
  }
}
