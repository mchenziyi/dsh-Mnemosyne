import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateRealCanaryPlan, validateApprovalReceipt } from './canary-protocol.js'

export function verifyApprovalBinding(plan, approval, currentTimeIso = new Date().toISOString()) {
  const vPlan = validateRealCanaryPlan(plan)
  const vApproval = validateApprovalReceipt(approval)

  if (vApproval.plan_id !== vPlan.plan_id || vApproval.plan_sha256 !== vPlan.plan_sha256) {
    throw new Error('approval_plan_mismatch')
  }

  const now = new Date(currentTimeIso).getTime()
  const approvedAt = new Date(vApproval.approved_at).getTime()
  const approvalExpiresAt = new Date(vApproval.expires_at).getTime()
  const planExpiresAt = new Date(vPlan.expires_at).getTime()

  if (now < approvedAt) {
    throw new Error('approval_not_yet_valid')
  }
  if (now > approvalExpiresAt || now > planExpiresAt) {
    throw new Error('approval_expired')
  }

  return true
}

export async function claimApproval(claimDir, plan, approval, currentTimeIso = new Date().toISOString()) {
  verifyApprovalBinding(plan, approval, currentTimeIso)

  const claimFilePath = join(claimDir, `claim_${approval.approval_sha256}.json`)
  const claimPayload = JSON.stringify(
    {
      schema_version: 1,
      approval_sha256: approval.approval_sha256,
      plan_sha256: plan.plan_sha256,
      claimed_at: currentTimeIso,
      status: 'claimed',
    },
    null,
    2
  )

  try {
    await writeFile(claimFilePath, claimPayload, { flag: 'wx', mode: 0o600 })
    return {
      status: 'claimed',
      approval_sha256: approval.approval_sha256,
      claimFilePath,
    }
  } catch (err) {
    if (err && typeof err === 'object' && (err.code === 'EEXIST' || err.message?.includes('EEXIST'))) {
      throw new Error('already_claimed')
    }
    throw err
  }
}
