import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { claimLlmRequest, recordLlmOutcome } from './budget-ledger.js'
import { extractStrictSessionEvidence, writeStrictSessionEvidence } from './business-evidence.js'
import { createSidecarLoadedReceipt, writeSidecarLoadedReceiptSync } from './wiring-receipt.js'
import { computeSha256, computeProjectScopeId, FROZEN_CANARY_TASKS } from './canary-protocol.js'

export const name = 'canary-audit-sidecar'
export const inject = ['sessionPersistence', 'llm']

const HASH_REGEX = /^sha256_[0-9a-f]{64}$/

function resolveRunId(config) {
  if (config?.runId) return config.runId
  const allArgs = process.argv.join(' ')
  for (const [runId, taskText] of Object.entries(FROZEN_CANARY_TASKS)) {
    if (allArgs.includes(taskText)) return runId
  }
  const m = allArgs.match(/canary run (\d)/i)
  if (m) return `run_${m[1]}`
  if (allArgs.includes('project-b') || allArgs.includes('project_b')) return 'run_6'
  throw new Error('canary_sidecar_unrecognized_run_id')
}

export function apply(ctx, config) {
  const evidenceDir = config?.evidenceDir || (process.env.DSH_HOME ? join(process.env.DSH_HOME, '..', 'evidence') : null)
  if (!evidenceDir) {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  // 1. Read actual module raw bytes and compute actualModuleSha256
  let actualModuleSha256
  try {
    const currentFilePath = fileURLToPath(import.meta.url)
    const content = readFileSync(currentFilePath, 'utf8')
    actualModuleSha256 = computeSha256(content)
  } catch {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  // 2. Validate expectedModuleSha256 is present and valid
  const expectedModuleSha256 = config?.expectedModuleSha256
  if (!expectedModuleSha256 || typeof expectedModuleSha256 !== 'string' || !HASH_REGEX.test(expectedModuleSha256)) {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  // 3. Strict equality
  if (actualModuleSha256 !== expectedModuleSha256) {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  let runId
  try {
    runId = resolveRunId(config)
  } catch {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  try {
    const receipt = createSidecarLoadedReceipt({
      run_id: runId,
      module_sha256: actualModuleSha256,
    })
    writeSidecarLoadedReceiptSync(evidenceDir, receipt)
  } catch {
    process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    throw new Error('canary_sidecar_evidence_failed')
  }

  let currentSession = null

  // 1. Session evidence flush helper
  async function flushSessionEvidence(session, isFinal = false) {
    try {
      let sp = null
      try {
        sp = ctx.root?.sessionPersistence || (typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null) || ctx.sessionPersistence
      } catch {}
      if (sp) {
        const target = session || currentSession
        let targetId = target?.id
        if (!targetId && typeof sp.list === 'function') {
          const sessions = await sp.list()
          if (sessions && sessions.length > 0) {
            targetId = sessions[sessions.length - 1].id
          }
        }

        if (targetId && typeof sp.inspect === 'function') {
          const inspected = await sp.inspect(targetId)
          if (inspected && Array.isArray(inspected.events)) {
            const projectScopeId = computeProjectScopeId(process.cwd())
            const strictEvidence = extractStrictSessionEvidence({
              runId,
              projectScopeId,
              sessionId: targetId,
              sessionEvents: inspected.events,
            })
            await writeStrictSessionEvidence(evidenceDir, strictEvidence, { allowOverwrite: true })
          }
        }
      }
    } catch {
      if (isFinal) {
        process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
      }
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      if (session) {
        currentSession = session
      }
      if (event && event.type === 'turn/end') {
        flushSessionEvidence(session, false)
        setImmediate(() => flushSessionEvidence(session, false))
      }
    })

    ctx.on('session/disposed', (session) => {
      flushSessionEvidence(session, true)
    })

    ctx.on('dispose', async () => {
      await flushSessionEvidence(currentSession, true)
    })

    ctx.on('agent/created', (payload) => {
      if (payload?.agent?.session) {
        currentSession = payload.agent.session
      }
    })

    ctx.on(
      'llm/stream',
      (options, next) => {
        const allMsgText = JSON.stringify(options?.messages || '')
        const sysText = typeof options?.system === 'string'
          ? options.system
          : JSON.stringify(options?.system || '')

        if (
          options?.purpose === 'title' ||
          options?.purpose === 'session-title' ||
          options?.purpose === 'acquisition' ||
          allMsgText.toLowerCase().includes('session title') ||
          allMsgText.toLowerCase().includes('memory extraction') ||
          sysText.toLowerCase().includes('session title') ||
          sysText.toLowerCase().includes('memory extraction')
        ) {
          return next()
        }

        return (async function* () {
          const claim = await claimLlmRequest(evidenceDir, runId)
          let outcomeRecorded = false

          let stream
          try {
            stream = next()
          } catch (err) {
            await recordLlmOutcome(evidenceDir, claim.seq, 'provider_error')
            outcomeRecorded = true
            await flushSessionEvidence()
            throw err
          }

          try {
            for await (const chunk of stream) {
              if (chunk && chunk.type === 'finish' && chunk.reason) {
                const kind = chunk.reason.kind
                if (kind === 'error') {
                  if (!outcomeRecorded) {
                    await recordLlmOutcome(evidenceDir, claim.seq, 'provider_error')
                    outcomeRecorded = true
                  }
                } else if (kind === 'aborted') {
                  if (!outcomeRecorded) {
                    await recordLlmOutcome(evidenceDir, claim.seq, 'aborted')
                    outcomeRecorded = true
                  }
                }
              }
              yield chunk
            }

            if (!outcomeRecorded) {
              await recordLlmOutcome(evidenceDir, claim.seq, 'completed')
              outcomeRecorded = true
            }
            await flushSessionEvidence()
          } catch (err) {
            if (!outcomeRecorded) {
              await recordLlmOutcome(evidenceDir, claim.seq, 'provider_error')
              outcomeRecorded = true
            }
            await flushSessionEvidence()
            throw err
          }
        })()
      },
      true
    )

    ctx.on('turn/end', (turn, session) => flushSessionEvidence(session))
    ctx.on('session/disposed', (session) => flushSessionEvidence(session))
    ctx.on('dispose', () => flushSessionEvidence())
  }
}
