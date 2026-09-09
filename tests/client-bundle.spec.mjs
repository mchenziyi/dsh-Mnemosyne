import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

describe('published browser status component', () => {
  it('uses host React and renders the latest turn status as a chat node', async () => {
    const source = await readFile(new URL('../dist/client.mjs', import.meta.url), 'utf8')
    let plugin
    let Component
    let definition
    let injected
    let poll
    const clearInterval = vi.fn()
    const get = vi.fn().mockResolvedValue({ ok: true, value: { status: 'running', turn: 1 } })
    const requireHost = vi.fn((name) => {
      if (name === 'react') return React
      throw new Error(`Unexpected browser dependency: ${name}`)
    })
    runInNewContext(source, { window: {
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory(requireHost) } },
      setInterval: (callback) => { poll = callback; return 1 },
      clearInterval,
    } })
    const context = {
      remote: { $mount: async () => {}, mnemosyneStatus: { get } },
      inject: async (dependencies, callback) => {
        expect(dependencies).toEqual(['slots', 'uiConversation', 'remote', 'remote.mnemosyneStatus'])
        await callback(context)
      },
      uiConversation: {
        events: { register: (value) => { definition = value } },
      },
      slots: {
        inject: (name, callback) => {
          expect(name).toBe('conversation.chat.node')
          callback()
        },
        register: (options, component) => {
          expect(options.name).toBe('conversation.chat.node')
          expect(options.key).toBe('mnemosyne-consolidation')
          Component = component
          injected = options.inject
          return () => {}
        },
      },
    }
    await plugin.apply(context)
    await Promise.resolve()
    const startEvent = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
    const endEvent = { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }
    const startMatch = { event: startEvent, role: 'start', location: { kind: 'unresolved' } }
    const endMatch = { event: endEvent, role: 'update', location: { kind: 'unresolved' } }
    expect(definition.match(startEvent)).toEqual({ id: '1', role: 'start' })
    expect(definition.match(endEvent)).toEqual({ id: '1', role: 'update' })
    const state = definition.update({ state: definition.start({}, startMatch) }, endMatch)
    const node = definition.buildViewNode({
      key: 'mnemosyne-consolidation:1', id: '1', matches: [startMatch, endMatch], start: startMatch, state,
    })
    expect(node).toMatchObject({
      kind: 'mnemosyne-consolidation', target: 'chat', anchorSeq: 2.2,
      data: { turn: 1 },
    })
    const useChat = selector => selector({ timeline: { turnOrder: [1] } })
    let renderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(Component, {
          ...injected(), node, sessionId: 'session-a', useChat,
        }))
      })
      expect(requireHost).toHaveBeenCalledWith('react')
      expect(get).toHaveBeenCalledWith('session-a')
      expect(JSON.stringify(renderer.toJSON())).toContain('正在整理项目记忆…')
      for (const [status, text] of [
        ['created', '项目记忆已更新'],
        ['skipped', '本轮无需新增项目记忆'],
        ['failed', '项目记忆整理失败（主任务已结束）'],
      ]) {
        get.mockResolvedValue({ ok: true, value: { status, turn: 1 } })
        await act(async () => { await poll() })
        expect(JSON.stringify(renderer.toJSON())).toContain(text)
      }
      get.mockResolvedValue({ ok: true, value: null })
      await act(async () => {
        renderer.update(React.createElement(Component, {
          ...injected(), node: { ...node, data: { turn: 2 } }, sessionId: 'session-b',
          useChat: selector => selector({ timeline: { turnOrder: [2] } }),
        }))
      })
      expect(get).toHaveBeenLastCalledWith('session-b')
      expect(renderer.toJSON()).toBeNull()
      get.mockResolvedValue({ ok: false, error: { code: 'carrier_unavailable' } })
      await act(async () => { await poll() })
      expect(JSON.stringify(renderer.toJSON())).toContain('暂时无法获取项目记忆整理状态')
      get.mockResolvedValue({ ok: true, value: { status: 'running', turn: 2 } })
      await act(async () => { await poll() })
      expect(JSON.stringify(renderer.toJSON())).toContain('正在整理项目记忆…')
    } finally {
      if (renderer) await act(async () => renderer.unmount())
    }
    expect(clearInterval).toHaveBeenCalledWith(1)
  })

  it('does not poll status for a historical turn', async () => {
    const source = await readFile(new URL('../dist/client.mjs', import.meta.url), 'utf8')
    let plugin
    let Component
    let injected
    const get = vi.fn()
    const context = {
      remote: { $mount: async () => {}, mnemosyneStatus: { get } },
      inject: async (_dependencies, callback) => callback(context),
      uiConversation: { events: { register: () => {} } },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => { Component = component; injected = options.inject; return () => {} },
      },
    }
    runInNewContext(source, { window: {
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory(name => name === 'react' ? React : (() => { throw new Error(name) })()) } },
      setInterval: vi.fn(), clearInterval: vi.fn(),
    } })
    await plugin.apply(context)
    let renderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(Component, {
          ...injected(),
          node: { data: { turn: 1 } },
          sessionId: 'session-a',
          useChat: selector => selector({ timeline: { turnOrder: [1, 2] } }),
        }))
      })
      expect(renderer.toJSON()).toBeNull()
      expect(get).not.toHaveBeenCalled()
    } finally {
      if (renderer) await act(async () => renderer.unmount())
    }
  })
})
