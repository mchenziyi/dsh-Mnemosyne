import { isAbsolute, normalize } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { canonicalHash, ProtocolValidationError } from './protocol/canonical.js'

export type ScopeSource = 'session_header' | 'explicit_config'

export interface ResolvedScope {
  schema_version: 1
  session_id: string
  project_root: string
  source: ScopeSource
  project_scope_id: string
  session_scope_id: string
}

export type ScopeReason =
  | 'missing_agent'
  | 'agent_session_identity_mismatch'
  | 'missing_project_root'
  | 'invalid_project_root'
  | 'invalid_session_id'
  | 'session_scope_conflict'
  | 'runtime_disposed'

export type ScopeResolution =
  | { status: 'ready'; scope: ResolvedScope }
  | { status: 'unavailable'; reason: ScopeReason }
  | { status: 'conflict'; reason: ScopeReason }

export interface ScopeRuntimeSnapshot {
  activeBindingsCount: number
  conflictedSessionsCount: number
}

export interface ScopeRuntime {
  observeSession(session: Session): ScopeResolution
  resolveExecution(exec?: ToolRunContext): ScopeResolution
  disposeSession(session: Session | string): void
  clear(): void
  snapshot(): ScopeRuntimeSnapshot
}

const MAX_SESSION_ID_LEN = 128
const MAX_PATH_LEN = 4096

export function validateAndNormalizeProjectRoot(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) {
    throw new ProtocolValidationError()
  }
  if (rawPath.includes('\0')) {
    throw new ProtocolValidationError()
  }
  if (!isAbsolute(rawPath)) {
    throw new ProtocolValidationError()
  }

  let normalized = normalize(rawPath)
  // Remove trailing slash unless root '/'
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

export function computeProjectScopeId(normalizedRoot: string): string {
  return canonicalHash({
    schema_version: 1,
    kind: 'project',
    project_root: normalizedRoot,
  })
}

export function computeSessionScopeId(projectScopeId: string, sessionId: string): string {
  return canonicalHash({
    schema_version: 1,
    kind: 'session',
    project_scope_id: projectScopeId,
    session_id: sessionId,
  })
}

export interface CreateScopeRuntimeOptions {
  projectRoot?: string
}

export function createScopeRuntime(options?: CreateScopeRuntimeOptions): ScopeRuntime {
  let normalizedConfigRoot: string | undefined
  if (options?.projectRoot !== undefined) {
    normalizedConfigRoot = validateAndNormalizeProjectRoot(options.projectRoot)
  }

  const bindings = new Map<string, ResolvedScope>()
  const conflictedSessions = new Set<string>()
  let isDisposed = false

  function validateSessionId(id: unknown): string | null {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SESSION_ID_LEN || id.includes('\0')) {
      return null
    }
    return id
  }

  function observeSession(session: Session): ScopeResolution {
    if (isDisposed) {
      return { status: 'unavailable', reason: 'runtime_disposed' }
    }

    if (!session || typeof session !== 'object') {
      return { status: 'unavailable', reason: 'invalid_session_id' }
    }

    const sessionId = validateSessionId(session.id)
    if (!sessionId) {
      return { status: 'unavailable', reason: 'invalid_session_id' }
    }

    if (conflictedSessions.has(sessionId)) {
      return { status: 'conflict', reason: 'session_scope_conflict' }
    }

    let resolvedRoot: string
    let source: ScopeSource

    const headerCwd = session.header?.cwd
    if (headerCwd !== undefined) {
      try {
        resolvedRoot = validateAndNormalizeProjectRoot(headerCwd)
        source = 'session_header'
      } catch {
        return { status: 'unavailable', reason: 'invalid_project_root' }
      }
    } else if (normalizedConfigRoot !== undefined) {
      resolvedRoot = normalizedConfigRoot
      source = 'explicit_config'
    } else {
      return { status: 'unavailable', reason: 'missing_project_root' }
    }

    const existing = bindings.get(sessionId)
    if (existing) {
      if (existing.project_root === resolvedRoot) {
        return { status: 'ready', scope: existing }
      }
      // Session identity drift / conflict with different project root:
      // Retain the original binding, mark session as conflicted
      conflictedSessions.add(sessionId)
      return { status: 'conflict', reason: 'session_scope_conflict' }
    }

    const project_scope_id = computeProjectScopeId(resolvedRoot)
    const session_scope_id = computeSessionScopeId(project_scope_id, sessionId)

    const scope: ResolvedScope = {
      schema_version: 1,
      session_id: sessionId,
      project_root: resolvedRoot,
      source,
      project_scope_id,
      session_scope_id,
    }

    bindings.set(sessionId, scope)
    return { status: 'ready', scope }
  }

  function resolveExecution(exec?: ToolRunContext): ScopeResolution {
    if (isDisposed) {
      return { status: 'unavailable', reason: 'runtime_disposed' }
    }

    if (!exec || !exec.agent) {
      return { status: 'unavailable', reason: 'missing_agent' }
    }

    const agent = exec.agent
    if (!agent.session) {
      return { status: 'unavailable', reason: 'missing_agent' }
    }

    const agentId = String(agent.id)
    const sessionId = String(agent.session.id)
    if (agentId !== sessionId) {
      return { status: 'conflict', reason: 'agent_session_identity_mismatch' }
    }

    return observeSession(agent.session)
  }

  function disposeSession(session: Session | string): void {
    const sid = typeof session === 'string' ? session : session?.id
    if (sid && typeof sid === 'string') {
      bindings.delete(sid)
      conflictedSessions.delete(sid)
    }
  }

  function clear(): void {
    bindings.clear()
    conflictedSessions.clear()
    isDisposed = true
  }

  function snapshot(): ScopeRuntimeSnapshot {
    return {
      activeBindingsCount: bindings.size,
      conflictedSessionsCount: conflictedSessions.size,
    }
  }

  return {
    observeSession,
    resolveExecution,
    disposeSession,
    clear,
    snapshot,
  }
}
