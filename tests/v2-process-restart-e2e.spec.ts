import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectScopeId } from '../src/runtime-scope.js'
import { openOKFMemoryV2Store } from '../src/v2/okf-memory-store.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

const interceptorSource = `
import { writeFileSync } from 'node:fs'

export const name = 'v2-restart-offline-model'

function stream(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

export function apply(ctx) {
  ctx.on('llm/stream', (options) => {
    const system = typeof options?.system === 'string' ? options.system : ''
    const messages = JSON.stringify(options?.messages ?? [])
    if (options?.purpose === 'title' || options?.purpose === 'session-title' || system.toLowerCase().includes('session title')) {
      return stream('v0.2 restart acceptance')
    }
    if (system.startsWith('You navigate project memory.')) {
      const request = JSON.parse(options.messages.at(-1).content.find((block) => block.type === 'text').text)
      return stream(JSON.stringify({ selected_refs: request.items.length === 0 ? [] : [request.items[0].ref] }))
    }
    if (system.startsWith('Judge whether the completed turn')) {
      const request = JSON.parse(options.messages.at(-1).content.find((block) => block.type === 'text').text)
      return stream(JSON.stringify(request.evidence.task.includes('Process A') ? {
        decision: 'create',
        title: '进程重启后恢复认证窗口经验',
        summary: '认证状态切换时保留旧状态窗口，进程重启后仍需复用。',
        content: '## 已知踩坑\\n\\n进程重启后仍应恢复的完整经验：立即撤销旧认证状态会中断并发请求。',
        related_memory_refs: [],
      } : { decision: 'skip', reason_code: 'no_reusable_knowledge' }))
    }
    if (system.startsWith('Choose one offered direct child category')) {
      return stream(JSON.stringify({ decision: 'new', title: 'Authentication', summary: '认证与状态切换。' }))
    }
    if (system.startsWith('After reading the selected category summary')) return stream(JSON.stringify({ decision: 'attach' }))

    const sawRecall = messages.includes('[Mnemosyne Recall v2') && messages.includes('进程重启后仍应恢复的完整经验')
    const receipt = process.env.V2_RESTART_RECEIPT
    if (receipt) writeFileSync(receipt, JSON.stringify({ pid: process.pid, saw_recall: sawRecall, messages }), { mode: 0o600 })
    return stream(messages.includes('Process A')
      ? '已完成 Process A 认证窗口修复并验证。'
      : '已根据恢复的项目经验处理 Process B 同类问题。')
  })
}
`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.2 real DSH process restart acceptance', () => {
  it('persists in Process A and recalls from disk in a new Process B session', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemosyne-v2-restart-')))
    roots.push(root)
    const projectRoot = join(root, 'project')
    const dshHome = join(root, 'dsh-home')
    const packRoot = join(root, 'pack')
    await mkdir(projectRoot, { recursive: true, mode: 0o700 })
    await mkdir(dshHome, { recursive: true, mode: 0o700 })
    await mkdir(packRoot, { recursive: true, mode: 0o700 })

    const repoRoot = join(new URL('../', import.meta.url).pathname)
    await execFileAsync('corepack', ['pnpm', 'build'], { cwd: repoRoot })
    await execFileAsync('corepack', ['pnpm', 'pack', '--pack-destination', packRoot], { cwd: repoRoot })
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
      '    - id: v2-restart-offline-model',
      `      name: '${interceptor}'`,
      '',
    ].join('\n'), { mode: 0o600 })

    const env = {
      PATH: process.env.PATH!,
      HOME: join(root, 'home'),
      DSH_HOME: dshHome,
      TMPDIR: join(root, 'tmp'),
      NO_UPDATE_NOTIFIER: '1',
      npm_config_prefer_offline: 'true',
    }
    await mkdir(env.HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 })
    await execFileAsync('dsh', ['plugin', '--profile', 'headless', 'add', tarball], { env, timeout: 60000 })

    const receiptA = join(root, 'process-a.json')
    await execFileAsync('dsh', ['--profile', 'headless', '--patch', patch, 'Process A：认证状态切换故障已经通过保留旧状态窗口解决。'], {
      cwd: projectRoot, env: { ...env, V2_RESTART_RECEIPT: receiptA }, timeout: 30000, maxBuffer: 1024 * 1024,
    })
    const first = JSON.parse(await readFile(receiptA, 'utf8')) as { pid: number; saw_recall: boolean }
    expect(first.saw_recall).toBe(false)
    const scope = computeProjectScopeId(await realpath(projectRoot))
    const store = openOKFMemoryV2Store({ project_root: projectRoot, project_scope_id: scope })
    expect((await store.listMemories()).map((memory) => memory.title)).toEqual(['进程重启后恢复认证窗口经验'])

    const receiptB = join(root, 'process-b.json')
    await execFileAsync('dsh', ['--profile', 'headless', '--patch', patch, 'Process B：刷新认证时并发请求中断，该如何避免？'], {
      cwd: projectRoot, env: { ...env, V2_RESTART_RECEIPT: receiptB }, timeout: 30000, maxBuffer: 1024 * 1024,
    })
    const second = JSON.parse(await readFile(receiptB, 'utf8')) as { pid: number; saw_recall: boolean; messages: string }
    expect(second.pid).not.toBe(first.pid)
    expect(second.saw_recall).toBe(true)
    expect(second.messages).toContain('进程重启后仍应恢复的完整经验')

    const log = await readFile(join(projectRoot, '.dsh-mnemosyne', 'debug', 'runtime.jsonl'), 'utf8')
    for (const stage of ['root_titles', 'node_summary', 'node_titles', 'memory_summaries']) expect(log).toContain(stage)
    expect(log).toContain('recall_completed')
  }, 90000)
})
