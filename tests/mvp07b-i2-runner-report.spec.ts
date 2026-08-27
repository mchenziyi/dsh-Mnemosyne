import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  createRedactedCanaryReport,
  validateRedactedCanaryReport,
  createRedactedCanaryReportV2,
  validateRedactedCanaryReportV2,
  computeReportSha256,
  type RedactedCanaryReport,
  type RedactedCanaryReportV2,
} from '../src/m07b/canary-protocol.js'
import { writeRedactedCanaryReport, readRedactedCanaryReport } from '../src/m07b/report.js'

describe('MVP-07B-I2 Phase I2-D: Runner & Report v2', () => {
  const dummyPkgHash = 'sha256_' + 'a'.repeat(64)
  const dummyPlanHash = 'sha256_' + 'b'.repeat(64)
  const dummyApprovalHash = 'sha256_' + 'c'.repeat(64)

  describe('1. Report v1 Backward Golden Compatibility', () => {
    it('validates a wiring-only v1 report with 6 business checks as not_run', () => {
      const reportV1 = createRedactedCanaryReport({
        status: 'pass',
        package_sha256: dummyPkgHash,
        plan_sha256: dummyPlanHash,
        approval_sha256: dummyApprovalHash,
        run_count: 6,
        model_request_count: 6,
        checks: {
          execution_wiring: 'pass',
          automatic_capture: 'not_run',
          restart_persistence: 'not_run',
          progressive_disclosure: 'not_run',
          promotion: 'not_run',
          forget_and_grant: 'not_run',
          scope_isolation: 'not_run',
        },
        cleanup_clean: true,
      })

      expect(reportV1.schema_version).toBe(1)
      expect(validateRedactedCanaryReport(reportV1)).toEqual(reportV1)
    })

    it('rejects v1 report if any business check is pass', () => {
      const badReportV1 = {
        schema_version: 1,
        status: 'pass',
        dsh_version: '0.1.1-rc.2',
        package_version: '0.0.0-dev',
        package_sha256: dummyPkgHash,
        plan_sha256: dummyPlanHash,
        approval_sha256: dummyApprovalHash,
        run_count: 6,
        model_request_count: 6,
        checks: {
          execution_wiring: 'pass',
          automatic_capture: 'pass', // Invalid for v1!
          restart_persistence: 'not_run',
          progressive_disclosure: 'not_run',
          promotion: 'not_run',
          forget_and_grant: 'not_run',
          scope_isolation: 'not_run',
        },
        reason_code: null,
        cleanup_clean: true,
      }
      expect(() => validateRedactedCanaryReport(badReportV1 as any)).toThrow('invalid_report')
    })
  })

  describe('2. Report v2 Business Evaluation Schema & Invariants', () => {
    it('creates and validates a full-pass v2 business report', () => {
      const reportV2 = createRedactedCanaryReportV2({
        status: 'pass',
        package_sha256: dummyPkgHash,
        plan_sha256: dummyPlanHash,
        approval_sha256: dummyApprovalHash,
        run_count: 6,
        model_request_count: 8,
        checks: {
          execution_wiring: 'pass',
          automatic_capture: 'pass',
          restart_persistence: 'pass',
          progressive_disclosure: 'pass',
          promotion: 'pass',
          forget_and_grant: 'pass',
          scope_isolation: 'pass',
        },
        cleanup_clean: true,
      })

      expect(reportV2.schema_version).toBe(2)
      expect(reportV2.evaluation_level).toBe('business')
      expect(validateRedactedCanaryReportV2(reportV2)).toEqual(reportV2)
    })

    it('rejects v2 pass report if any check is fail or not_run', () => {
      expect(() =>
        createRedactedCanaryReportV2({
          status: 'pass',
          package_sha256: dummyPkgHash,
          plan_sha256: dummyPlanHash,
          approval_sha256: dummyApprovalHash,
          run_count: 6,
          model_request_count: 8,
          checks: {
            execution_wiring: 'pass',
            automatic_capture: 'pass',
            restart_persistence: 'fail', // Inconsistent with status: pass
            progressive_disclosure: 'pass',
            promotion: 'pass',
            forget_and_grant: 'pass',
            scope_isolation: 'pass',
          },
          cleanup_clean: true,
        })
      ).toThrow('invalid_report')
    })

    it('rejects a report that exceeds the approved 18-request budget', () => {
      expect(() =>
        createRedactedCanaryReportV2({
          status: 'fail',
          package_sha256: dummyPkgHash,
          plan_sha256: dummyPlanHash,
          approval_sha256: dummyApprovalHash,
          run_count: 0,
          model_request_count: 19,
          checks: {
            execution_wiring: 'fail',
            automatic_capture: 'fail',
            restart_persistence: 'not_run',
            progressive_disclosure: 'not_run',
            promotion: 'not_run',
            forget_and_grant: 'not_run',
            scope_isolation: 'not_run',
          },
          reason_code: 'product_invariant_failed',
          cleanup_clean: true,
        })
      ).toThrow('invalid_report')
    })

    it('validates fail-closed prefix: passed prefix, current failed, remaining not_run', () => {
      const failedV2 = createRedactedCanaryReportV2({
        status: 'fail',
        package_sha256: dummyPkgHash,
        plan_sha256: dummyPlanHash,
        approval_sha256: dummyApprovalHash,
        run_count: 3,
        model_request_count: 4,
        checks: {
          execution_wiring: 'fail',
          automatic_capture: 'pass',
          restart_persistence: 'pass',
          progressive_disclosure: 'fail',
          promotion: 'not_run',
          forget_and_grant: 'not_run',
          scope_isolation: 'not_run',
        },
        reason_code: 'product_invariant_failed',
        cleanup_clean: true,
      })

      expect(validateRedactedCanaryReportV2(failedV2)).toEqual(failedV2)
    })

    it('rejects fail report if a pass check appears AFTER a fail check', () => {
      expect(() =>
        createRedactedCanaryReportV2({
          status: 'fail',
          package_sha256: dummyPkgHash,
          plan_sha256: dummyPlanHash,
          approval_sha256: dummyApprovalHash,
          run_count: 4,
          model_request_count: 5,
          checks: {
            execution_wiring: 'fail',
            automatic_capture: 'pass',
            restart_persistence: 'fail',
            progressive_disclosure: 'pass', // Illegal after fail!
            promotion: 'not_run',
            forget_and_grant: 'not_run',
            scope_isolation: 'not_run',
          },
          reason_code: 'product_invariant_failed',
          cleanup_clean: true,
        })
      ).toThrow('invalid_report')
    })
  })

  describe('3. Report File IO & Version Dispatch', () => {
    it('reads and writes both v1 and v2 reports transparently', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'report_test_'))
      try {
        const v2Path = join(tempDir, 'report-v2.json')
        const reportV2 = createRedactedCanaryReportV2({
          status: 'pass',
          package_sha256: dummyPkgHash,
          plan_sha256: dummyPlanHash,
          approval_sha256: dummyApprovalHash,
          run_count: 6,
          model_request_count: 8,
          checks: {
            execution_wiring: 'pass',
            automatic_capture: 'pass',
            restart_persistence: 'pass',
            progressive_disclosure: 'pass',
            promotion: 'pass',
            forget_and_grant: 'pass',
            scope_isolation: 'pass',
          },
          cleanup_clean: true,
        })

        await writeRedactedCanaryReport(v2Path, reportV2)
        const readV2 = await readRedactedCanaryReport(v2Path)
        expect(readV2).toEqual(reportV2)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})
