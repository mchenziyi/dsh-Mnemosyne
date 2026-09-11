import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('published browser client', () => {
  it('mounts the remote service without registering Chat Nodes or slots', async () => {
    const source = await readFile(new URL('../dist/client.mjs', import.meta.url), 'utf8')
    let plugin
    const dispose = vi.fn().mockResolvedValue(undefined)
    const mount = vi.fn().mockResolvedValue(dispose)
    const requireModule = vi.fn((name) => { throw new Error(`unexpected browser dependency: ${name}`) })
    const context = {
      remote: { $mount: mount },
      inject: vi.fn(),
      uiConversation: { events: { register: vi.fn() } },
      slots: { inject: vi.fn(), register: vi.fn() },
    }
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(requireModule) } } },
    })
    expect(requireModule).not.toHaveBeenCalled()
    expect(Array.from(plugin.inject)).toEqual(['remote'])
    const returnedDispose = await plugin.apply(context)
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ package: '@cziyi/dsh-mnemosyne' }))
    expect(returnedDispose).toBe(dispose)
    expect(context.inject).not.toHaveBeenCalled()
    expect(context.uiConversation.events.register).not.toHaveBeenCalled()
    expect(context.slots.inject).not.toHaveBeenCalled()
  })
})
