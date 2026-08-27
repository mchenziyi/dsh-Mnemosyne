import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { claimLlmRequest, recordLlmOutcome } from './budget-ledger.js'
import { extractToolEventSummary, writeSessionEvidence } from './session-evidence.js'
import { createSidecarLoadedReceipt, writeSidecarLoadedReceiptSync } from './wiring-receipt.js'
import { computeSha256, FROZEN_CANARY_TASKS } from './canary-protocol.js'

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
  async function flushSessionEvidence(session) {
    try {
      if (ctx.sessionPersistence) {
        const target = session || currentSession
        let targetId = target?.id
        if (!targetId && typeof ctx.sessionPersistence.list === 'function') {
          const sessions = await ctx.sessionPersistence.list()
          if (sessions && sessions.length > 0) {
            targetId = sessions[sessions.length - 1].id
          }
        }

        if (targetId && typeof ctx.sessionPersistence.inspect === 'function') {
          const inspected = await ctx.sessionPersistence.inspect(targetId)
          if (inspected && inspected.events) {
            const summary = extractToolEventSummary(inspected.events)
            summary.session_id = targetId
            await writeSessionEvidence(evidenceDir, runId, summary)
          }
        }
      }
    } catch {
      process.stderr.write('dsh: canary_sidecar_evidence_failed\n')
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      if (session) {
        currentSession = session
      }
      if (event && event.type === 'turn/end') {
        flushSessionEvidence(session)
      }
    })

    ctx.on('agent/created', (payload) => {
      if (payload?.agent?.session) {
        currentSession = payload.agent.session
      }
    })

    ctx.on(
      'llm/stream',
      (options, next) => {
        if (
          options?.purpose === 'title' ||
          options?.purpose === 'session-title' ||
          options?.messages?.[0]?.content?.[0]?.text?.includes('session title') ||
          options?.system?.includes('session title')
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
