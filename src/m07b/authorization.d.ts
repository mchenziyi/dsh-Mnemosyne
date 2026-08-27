import type { RealCanaryPlan, ApprovalReceipt } from './canary-protocol.js'

export declare function verifyApprovalBinding(
  plan: RealCanaryPlan,
  approval: ApprovalReceipt,
  currentTimeIso?: string
): boolean

export interface ApprovalClaimResult {
  readonly status: 'claimed'
  readonly approval_sha256: string
  readonly claimFilePath: string
}

export declare function claimApproval(
  claimDir: string,
  plan: RealCanaryPlan,
  approval: ApprovalReceipt,
  currentTimeIso?: string
): Promise<ApprovalClaimResult>
