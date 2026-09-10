import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

function parseRuntimeRows(text: string): Array<{ event?: string; reason_code?: string; result?: string; model_role?: string; stage?: string; uncached_input_tokens?: number; cache_read_tokens?: number }> {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event?: string; reason_code?: string; result?: string; model_role?: string; stage?: string; uncached_input_tokens?: number; cache_read_tokens?: number })
}

function lifecycleFailures(rows: Array<{ event?: string; reason_code?: string; result?: string }>): string[] {
  return rows
    .filter((row) => row.result === 'failed' || row.event === 'consolidation_failed' || row.reason_code?.endsWith('_failed') || row.reason_code === 'subagent_create_rejected')
    .map((row) => row.reason_code ?? row.event ?? 'unknown_failure')
}

const interceptorSource = `
import { writeFileSync } from 'node:fs'

export const name = 'v3-restart-offline-model'

function stream(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function toolStream(mapRef) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'call_mnemosyne_recall', name: 'mnemosyne_recall', argumentsDelta: JSON.stringify({ map_ref: mapRef }) }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_mnemosyne_recall', name: 'mnemosyne_recall', arguments: JSON.stringify({ map_ref: mapRef }) } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
}

function lastText(options) {
  const content = options?.messages?.at(-1)?.content
  return Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join('\\n') : ''
}

export function apply(ctx) {
  let mapRequested = false
  const recallCalls = []
  ctx.on('llm/stream', (options) => {
    const system = typeof options?.system === 'string' ? options.system : ''
    const messages = JSON.stringify(options?.messages ?? [])
    const last = lastText(options)
    if (options?.purpose === 'title' || options?.purpose === 'session-title' || system.toLowerCase().includes('session title')) {
      return stream('v0.3 restart acceptance')
    }
    if (last.includes('You are the Mnemosyne Recall Subagent.')) {
      const packet = JSON.parse(last.split('\\n').at(-1))
      recallCalls.push({ stage: packet.stage, session_id: String(options?.sessionId ?? '') })
      return stream(JSON.stringify({ selected_refs: packet.items.length === 0 ? [] : [packet.items[0].ref] }))
    }
    if (last.includes('You are the Mnemosyne Consolidation Subagent.')) {
      const request = JSON.parse(last.split('\\n').at(-1))
      if (request.stage === 'judgment') return stream(JSON.stringify(request.evidence.task.includes('Process A') ? {
        decision: 'create',
        title: '进程重启后恢复认证窗口经验',
        summary: '认证状态切换时保留旧状态窗口，进程重启后仍需复用。',
        content: '## 已知踩坑\\n\\n进程重启后仍应恢复的完整经验：立即撤销旧认证状态会中断并发请求。',
        related_memory_refs: [],
      } : { decision: 'skip', reason_code: 'no_reusable_knowledge' }))
      if (request.stage === 'category_titles') return stream(JSON.stringify({ decision: 'no_candidate' }))
      if (request.stage === 'category_new') return stream(JSON.stringify({ decision: 'new', title: 'Authentication', summary: '认证与状态切换。' }))
      return stream(JSON.stringify({ decision: 'attach' }))
    }
    if (system.startsWith('You navigate project memory.')) return stream(JSON.stringify({ selected_refs: [] }))

    const mapText = Array.isArray(options?.messages)
      ? options.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === 'text' && block.text.startsWith('[Mnemosyne Map v3'))
      : undefined
    const sawMap = mapText?.type === 'text'
    const hasRecallTool = JSON.stringify(options?.tools ?? []).includes('mnemosyne_recall')
    if (!mapRequested && sawMap && hasRecallTool) {
      if (mapText?.type === 'text') {
        const map = JSON.parse(mapText.text.slice(mapText.text.indexOf('\\n') + 1))
        if (typeof map.map_ref === 'string') { mapRequested = true; return toolStream(map.map_ref) }
      }
    }
    const recallToolAvailable = hasRecallTool && sawMap
    const receipt = process.env.V3_RESTART_RECEIPT
    if (receipt) writeFileSync(receipt, JSON.stringify({ pid: process.pid, saw_map: sawMap, recall_tool_available: recallToolAvailable, parent_session_id: String(options?.sessionId ?? ''), recall_calls: recallCalls, messages }), { mode: 0o600 })
    return stream(messages.includes('Process A')
      ? '已完成 Process A 认证窗口修复并验证。'
      : '已根据恢复的项目经验处理 Process B 同类问题。')
  })
}
`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.3 real DSH process restart acceptance', () => {
  it('uses the production map-first subagent path across two fresh DSH processes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v3-restart-')))
    roots.push(root)
    const projectRoot = join(root, 'project')
    const dshHome = join(root, 'dsh-home')
    const packRoot = join(root, 'pack')
    await mkdir(projectRoot, { recursive: true, mode: 0o700 })
    await mkdir(dshHome, { recursive: true, mode: 0o700 })
    await mkdir(packRoot, { recursive: true, mode: 0o700 })

    const repoRoot = new URL('../', import.meta.url).pathname
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { packageManager?: string }
    const pnpmVersion = manifest.packageManager?.match(/^pnpm@(.+)$/)?.[1]
    expect(pnpmVersion).toBe('11.7.0')
    const binRoot = join(root, 'bin')
    await mkdir(binRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(binRoot, 'pnpm'), `#!/bin/sh\nexec corepack pnpm@${pnpmVersion} "$@"\n`, { mode: 0o700 })
    const hostCorepackHome = process.env.COREPACK_HOME ?? join(homedir(), '.cache', 'node', 'corepack')
    const isolatedCorepackHome = join(root, 'corepack-home')
    await mkdir(join(isolatedCorepackHome, 'v1', 'pnpm'), { recursive: true, mode: 0o700 })
    await cp(join(hostCorepackHome, 'v1', 'pnpm', pnpmVersion!), join(isolatedCorepackHome, 'v1', 'pnpm', pnpmVersion!), { recursive: true })
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot })
    await execFileAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', packRoot], { cwd: repoRoot })
    const tarballs = (await readdir(packRoot)).filter((name) => name.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = join(packRoot, tarballs[0]!)

    const interceptor = join(root, 'offline-model.mjs')
    const patch = join(root, 'offline-model.patch.yml')
    await writeFile(interceptor, interceptorSource, { mode: 0o600 })
    await writeFile(patch, [
      '- id: llm-deepseek',
      '  disabled: true',
      '- insert:',
      '    - id: v3-restart-offline-model',
      `      name: '${interceptor}'`,
      '',
    ].join('\n'), { mode: 0o600 })

    const env = {
      PATH: `${binRoot}:${process.env.PATH!}`,
      HOME: join(root, 'home'),
      DSH_HOME: dshHome,
      TMPDIR: join(root, 'tmp'),
      NO_UPDATE_NOTIFIER: '1',
      npm_config_offline: 'true',
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_HOME: isolatedCorepackHome,
    }
    await mkdir(env.HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 })
    const pinnedPnpm = await execFileAsync('pnpm', ['--version'], { cwd: projectRoot, env, timeout: 10000 })
    expect(pinnedPnpm.stdout.trim()).toBe(pnpmVersion)
    await execFileAsync('dsh', ['plugin', '--profile', 'headless', 'add', tarball], { env, timeout: 60000 })

    const receiptA = join(root, 'process-a.json')
    await execFileAsync('dsh', ['--profile', 'headless', '--patch', patch, 'Process A：认证状态切换故障已经通过保留旧状态窗口解决。'], {
      cwd: projectRoot, env: { ...env, V3_RESTART_RECEIPT: receiptA }, timeout: 30000, maxBuffer: 1024 * 1024,
    })
    const first = JSON.parse(await readFile(receiptA, 'utf8')) as { pid: number; saw_map: boolean; recall_tool_available: boolean }
    expect(first.recall_tool_available).toBe(false)
    const scope = computeProjectScopeId(await realpath(projectRoot))
    const store = openOKFMemoryV2Store({ project_root: projectRoot, project_scope_id: scope })
    const processALog = await readFile(join(projectRoot, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')
    const processARows = parseRuntimeRows(processALog)
    expect(lifecycleFailures(processARows), `Process A lifecycle failures: ${lifecycleFailures(processARows).join(', ')}`).toEqual([])
    expect((await store.listMemories()).map((memory) => memory.title)).toEqual(['进程重启后恢复认证窗口经验'])

    const receiptB = join(root, 'process-b.json')
    await execFileAsync('dsh', ['--profile', 'headless', '--patch', patch, 'Process B：刷新认证时并发请求中断，该如何避免？'], {
      cwd: projectRoot, env: { ...env, V3_RESTART_RECEIPT: receiptB }, timeout: 30000, maxBuffer: 1024 * 1024,
    })
    const second = JSON.parse(await readFile(receiptB, 'utf8')) as { pid: number; saw_map: boolean; recall_tool_available: boolean; parent_session_id: string; recall_calls: Array<{ stage: string; session_id: string }>; messages: string }
    expect(second.pid).not.toBe(first.pid)
    expect(second.saw_map).toBe(true)
    expect(second.recall_tool_available).toBe(true)
    expect(second.recall_calls.map((call) => call.stage)).toEqual(['root_titles', 'node_summary', 'node_titles', 'memory_summaries'])
    expect(second.recall_calls.every((call) => call.session_id.length > 0 && call.session_id !== second.parent_session_id)).toBe(true)
    expect(second.messages).toContain('[Mnemosyne Recall v3')
    expect(second.messages).toContain('进程重启后仍应恢复的完整经验')

    const log = await readFile(join(projectRoot, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')
    const finalRows = parseRuntimeRows(log)
    expect(lifecycleFailures(finalRows), `Final lifecycle failures: ${lifecycleFailures(finalRows).join(', ')}`).toEqual([])
    expect(log).toContain('"route":"map"')
    expect(log).toContain('"event":"recall_completed"')
    expect(log).toContain('"event":"consolidation_subagent_created"')
    expect(log).toContain('"event":"consolidation_subagent_completed"')
    expect(log).toContain('"event":"consolidation_subagent_disposed"')
    expect(log).toContain('"event":"consolidation_created"')
    const usageRows = finalRows.filter((row) => row.event === 'model_usage')
    expect(new Set(usageRows.map((row) => row.model_role))).toEqual(new Set(['parent', 'recall', 'consolidation']))
    expect(usageRows.filter((row) => row.model_role === 'recall').map((row) => row.stage)).toEqual(expect.arrayContaining(['root_titles', 'node_summary', 'node_titles', 'memory_summaries']))
    expect(usageRows.every((row) => row.uncached_input_tokens === 3 && row.cache_read_tokens === 30)).toBe(true)

  }, 90000)
})
