import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { ToolCallId, createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { ProtocolValidationError, canonicalBytes, canonicalHash, withoutHash } from '../src/protocol/canonical.js'
import { AUDIT_COMMIT, DSH_VERSION } from '../src/compatibility.js'
import {
  createDshBaselineAudit,
  resolveDirectDshPackages,
  validateDshBaselineAudit,
  type CompatibilityAudit,
  type PublicSeamsAudit,
} from '../src/protocol/dsh-baseline-audit.js'

const TARGET_DSH_VERSION = '0.1.2-alpha.3'

const VALID_PUBLIC_SEAMS: PublicSeamsAudit = {
  cordis_plugin: 'pass',
  agent_loop: 'pass',
  llm_adapter: 'pass',
  session: 'pass',
  tools: 'pass',
  additional_contexts: 'pass',
}

const VALID_COMPATIBILITY: CompatibilityAudit = {
  canonical_goldens_unchanged: true,
  fixture_hashes_unchanged: true,
  receipt_contracts_unchanged: true,
  production_exports_unchanged: true,
  tarball_boundary_unchanged: true,
}

describe('DSH baseline upgrade compatibility suite', () => {
  it('binds compatibility metadata to the audited upstream DSH release', () => {
    expect(DSH_VERSION).toBe(TARGET_DSH_VERSION)
    expect(AUDIT_COMMIT).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
  })

  it('enforces that all direct @deepseek-ai/dsh-* dependencies in package.json are exact 0.1.1-rc.2', () => {
    const pkgJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
    const dshPeers = Object.entries(pkgJson.peerDependencies || {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    const dshDevs = Object.entries(pkgJson.devDependencies || {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

    expect(dshPeers.length).toBe(2)
    expect(dshDevs.length).toBe(24)

    for (const [name, version] of dshPeers) {
      expect(version, `peerDependency ${name} must be exact ${TARGET_DSH_VERSION}`).toBe(TARGET_DSH_VERSION)
    }

    for (const [name, version] of dshDevs) {
      expect(version, `devDependency ${name} must be exact ${TARGET_DSH_VERSION}`).toBe(TARGET_DSH_VERSION)
    }

    // Required DSH packages are explicitly declared as devDependencies
    expect(pkgJson.devDependencies['@deepseek-ai/dsh-session-persistence']).toBe(TARGET_DSH_VERSION)
    expect(pkgJson.devDependencies['@deepseek-ai/dsh-settings']).toBe(TARGET_DSH_VERSION)
    expect(pkgJson.devDependencies['@deepseek-ai/dsh-credentials']).toBe(TARGET_DSH_VERSION)
  })

  it('scans full pnpm-lock.yaml for all DSH snapshots and rejects rc.6, rc.7, rc.8, ranges, and cross-RC mix', () => {
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')
    const matches = [...lockContent.matchAll(/@deepseek-ai\/dsh-([a-z-]+)@([0-9a-z.-]+)/g)]
    expect(matches.length).toBeGreaterThan(0)

    const packageVersions = new Map<string, Set<string>>()
    for (const match of matches) {
      const pkgName = `@deepseek-ai/dsh-${match[1]}`
      const version = match[2]

      if (!packageVersions.has(pkgName)) {
        packageVersions.set(pkgName, new Set())
      }
      packageVersions.get(pkgName)!.add(version)

      // Reject any non-rc.2 version
      expect(version, `Package ${pkgName} snapshot version in lockfile must be ${TARGET_DSH_VERSION}`).toBe(TARGET_DSH_VERSION)
      expect(version).not.toMatch(/0\.1\.0-rc\.[0-8]/)
      expect(version).not.toMatch(/0\.1\.1-rc\.[01]/)
      expect(version).not.toMatch(/[\^~*>=]/)
    }

    // Verify each package has exactly one unique resolved version (no cross-RC mix)
    for (const [pkgName, versions] of packageVersions) {
      expect(versions.size, `Package ${pkgName} must not have multiple resolved versions`).toBe(1)
      expect([...versions][0]).toBe(TARGET_DSH_VERSION)
    }

    // Verify transitive packages are resolved in lockfile
    expect(packageVersions.has('@deepseek-ai/dsh-session-persistence')).toBe(true)
    expect(packageVersions.has('@deepseek-ai/dsh-settings')).toBe(true)
  })

  it('dynamically resolves direct packages from package.json and lockfile and fails on missing or conflict', () => {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

    const resolved = resolveDirectDshPackages(pkgContent, lockContent)
    expect(resolved.length).toBeGreaterThan(0)
    for (const p of resolved) {
      expect(p.declared_version).toBe(TARGET_DSH_VERSION)
      expect(p.resolved_version).toBe(TARGET_DSH_VERSION)
    }

    // Missing package in lockfile fails closed
    const fakeLockMissing = lockContent.replace(/@deepseek-ai\/dsh-agent@[0-9a-z.-]+/g, '')
    expect(() => resolveDirectDshPackages(pkgContent, fakeLockMissing)).toThrow(ProtocolValidationError)

    // Multiple versions in lockfile fails closed
    const fakeLockMulti = lockContent + "\n  '@deepseek-ai/dsh-agent@0.1.0-rc.8':\n    resolution: {}\n"
    expect(() => resolveDirectDshPackages(pkgContent, fakeLockMulti)).toThrow(ProtocolValidationError)

    // Conflicting declared versions in peer and dev fails closed
    const fakePkgConflict = JSON.stringify({
      peerDependencies: { '@deepseek-ai/dsh-session': '0.1.1-rc.2' },
      devDependencies: { '@deepseek-ai/dsh-session': '0.1.0-rc.8' },
    })
    expect(() => resolveDirectDshPackages(fakePkgConflict, lockContent)).toThrow(ProtocolValidationError)
  })

  it('generates deterministic DshBaselineAudit without package injection and validates strict schema and hash', () => {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

    const audit1 = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })

    const audit2 = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })

    // Byte-for-byte determinism
    expect(canonicalBytes(audit1)).toBe(canonicalBytes(audit2))
    expect(audit1.status).toBe('dsh_baseline_ready_for_cto_review')
    expect(audit1.audit_sha256).toBe(canonicalHash(withoutHash(audit1 as unknown as Record<string, unknown>, 'audit_sha256')))

    // Validated by schema
    const validated = validateDshBaselineAudit(audit1)
    expect(validated.status).toBe('dsh_baseline_ready_for_cto_review')

    // Sensitive credential / path leakage assertion
    const auditJson = JSON.stringify(audit1)
    expect(auditJson).not.toMatch(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)/)
    expect(auditJson).not.toMatch(/(?:npm_token|secret|password|api[_-]?key)/i)
  })

  it('fails closed when lockfile is empty or contains only older RC versions and never produces ready', () => {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')

    // 1. Empty lockfile throws
    expect(() =>
      createDshBaselineAudit({
        npm_next_version: TARGET_DSH_VERSION,
        package_json_content: pkgContent,
        lockfile_content: '',
        public_seams: VALID_PUBLIC_SEAMS,
        compatibility: VALID_COMPATIBILITY,
      })
    ).toThrow(ProtocolValidationError)

    // 2. Lockfile with only rc.8 produces status: 'blocked' and never ready
    const rc8Lockfile = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8').replace(/0\.1\.2-alpha\.3/g, '0.1.0-rc.8')
    const auditRc8 = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: rc8Lockfile,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })
    expect(auditRc8.status).toBe('blocked')
    expect(auditRc8.status).not.toBe('dsh_baseline_ready_for_cto_review')
    expect(() => validateDshBaselineAudit(auditRc8)).not.toThrow()
  })

  it('strictly couples status with factual conditions and rejects false-ready and false-blocked rehashes', () => {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

    const readyAudit = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })

    // 1. All pass but artificially set to blocked (even with recomputed hash) MUST throw
    const falseBlocked = { ...readyAudit, status: 'blocked' as const }
    const falseBlockedRehashed = {
      ...falseBlocked,
      audit_sha256: canonicalHash(withoutHash(falseBlocked, 'audit_sha256')),
    }
    expect(() => validateDshBaselineAudit(falseBlockedRehashed)).toThrow(ProtocolValidationError)

    // 2. Seam blocked -> status is blocked and validateDshBaselineAudit accepts it
    const seamBlockedAudit = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: { ...VALID_PUBLIC_SEAMS, cordis_plugin: 'blocked' },
      compatibility: VALID_COMPATIBILITY,
    })
    expect(seamBlockedAudit.status).toBe('blocked')
    expect(() => validateDshBaselineAudit(seamBlockedAudit)).not.toThrow()

    // 3. Compatibility false -> status is blocked and validateDshBaselineAudit accepts it
    const compatFalseAudit = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: { ...VALID_COMPATIBILITY, canonical_goldens_unchanged: false },
    })
    expect(compatFalseAudit.status).toBe('blocked')
    expect(() => validateDshBaselineAudit(compatFalseAudit)).not.toThrow()

    // 4. npm_next_version mismatch -> status is blocked and validateDshBaselineAudit accepts it
    const nextMismatchAudit = createDshBaselineAudit({
      npm_next_version: '0.1.1-rc.3',
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })
    expect(nextMismatchAudit.status).toBe('blocked')
    expect(() => validateDshBaselineAudit(nextMismatchAudit)).not.toThrow()

    // 5. Conditions failing but claiming ready (even with recomputed hash) MUST throw
    const falseReady = { ...seamBlockedAudit, status: 'dsh_baseline_ready_for_cto_review' as const }
    const falseReadyRehashed = {
      ...falseReady,
      audit_sha256: canonicalHash(withoutHash(falseReady, 'audit_sha256')),
    }
    expect(() => validateDshBaselineAudit(falseReadyRehashed)).toThrow(ProtocolValidationError)
  })

  it('rejects unsorted packages, invalid keys, and unbounded fields in DshBaselineAudit', () => {
    const pkgContent = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    const lockContent = readFileSync(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8')

    const audit = createDshBaselineAudit({
      npm_next_version: TARGET_DSH_VERSION,
      package_json_content: pkgContent,
      lockfile_content: lockContent,
      public_seams: VALID_PUBLIC_SEAMS,
      compatibility: VALID_COMPATIBILITY,
    })

    // 1. Unsorted packages throw
    const reversedPackages = [...audit.direct_dsh_packages].reverse()
    const unsortedAudit = {
      ...audit,
      direct_dsh_packages: reversedPackages,
    }
    const unsortedRehashed = {
      ...unsortedAudit,
      audit_sha256: canonicalHash(withoutHash(unsortedAudit, 'audit_sha256')),
    }
    expect(() => validateDshBaselineAudit(unsortedRehashed)).toThrow(ProtocolValidationError)

    // 2. Extra unexpected keys in public_seams throw
    const extraKeyAudit = {
      ...audit,
      public_seams: { ...VALID_PUBLIC_SEAMS, extra_key: 'pass' },
    }
    const extraKeyRehashed = {
      ...extraKeyAudit,
      audit_sha256: canonicalHash(withoutHash(extraKeyAudit as unknown as Record<string, unknown>, 'audit_sha256')),
    }
    expect(() => validateDshBaselineAudit(extraKeyRehashed)).toThrow(ProtocolValidationError)

    // 3. Oversized string lengths throw
    const oversizedPackages = audit.direct_dsh_packages.map((p, i) =>
      i === 0 ? { ...p, declared_version: '0.1.1-rc.2'.repeat(20) } : p
    )
    const oversizedAudit = {
      ...audit,
      direct_dsh_packages: oversizedPackages,
    }
    const oversizedRehashed = {
      ...oversizedAudit,
      status: 'blocked' as const,
      audit_sha256: canonicalHash(withoutHash(oversizedAudit as unknown as Record<string, unknown>, 'audit_sha256')),
    }
    expect(() => validateDshBaselineAudit(oversizedRehashed)).toThrow(ProtocolValidationError)
  })

  it('sanitizes all ProtocolValidationError messages and never echoes paths, tokens, or malicious inputs', () => {
    const maliciousInputs = [
      '/Users/test/private/dsh-credentials.yaml',
      'sk-secret-token-xyz-1234567890',
      '../../../../etc/passwd',
      'Bearer npm_token_abcdef123456',
    ]

    for (const payload of maliciousInputs) {
      // 1. Malicious package.json content
      const badPkg = JSON.stringify({
        peerDependencies: { [`@deepseek-ai/dsh-${payload}`]: '0.1.1-rc.2' },
        devDependencies: {},
      })
      try {
        resolveDirectDshPackages(badPkg, '')
        expect.unreachable('should throw ProtocolValidationError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ProtocolValidationError)
        const msg = (err as Error).message
        expect(msg).not.toContain(payload)
        expect(msg).not.toContain('/Users/')
        expect(msg).not.toContain('sk-secret')
        expect(msg).not.toContain('etc/passwd')
        expect(msg).toBe('protocol validation failed')
      }

      // 2. Malicious status or fields in validateDshBaselineAudit
      try {
        validateDshBaselineAudit({
          schema_version: 1,
          status: payload,
          source_version: '0.1.1-rc.2',
          target_version: '0.1.2-alpha.3',
          npm_next_version: payload,
          package_json_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
          lockfile_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
          direct_dsh_packages: [],
          public_seams: VALID_PUBLIC_SEAMS,
          compatibility: VALID_COMPATIBILITY,
          audit_sha256: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        })
        expect.unreachable('should throw ProtocolValidationError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ProtocolValidationError)
        const msg = (err as Error).message
        expect(msg).not.toContain(payload)
        expect(msg).not.toContain('/Users/')
        expect(msg).not.toContain('sk-secret')
        expect(msg).not.toContain('etc/passwd')
        expect(msg).toBe('protocol validation failed')
      }
    }
  })

  it('loads and validates all public Cordis / Agent Loop / LLM / Session / Tool seams with strict cleanup', async () => {
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    let unregister: (() => void) | undefined

    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(AgentRegistry))
      fibers.push(await ctx.plugin(LlmRuntime))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      fibers.push(await ctx.plugin(SessionProjection))
      fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))

      expect((ctx as Context & { llm: LlmRuntime }).llm).toBeDefined()
      expect((ctx as Context & { tools: ToolRuntime }).tools).toBeDefined()
      expect((ctx as Context & { agentLoop: AgentLoop }).agentLoop).toBeDefined()

      class SmokeAdapter extends LlmAdapter {
        providerInfo(p: string) {
          return { id: p, name: 'smoke-adapter' }
        }
        async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'hello' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }

      unregister = (ctx as Context & { llm: LlmRuntime }).llm.registerAdapter(['smoke-provider'], new SmokeAdapter())
      expect(typeof unregister).toBe('function')

      const agent = (ctx as Context & { agentLoop: AgentLoop }).agentLoop.create(SessionId('smoke-session-1'), { provider: 'smoke-provider', model: 'smoke-model' })
      expect(agent).toBeDefined()
      expect(agent.session).toBeDefined()

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(agent.session.events.some((e: { type: string }) => e.type === 'assistant/message')).toBe(true)
    } finally {
      if (unregister) {
        unregister()
      }
      for (const fiber of fibers) {
        await fiber.dispose()
      }
    }
  })
})
