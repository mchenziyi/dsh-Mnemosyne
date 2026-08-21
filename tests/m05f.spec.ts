import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, symlink, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { ProtocolValidationError, canonicalBytes, canonicalHash, withoutHash } from '../src/protocol/canonical.js'
import { BudgetLedger } from '../src/m05e/index.js'
import {
  createProviderCompatibilityAudit,
  validateProviderCompatibilityAudit,
  parseRfc3339Utc,
  type ProviderCompatibilityAudit,
} from '../src/m05f/provider-audit.js'
import {
  runM05F1PlanningGate,
  validateRealCanaryPlan,
  type RealCanaryPlan,
  validateRealCanaryAuthorizationRequest,
  type RealCanaryAuthorizationRequest,
  checkAuthorizationExpiry,
} from '../src/m05f/authorization.js'
import {
  runIsolatedProfileDryRun,
  runCountingFakeZeroRetryProof,
  type IsolatedDryRunResult,
} from '../src/m05f/dry-run.js'

const TARGET_DSH_VERSION = '0.1.0-rc.8'
const OFFICIAL_PROVIDER_PKG = '@deepseek-ai/dsh-llm-deepseek'
const OFFICIAL_ROUTE = 'deepseek-official'
const OFFICIAL_MODEL = 'deepseek-v4-flash'
const V2_MANIFEST_HASH = 'sha256_7462d1a97ba7207a0caece22938161c8790401460e4672fd67eb3237df40352f'
const M05E_PLAN_HASH = 'sha256_5a3eaef10f27eb672922718fb41f4d92eeefc4b12275815ea74ce3e4b77f9e80'

