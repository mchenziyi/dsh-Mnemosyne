import { describe, expect, it } from 'vitest'
import { createSubagentLifecycleV3 } from '../src/v3/subagent-lifecycle.js'

describe('v3 parent subagent lifecycle', () => {
  it('aborts the parent task set when cancelled', () => {
    const lifecycle = createSubagentLifecycleV3()
    const parent = {} as any
    const tasks = lifecycle.for(parent)
    expect(tasks.signal.aborted).toBe(false)
    tasks.cancel()
    expect(tasks.signal.aborted).toBe(true)
  })

  it('waits for tracked work and isolates parents', async () => {
    const lifecycle = createSubagentLifecycleV3()
    const parentA = {} as any
    const parentB = {} as any
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    lifecycle.for(parentA).track(pending)
    lifecycle.for(parentB).track(Promise.resolve())
    expect(lifecycle.for(parentA).size()).toBe(1)
    let settled = false
    const waitA = lifecycle.wait(parentA).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await waitA
    expect(settled).toBe(true)
  })

  it('disposes a parent only after its tasks settle', async () => {
    const lifecycle = createSubagentLifecycleV3()
    const parent = {} as any
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    lifecycle.for(parent).track(pending)
    const disposing = lifecycle.dispose(parent)
    await Promise.resolve()
    expect(lifecycle.for(parent).size()).toBe(1)
    release()
    await disposing
    await expect(lifecycle.wait(parent)).resolves.toBeUndefined()
  })
})
