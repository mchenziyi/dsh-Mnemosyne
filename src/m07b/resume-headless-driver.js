import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { writeSessionEvidence, extractToolEventSummary } from './session-evidence.js'
import { createResumeCompletedReceipt, writeResumeCompletedReceiptSync } from './wiring-receipt.js'
import { computeSha256, FROZEN_CANARY_TASKS } from './canary-protocol.js'

export const name = 'canary-resume-headless-driver'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'headlessStartup']

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/

function resolveRunIdFromTaskOrArgs(config, task) {
  const allArgs = process.argv.join(' ')
  let taskMatchedId = null
  if (allArgs.includes(FROZEN_CANARY_TASKS.run_2) || task === FROZEN_CANARY_TASKS.run_2) {
    taskMatchedId = 'run_2'
  } else if (allArgs.includes(FROZEN_CANARY_TASKS.run_3) || task === FROZEN_CANARY_TASKS.run_3) {
    taskMatchedId = 'run_3'
  }

  const configRunId = config?.runId
  if (configRunId) {
    if (configRunId !== 'run_2' && configRunId !== 'run_3') {
      throw new Error('canary_resume_failed')
    }
    if (taskMatchedId && configRunId !== taskMatchedId) {
      throw new Error('canary_resume_failed')
    }
    return configRunId
  }

  if (taskMatchedId) {
    return taskMatchedId
  }

  throw new Error('canary_resume_failed')
}

async function run(ctx, config, io) {
  // 1. Read actual module raw bytes and compute actualModuleSha256
  let actualModuleSha256
  try {
    const currentFilePath = fileURLToPath(import.meta.url)
    const content = readFileSync(currentFilePath, 'utf8')
    actualModuleSha256 = computeSha256(content)
  } catch {
    throw new Error('canary_resume_failed')
  }

  // 2. Validate expectedModuleSha256 is present and valid
  const expectedModuleSha256 = config?.expectedModuleSha256
  if (!expectedModuleSha256 || typeof expectedModuleSha256 !== 'string' || !HASH_REGEX.test(expectedModuleSha256)) {
    throw new Error('canary_resume_failed')
  }

  // 3. Strict equality
  if (actualModuleSha256 !== expectedModuleSha256) {
    throw new Error('canary_resume_failed')
  }

  if (typeof ctx.get === 'function') {
    await ctx.get('loader')?.await()
  }
  const agents = (typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents)
  const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions)
  const defaultModel = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel)
  const headlessStartup = (typeof ctx.get === 'function' ? ctx.get('headlessStartup') : ctx.headlessStartup)

  let resumeSessionId = config?.resumeSessionId
  let expectedCwd = config?.expectedCwd || process.cwd()
  let task = config?.task || headlessStartup?.task

  if (!task) {
    for (let i = process.argv.length - 1; i >= 0; i--) {
      const arg = process.argv[i]
      if (arg && (arg.startsWith('canary run') || arg.includes('Aurora'))) {
        task = arg
        break
      }
    }
  }

  const evidenceDir = config?.evidenceDir || (process.env.DSH_HOME ? join(process.env.DSH_HOME, '..', 'evidence') : null)
  let run1SessionId = config?.run1SessionId || null
  if (evidenceDir) {
    try {
      const run1Path = join(evidenceDir, 'session-events', 'run_1.json')
      const raw = JSON.parse(readFileSync(run1Path, 'utf8'))
      run1SessionId = raw?.summary?.session_id || raw?.session_id || run1SessionId
      if (!resumeSessionId) {
        resumeSessionId = run1SessionId
      }
    } catch {}
  }
  if (!run1SessionId && resumeSessionId) {
    run1SessionId = resumeSessionId
  }

  if (!resumeSessionId || !run1SessionId) {
    throw new Error('canary_resume_failed')
  }

  if (!agents || typeof agents.resume !== 'function') {
    throw new Error('canary_resume_failed')
  }

  const selection = defaultModel?.currentSelection?.()

  const res = await agents.resume({
    resumeSessionId,
    setup: (agentCtx) => {
      if (selection) {
        installModelSelection(agentCtx, {
          current: selection,
          assembled: void 0,
        })
      }
    },
  })
  const agent = res.agent || res

  if (!agent || !agent.session) {
    throw new Error('canary_resume_failed')
  }

  if (agent.session.id !== run1SessionId) {
    throw new Error('canary_resume_failed')
  }

  // Verify Session CWD with realpath normalization
  const sessionCwd = agent.session.header?.cwd
  let normSession = sessionCwd
  let normExpected = expectedCwd
  try {
    if (sessionCwd) normSession = realpathSync(sessionCwd)
  } catch {}
  try {
    if (expectedCwd) normExpected = realpathSync(expectedCwd)
  } catch {}

  if (normExpected && normSession && normSession !== normExpected) {
    if (typeof res.dispose === 'function') {
      await res.dispose().catch(() => {})
    }
    throw new Error('session_cwd_mismatch')
  }

  await agent.whenIdle()
  const firstSeq = agent.session.seq

  if (task && typeof agent.followup === 'function') {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      })
    )
  }

  await agent.whenIdle()

  if (sessions && typeof sessions.flush === 'function') {
    await sessions.flush(agent.session)
  }

  const resolvedRunId = resolveRunIdFromTaskOrArgs(config, task)

  if (evidenceDir && agent.session) {
    const summary = extractToolEventSummary(agent.session.events || [])
    summary.session_id = agent.session.id
    await writeSessionEvidence(evidenceDir, resolvedRunId, summary)

    // Write ResumeCompletedReceipt
    if (resolvedRunId === 'run_2' || resolvedRunId === 'run_3') {
      const receipt = createResumeCompletedReceipt({
        run_id: resolvedRunId,
        module_sha256: actualModuleSha256,
        resumed_session_id_sha256: computeSha256(agent.session.id),
        run_1_session_id_sha256: computeSha256(run1SessionId),
        same_session: true,
      })
      writeResumeCompletedReceiptSync(evidenceDir, receipt)
    }
  }

  if (typeof res.dispose === 'function') {
    await res.dispose().catch(() => {})
  }

  const outcome = summarize(agent.session.events || [], firstSeq)
  if (outcome.text) {
    io.stdout.write(outcome.text + '\n')
  }
  if (outcome.reason?.kind === 'error') {
    io.stderr.write('dsh: canary_resume_failed\n')
  }

  io.exit(outcome.reason?.kind === 'completed' || !outcome.reason ? 0 : 1)
}

export function apply(ctx, config) {
  const exitFn =
    (typeof ctx.get === 'function' ? ctx.get('appExit') : ctx.appExit) ||
    ((code) => {
      if (!process.env.VITEST) process.exit(code ?? 0)
    })
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => {
      if (typeof exitFn === 'function') {
        exitFn(code)
      }
      if (!process.env.VITEST) {
        process.exit(code ?? 0)
      }
    },
  }

  const runner = () =>
    run(ctx, config, io).catch((err) => {
      io.stderr.write('dsh: canary_resume_failed\n')
      io.exit(1)
      if (process.env.VITEST) throw err
    })

  if (typeof ctx.on === 'function' && !ctx.headlessStartup && (!ctx.get || !ctx.get('headlessStartup'))) {
    ctx.on('ready', runner)
  } else {
    runner()
  }
}