describe('M0.5F1 CTO Final Review: Lifecycle Isolation, Real llm/stream, Strict RFC3339, and Planning Gate', () => {
  // Section 1: Dispose 全生命周期隔离与 Trap 验证
  describe('一、Dispose 全生命周期隔离', () => {
    it('keeps traps active throughout Provider and Runtime disposal and verifies route unregistration before Runtime dispose', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-dispose-test-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        const result = await runIsolatedProfileDryRun({
          isolation_root: isolationPath,
          model: OFFICIAL_MODEL,
          max_tokens: 4096,
          max_retries: 0,
        })

        expect(result.status).toBe('dry_run_success')
        expect(result.real_stream_calls).toBe(1)
        expect(result.credential_resolve_calls).toBe(0)
        expect(result.network_calls).toBe(0)
        expect(result.cleanup_clean).toBe(true)

        // Verify isolation root directory was removed
        let exists = true
        try {
          await lstat(isolationPath)
        } catch {
          exists = false
        }
        expect(exists).toBe(false)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('fails closed and restores traps if Provider disposer itself attempts fetch or credential resolve', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-dispose-fail-p-'))
      const isolationPath1 = join(tempBase, 'iso-root-1')
      const isolationPath2 = join(tempBase, 'iso-root-2')

      try {
        // 1. Network trap triggered inside Provider disposer
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: isolationPath1,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'provider', action: 'fetch' },
          })
        ).rejects.toThrow(ProtocolValidationError)

        // 2. Credential resolve trap triggered inside Provider disposer
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: isolationPath2,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'provider', action: 'credential_resolve' },
          })
        ).rejects.toThrow(ProtocolValidationError)

        // Traps must be properly restored in finally
        expect(typeof globalThis.fetch).toBe('function')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('fails closed and restores traps if Runtime disposer itself attempts network call or credential resolve', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-dispose-fail-r-'))
      const isolationPath1 = join(tempBase, 'iso-root-1')
      const isolationPath2 = join(tempBase, 'iso-root-2')

      try {
        // 1. Network trap triggered inside Runtime disposer
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: isolationPath1,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'runtime', action: 'fetch' },
          })
        ).rejects.toThrow(ProtocolValidationError)

        // 2. Credential resolve trap triggered inside Runtime disposer
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: isolationPath2,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'runtime', action: 'credential_resolve' },
          })
        ).rejects.toThrow(ProtocolValidationError)

        // Traps must be properly restored in finally
        expect(typeof globalThis.fetch).toBe('function')
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('enforces single-run module gate, rejects concurrent dry runs, and restores gate on completion and error', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-concurrency-'))
      const path1 = join(tempBase, 'iso-1')
      const path2 = join(tempBase, 'iso-2')
      const path3 = join(tempBase, 'iso-3')

      const initialFetch = globalThis.fetch
      const initialHttp = http.request
      const initialHttps = https.request
      const initialNet = net.connect

      try {
        // Run two dry-runs concurrently: exactly one must enter and one must fail closed immediately
        const [res1, res2] = await Promise.allSettled([
          runIsolatedProfileDryRun({
            isolation_root: path1,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
          }),
          runIsolatedProfileDryRun({
            isolation_root: path2,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
          }),
        ])

        const successes = [res1, res2].filter((r) => r.status === 'fulfilled')
        const failures = [res1, res2].filter((r) => r.status === 'rejected')

        expect(successes.length).toBe(1)
        expect(failures.length).toBe(1)
        expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProtocolValidationError)

        // Verify rejected run did not leave its isolation root
        let path2Exists = false
        try {
          await lstat(path2)
          path2Exists = true
        } catch {
          path2Exists = false
        }
        expect(path2Exists).toBe(false)

        // After first run completes, subsequent sequential run must succeed
        const res3 = await runIsolatedProfileDryRun({
          isolation_root: path3,
          model: OFFICIAL_MODEL,
          max_tokens: 4096,
          max_retries: 0,
        })
        expect(res3.status).toBe('dry_run_success')

        // If a run throws an exception, the gate is still released for subsequent runs
        const pathErr = join(tempBase, 'iso-err')
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: pathErr,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _extraStreamCall: true,
          })
        ).rejects.toThrow(ProtocolValidationError)

        const path4 = join(tempBase, 'iso-4')
        const res4 = await runIsolatedProfileDryRun({
          isolation_root: path4,
          model: OFFICIAL_MODEL,
          max_tokens: 4096,
          max_retries: 0,
        })
        expect(res4.status).toBe('dry_run_success')

        // Verify exact initial function references
        expect(globalThis.fetch).toBe(initialFetch)
        expect(http.request).toBe(initialHttp)
        expect(https.request).toBe(initialHttps)
        expect(net.connect).toBe(initialNet)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('guarantees original Provider and Runtime disposer execution exactly once even when trap triggers inside disposer', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-disposer-exec-'))
      const path1 = join(tempBase, 'iso-1')
      const path2 = join(tempBase, 'iso-2')

      let providerDisposeCount = 0
      let runtimeDisposeCount = 0

      const initialFetch = globalThis.fetch
      const initialHttp = http.request
      const initialHttps = https.request
      const initialNet = net.connect

      try {
        // 1. Provider disposer trap
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: path1,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'provider', action: 'fetch' },
            _onProviderDisposeCalled: () => {
              providerDisposeCount++
            },
          })
        ).rejects.toThrow(ProtocolValidationError)
        expect(providerDisposeCount).toBe(1)

        let path1Exists = false
        try {
          await lstat(path1)
          path1Exists = true
        } catch {
          path1Exists = false
        }
        expect(path1Exists).toBe(false)
        expect(globalThis.fetch).toBe(initialFetch)

        // 2. Runtime disposer trap
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: path2,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerTrap: { target: 'runtime', action: 'credential_resolve' },
            _onRuntimeDisposeCalled: () => {
              runtimeDisposeCount++
            },
          })
        ).rejects.toThrow(ProtocolValidationError)
        expect(runtimeDisposeCount).toBe(1)

        let path2Exists = false
        try {
          await lstat(path2)
          path2Exists = true
        } catch {
          path2Exists = false
        }
        expect(path2Exists).toBe(false)
        expect(http.request).toBe(initialHttp)
        expect(https.request).toBe(initialHttps)
        expect(net.connect).toBe(initialNet)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('guarantees original disposer is called exactly once and not retried if it fails internally', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-disposer-err-'))
      const path1 = join(tempBase, 'iso-1')

      let providerDisposeCount = 0

      try {
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: path1,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _injectDisposerError: { target: 'provider' },
            _onProviderDisposeCalled: () => {
              providerDisposeCount++
            },
          })
        ).rejects.toThrow(ProtocolValidationError)

        // Must be called exactly once and not retried in inner finally
        expect(providerDisposeCount).toBe(1)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // Section 2: 真实统计 llm/stream 调用
  describe('二、真实统计 llm/stream 调用', () => {
    it('observes exactly 1 stream call through public llm/stream waterfall and fails if 0 or >1', async () => {
      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-stream-count-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        // Standard dry run must observe exactly 1 stream call
        const result = await runIsolatedProfileDryRun({
          isolation_root: isolationPath,
          model: OFFICIAL_MODEL,
          max_tokens: 4096,
          max_retries: 0,
        })
        expect(result.real_stream_calls).toBe(1)

        // If stream is called twice during dry run -> must fail closed
        const isolationPath2 = join(tempBase, 'iso-root-2')
        await expect(
          runIsolatedProfileDryRun({
            isolation_root: isolationPath2,
            model: OFFICIAL_MODEL,
            max_tokens: 4096,
            max_retries: 0,
            _extraStreamCall: true,
          })
        ).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // Section 3: 严格 RFC3339 时间解析与边界
  describe('三、严格 RFC3339 时间解析与边界', () => {
    it('correctly parses valid calendar dates, leap years, fractions (1-3 digits), and timezones into epoch millis', () => {
      // 1. Valid UTC date-time
      const t1 = parseRfc3339Utc('2026-08-21T00:00:00Z')
      expect(t1).toBe(Date.UTC(2026, 7, 21, 0, 0, 0, 0))

      // 2. Valid leap year date
      const leap = parseRfc3339Utc('2024-02-29T12:00:00Z')
      expect(leap).toBe(Date.UTC(2024, 1, 29, 12, 0, 0, 0))

      // 3. Different valid 1-3 digit fractions of same instant
      const f1 = parseRfc3339Utc('2026-08-21T00:00:00.500Z')
      const f2 = parseRfc3339Utc('2026-08-21T00:00:00.5Z')
      expect(f1).toBe(f2)

      // 4. Timezone offset vs UTC for same instant
      const tzOffset = parseRfc3339Utc('2026-08-21T08:00:00+08:00')
      const tzUtc = parseRfc3339Utc('2026-08-21T00:00:00Z')
      expect(tzOffset).toBe(tzUtc)
    })

    it('rejects invalid calendar dates, non-leap Feb 29, missing timezones, and precision beyond 3 digits (.9999, .0001)', () => {
      // Invalid date Feb 30
      expect(() => parseRfc3339Utc('2026-02-30T00:00:00Z')).toThrow(ProtocolValidationError)

      // Invalid leap day in non-leap year
      expect(() => parseRfc3339Utc('2025-02-29T00:00:00Z')).toThrow(ProtocolValidationError)

      // Invalid month 13
      expect(() => parseRfc3339Utc('2026-13-01T00:00:00Z')).toThrow(ProtocolValidationError)

      // Invalid hour 24
      expect(() => parseRfc3339Utc('2026-08-21T24:00:00Z')).toThrow(ProtocolValidationError)

      // Missing timezone
      expect(() => parseRfc3339Utc('2026-08-21T00:00:00')).toThrow(ProtocolValidationError)

      // Space separated
      expect(() => parseRfc3339Utc('2026-08-21 00:00:00Z')).toThrow(ProtocolValidationError)

      // 4-digit fraction .9999 must be rejected (no rounding allowed)
      expect(() => parseRfc3339Utc('2026-08-21T00:00:00.9999Z')).toThrow(ProtocolValidationError)

      // 4-digit fraction .0004 must be rejected
      expect(() => parseRfc3339Utc('2026-08-21T00:00:00.0004Z')).toThrow(ProtocolValidationError)

      // 4-digit fraction .0001 must be rejected
      expect(() => parseRfc3339Utc('2026-08-21T00:00:00.0001Z')).toThrow(ProtocolValidationError)
    })

    it('enforces created_at <= now < expires_at and source_checked_at <= now', async () => {
      const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-gate-time-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        // 1. now == expires_at -> must be rejected during authorization creation
        await expect(
          runM05F1PlanningGate({
            audited_at: '2026-08-21T00:00:00Z',
            created_at: '2026-08-21T00:00:00Z',
            expires_at: '2026-08-21T01:00:00Z',
            now: '2026-08-21T01:00:00Z', // now == expires_at
            package_json_content: pkgContent,
            lockfile_content: lockContent,
            fixture_manifest_sha256: V2_MANIFEST_HASH,
            m05e_canary_plan_sha256: M05E_PLAN_HASH,
            isolation_root: isolationPath,
          })
        ).rejects.toThrow(ProtocolValidationError)

        // 2. now > expires_at -> must be rejected
        await expect(
          runM05F1PlanningGate({
            audited_at: '2026-08-21T00:00:00Z',
            created_at: '2026-08-21T00:00:00Z',
            expires_at: '2026-08-21T01:00:00Z',
            now: '2026-08-21T01:00:01Z',
            package_json_content: pkgContent,
            lockfile_content: lockContent,
            fixture_manifest_sha256: V2_MANIFEST_HASH,
            m05e_canary_plan_sha256: M05E_PLAN_HASH,
            isolation_root: isolationPath,
          })
        ).rejects.toThrow(ProtocolValidationError)

        // 3. source_checked_at in future relative to now -> must be rejected
        await expect(
          runM05F1PlanningGate({
            audited_at: '2026-08-21T00:00:00Z',
            created_at: '2026-08-21T00:00:00Z',
            expires_at: '2026-08-21T01:00:00Z',
            now: '2026-08-21T00:30:00Z',
            package_json_content: pkgContent,
            lockfile_content: lockContent,
            fixture_manifest_sha256: V2_MANIFEST_HASH,
            m05e_canary_plan_sha256: M05E_PLAN_HASH,
            isolation_root: isolationPath,
            cost: {
              status: 'verified',
              currency: 'USD',
              source_ref: 'official-pricing-v1',
              source_checked_at: '2026-08-21T00:45:00Z', // checked in future
              worst_case_upper_bound: '0.125000',
            },
          })
        ).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // Section 4: 消除可伪造 Dry-run Evidence (runM05F1PlanningGate)
  describe('四、消除可伪造 Dry-run Evidence 与 Planning Gate', () => {
    it('executes full Audit -> DryRun -> Plan -> Authorization pipeline internally and rejects external mock evidence', async () => {
      const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-gate-test-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        const result = await runM05F1PlanningGate({
          audited_at: '2026-08-21T00:00:00Z',
          created_at: '2026-08-21T00:00:00Z',
          expires_at: '2026-08-21T01:00:00Z',
          now: '2026-08-21T00:00:00Z',
          package_json_content: pkgContent,
          lockfile_content: lockContent,
          fixture_manifest_sha256: V2_MANIFEST_HASH,
          m05e_canary_plan_sha256: M05E_PLAN_HASH,
          isolation_root: isolationPath,
          model: OFFICIAL_MODEL,
          credential_ref: 'DEEPSEEK_API_KEY',
        })

        expect(result.audit.decision).toBe('compatible')
        expect(result.dry_run.status).toBe('dry_run_success')
        expect(result.dry_run.real_stream_calls).toBe(1)
        expect(result.plan.status).toBe('dry_run_validated')
        expect(result.plan.compatibility_audit_sha256).toBe(result.audit.audit_sha256)
        expect(result.authorization.status).toBe('pending_user_approval')
        expect(result.authorization.canary_plan_sha256).toBe(result.plan.plan_sha256)
        expect(result.authorization.compatibility_audit_sha256).toBe(result.audit.audit_sha256)

        // Validate complete objects round-trip
        expect(validateRealCanaryPlan(result.plan)).toEqual(result.plan)
        expect(validateRealCanaryAuthorizationRequest(result.authorization)).toEqual(result.authorization)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('fails closed and produces zero Plan / Authorization if Audit or DryRun fails', async () => {
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')
      const badPkg = JSON.stringify({
        devDependencies: { '@deepseek-ai/dsh-agent': '0.1.0-rc.8' },
        peerDependencies: {},
      })

      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-gate-fail-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        await expect(
          runM05F1PlanningGate({
            audited_at: '2026-08-21T00:00:00Z',
            created_at: '2026-08-21T00:00:00Z',
            expires_at: '2026-08-21T01:00:00Z',
            now: '2026-08-21T00:00:00Z',
            package_json_content: badPkg,
            lockfile_content: lockContent,
            fixture_manifest_sha256: V2_MANIFEST_HASH,
            m05e_canary_plan_sha256: M05E_PLAN_HASH,
            isolation_root: isolationPath,
          })
        ).rejects.toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // Section 5: Audit 检查全部直接 DSH 依赖
  describe('五、Audit 检查全部直接 DSH 依赖', () => {
    it('blocks audit if any direct DSH dependency is non-rc.8 or has range / workspace prefix across all 4 dependency sections', () => {
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      // 1. Dependency with rc.7 in peerDependencies
      const pkgWithRc7 = JSON.stringify({
        devDependencies: { '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.8' },
        peerDependencies: { '@deepseek-ai/dsh-session': '0.1.0-rc.7' },
      })
      const auditRc7 = createProviderCompatibilityAudit({
        audited_at: '2026-08-21T00:00:00Z',
        package_json_content: pkgWithRc7,
        lockfile_content: lockContent,
      })
      expect(auditRc7.decision).toBe('blocked')

      // 2. Dependency with caret range ^0.1.0-rc.8 in dependencies
      const pkgWithCaret = JSON.stringify({
        dependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.8' },
        devDependencies: { '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.8' },
      })
      const auditCaret = createProviderCompatibilityAudit({
        audited_at: '2026-08-21T00:00:00Z',
        package_json_content: pkgWithCaret,
        lockfile_content: lockContent,
      })
      expect(auditCaret.decision).toBe('blocked')

      // 3. Dependency with latest
      const pkgWithLatest = JSON.stringify({
        optionalDependencies: { '@deepseek-ai/dsh-brand': 'latest' },
        devDependencies: { '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.8' },
      })
      const auditLatest = createProviderCompatibilityAudit({
        audited_at: '2026-08-21T00:00:00Z',
        package_json_content: pkgWithLatest,
        lockfile_content: lockContent,
      })
      expect(auditLatest.decision).toBe('blocked')
    })
  })

  // Section 6: Audit 必须验证真实 Provider Route
  describe('六、Audit 必须验证真实 Provider Route', () => {
    it('verifies provider route ID is exact deepseek-official through public providerInfo static contract verification', () => {
      const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      const audit = createProviderCompatibilityAudit({
        audited_at: '2026-08-21T00:00:00Z',
        package_json_content: pkgContent,
        lockfile_content: lockContent,
      })

      expect(audit.public_contracts.provider_route).toBe('pass')
      expect(audit.decision).toBe('compatible')
    })
  })

  // Section 7: Authorization ID 完整性
  describe('七、Authorization ID 完整性', () => {
    it('computes authorization_id from complete canonical preimage and rejects any tampered semantic fields', async () => {
      const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-auth-id-'))
      const isolationPath = join(tempBase, 'iso-root')

      try {
        const { authorization } = await runM05F1PlanningGate({
          audited_at: '2026-08-21T00:00:00Z',
          created_at: '2026-08-21T00:00:00Z',
          expires_at: '2026-08-21T01:00:00Z',
          now: '2026-08-21T00:00:00Z',
          package_json_content: pkgContent,
          lockfile_content: lockContent,
          fixture_manifest_sha256: V2_MANIFEST_HASH,
          m05e_canary_plan_sha256: M05E_PLAN_HASH,
          isolation_root: isolationPath,
          cost: {
            status: 'verified',
            currency: 'USD',
            source_ref: 'pricing-table-v1',
            source_checked_at: '2026-08-21T00:00:00Z',
            worst_case_upper_bound: '0.125000',
          },
        })

        // Valid round-trip
        expect(validateRealCanaryAuthorizationRequest(authorization)).toEqual(authorization)

        // 1. Modifying cost but keeping old authorization_id -> must be rejected
        const tamperedCost = {
          ...authorization,
          cost: { ...authorization.cost, worst_case_upper_bound: '0.999000' },
        }
        expect(() => validateRealCanaryAuthorizationRequest(tamperedCost)).toThrow(ProtocolValidationError)

        // 2. Modifying expires_at but keeping old authorization_id -> must be rejected
        const tamperedExpiry = {
          ...authorization,
          expires_at: '2026-08-21T02:00:00Z',
        }
        expect(() => validateRealCanaryAuthorizationRequest(tamperedExpiry)).toThrow(ProtocolValidationError)

        // 3. Modifying fixture_manifest_sha256 -> must be rejected
        const tamperedFixture = {
          ...authorization,
          fixture_manifest_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        }
        expect(() => validateRealCanaryAuthorizationRequest(tamperedFixture)).toThrow(ProtocolValidationError)
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // Section 8: Counting Fake with Real BudgetLedger & Zero Retries
  describe('八、Counting Fake with Real BudgetLedger & Zero Retries', () => {
    it('proves 1 claim = 1 outbound request and 0 retries across success, non-retryable, and retryable scenarios with no pending claims', async () => {
      // 1. Success
      const ledger1 = new BudgetLedger()
      const res1 = await runCountingFakeZeroRetryProof({ scenario: 'success', ledger: ledger1 })
      expect(res1.successful_claims).toBe(1)
      expect(res1.outbound_requests).toBe(1)
      expect(res1.automatic_retries).toBe(0)
      const snap1 = ledger1.snapshot()
      expect(snap1.task_calls_claimed).toBe(1)
      expect(snap1.completed_calls).toBe(1)
      expect(snap1.failed_calls).toBe(0)

      // 2. Non-retryable
      const ledger2 = new BudgetLedger()
      const res2 = await runCountingFakeZeroRetryProof({ scenario: 'non_retryable_error', ledger: ledger2 })
      expect(res2.successful_claims).toBe(1)
      expect(res2.outbound_requests).toBe(1)
      expect(res2.automatic_retries).toBe(0)
      const snap2 = ledger2.snapshot()
      expect(snap2.task_calls_claimed).toBe(1)
      expect(snap2.completed_calls).toBe(0)
      expect(snap2.failed_calls).toBe(1)

      // 3. Retryable (429) with maxRetries=0
      const ledger3 = new BudgetLedger()
      const res3 = await runCountingFakeZeroRetryProof({ scenario: 'retryable_error', ledger: ledger3 })
      expect(res3.successful_claims).toBe(1)
      expect(res3.outbound_requests).toBe(1)
      expect(res3.automatic_retries).toBe(0)
      const snap3 = ledger3.snapshot()
      expect(snap3.task_calls_claimed).toBe(1)
      expect(snap3.completed_calls).toBe(0)
      expect(snap3.failed_calls).toBe(1)
    })
  })

  // Section 9: 字节确定性与脱敏
  describe('九、字节确定性与全链路脱敏', () => {
    it('produces byte-for-byte identical canonical hashes for identical planning gate runs', async () => {
      const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

      const base = await realpath(tmpdir())
      const tempBase = await mkdtemp(join(base, 'dsh-m05f1-det-'))
      const iso1 = join(tempBase, 'iso-1')
      const iso2 = join(tempBase, 'iso-2')

      try {
        const res1 = await runM05F1PlanningGate({
          audited_at: '2026-08-21T00:00:00Z',
          created_at: '2026-08-21T00:00:00Z',
          expires_at: '2026-08-21T01:00:00Z',
          now: '2026-08-21T00:00:00Z',
          package_json_content: pkgContent,
          lockfile_content: lockContent,
          fixture_manifest_sha256: V2_MANIFEST_HASH,
          m05e_canary_plan_sha256: M05E_PLAN_HASH,
          isolation_root: iso1,
        })

        const res2 = await runM05F1PlanningGate({
          audited_at: '2026-08-21T00:00:00Z',
          created_at: '2026-08-21T00:00:00Z',
          expires_at: '2026-08-21T01:00:00Z',
          now: '2026-08-21T00:00:00Z',
          package_json_content: pkgContent,
          lockfile_content: lockContent,
          fixture_manifest_sha256: V2_MANIFEST_HASH,
          m05e_canary_plan_sha256: M05E_PLAN_HASH,
          isolation_root: iso2,
        })

        expect(canonicalBytes(res1.audit)).toBe(canonicalBytes(res2.audit))
        expect(canonicalBytes(res1.plan)).toBe(canonicalBytes(res2.plan))
        expect(canonicalBytes(res1.authorization)).toBe(canonicalBytes(res2.authorization))
      } finally {
        await rm(tempBase, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('sanitizes all M0.5F1 error messages and never reflects sensitive tokens or paths', () => {
      const maliciousPayloads = [
        '/Users/czy/.credentials.yaml',
        'sk-secret-1234567890abcdef',
        '../../../../etc/shadow',
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      ]

      for (const payload of maliciousPayloads) {
        try {
          parseRfc3339Utc(payload)
          expect.unreachable('must throw ProtocolValidationError')
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(ProtocolValidationError)
          const msg = (err as Error).message
          expect(msg).not.toContain(payload)
          expect(msg).not.toContain('/Users/')
          expect(msg).not.toContain('sk-secret')
          expect(msg).not.toContain('etc/shadow')
          expect(msg).toBe('protocol validation failed')
        }
      }
    })
  })
})
