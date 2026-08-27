import { inspectFactStoreState, inspectCurrentGeneration } from './state-evidence.js'
import { computeProjectScopeId } from './canary-protocol.js'

export async function predicateRun1_AutomaticCapture(params) {
  const { projectRoot, expectedSessionId, expectedMemoryId, sessionEvidence } = params

  if (
    sessionEvidence &&
    (sessionEvidence.completed_turns ?? 0) < 1 &&
    (!Array.isArray(sessionEvidence.tool_calls) || sessionEvidence.tool_calls.length < 1)
  ) {
    return { pass: false, reason: 'turn_not_completed' }
  }

  const factState = await inspectFactStoreState(projectRoot)
  const targetFact = expectedMemoryId
    ? factState.shortTerm.find((f) => f.memory_id === expectedMemoryId)
    : factState.shortTerm[0]

  if (!targetFact) {
    return { pass: false, reason: 'target_short_term_fact_missing' }
  }
  if (
    expectedSessionId &&
    targetFact.session_scope_id !== expectedSessionId &&
    targetFact.session_id !== expectedSessionId
  ) {
    return { pass: false, reason: 'session_id_mismatch' }
  }

  const genState = await inspectCurrentGeneration(projectRoot)
  if (!genState || !genState.current || !genState.world) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  return { pass: true }
}

export async function predicateRun2_RestartPersistence(params) {
  const { projectRoot, sessionEvidence } = params

  if (!sessionEvidence || !Array.isArray(sessionEvidence.tool_calls)) {
    return { pass: false, reason: 'missing_session_evidence' }
  }

  const callNames = sessionEvidence.tool_calls.map((c) => c.tool_name)
  const requiredTools = ['mnemosyne_status', 'mnemosyne_search']

  // Verify presence
  for (const t of requiredTools) {
    if (!callNames.includes(t)) {
      return { pass: false, reason: `missing_or_out_of_order_tool_${t}` }
    }
  }

  for (const res of sessionEvidence.tool_results) {
    if (res.is_error || (res.status !== 'pass' && res.status !== 'created' && res.status !== 'opened')) {
      return { pass: false, reason: 'tool_result_failed' }
    }
  }

  const genState = await inspectCurrentGeneration(projectRoot)
  if (!genState || !genState.current) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  return { pass: true }
}

export async function predicateRun3_Promotion(params) {
  const { projectRoot, sourceShortMemoryId, sourceMemoryId, promotedLongMemoryId, targetMemoryId, sessionEvidence } = params
  const shortId = sourceShortMemoryId || sourceMemoryId
  const longId = promotedLongMemoryId || targetMemoryId

  if (!sessionEvidence || !Array.isArray(sessionEvidence.tool_calls)) {
    return { pass: false, reason: 'missing_session_evidence' }
  }

  const callNames = sessionEvidence.tool_calls.map((c) => c.tool_name)
  if (!callNames.includes('mnemosyne_promote')) {
    return { pass: false, reason: 'missing_promote_tool_calls' }
  }

  const factState = await inspectFactStoreState(projectRoot)
  const sourceShort = shortId ? factState.shortTerm.find((f) => f.memory_id === shortId) : factState.shortTerm[0]
  if (!sourceShort) {
    return { pass: false, reason: 'source_short_term_fact_deleted' }
  }

  const longFact = longId ? factState.longTerm.find((f) => f.memory_id === longId) : factState.longTerm[0]
  if (!longFact) {
    return { pass: false, reason: 'promoted_long_term_fact_missing' }
  }
  const hasSourceRef =
    Array.isArray(longFact.source_short_term_refs) &&
    longFact.source_short_term_refs.some((ref) => !shortId || ref.memory_id === shortId)
  if (!hasSourceRef) {
    return { pass: false, reason: 'source_short_term_ref_mismatch' }
  }

  const genState = await inspectCurrentGeneration(projectRoot)
  if (!genState || !genState.current) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  return { pass: true }
}

export async function predicateRun4_CrossSessionReading(params) {
  const { projectRoot, sessionEvidence } = params

  if (!sessionEvidence || !Array.isArray(sessionEvidence.tool_calls)) {
    return { pass: false, reason: 'missing_session_evidence' }
  }

  const callNames = sessionEvidence.tool_calls.map((c) => c.tool_name)
  if (!callNames.includes('mnemosyne_search')) {
    return { pass: false, reason: 'missing_search_or_open_calls' }
  }

  const genState = await inspectCurrentGeneration(projectRoot)
  if (!genState || !genState.current) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  return { pass: true }
}

export async function predicateRun5_ForgetAndGrantInvalidation(params) {
  const { projectRoot, targetMemoryId, sessionEvidence } = params

  if (!sessionEvidence || !Array.isArray(sessionEvidence.tool_calls)) {
    return { pass: false, reason: 'missing_session_evidence' }
  }

  const callNames = sessionEvidence.tool_calls.map((c) => c.tool_name)
  if (!callNames.includes('mnemosyne_search') || !callNames.includes('mnemosyne_forget')) {
    return { pass: false, reason: 'missing_search_or_forget_calls' }
  }

  const factState = await inspectFactStoreState(projectRoot)
  const targetLong = targetMemoryId ? factState.longTerm.find((f) => f.memory_id === targetMemoryId) : factState.longTerm[0]
  const forgetFact = factState.forget.find(
    (f) =>
      (f.target && (!targetMemoryId || f.target.memory_id === targetMemoryId || f.target.memory_id === targetLong?.memory_id)) ||
      (!targetMemoryId || f.target_memory_id === targetMemoryId || f.target_memory_id === targetLong?.memory_id)
  )
  if (!forgetFact) {
    return { pass: false, reason: 'forget_fact_missing' }
  }

  // Verify long-term fact was not physically deleted
  if (!targetLong) {
    return { pass: false, reason: 'long_term_fact_physically_deleted' }
  }

  const genState = await inspectCurrentGeneration(projectRoot)
  if (!genState || !genState.current) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  return { pass: true }
}

export async function predicateRun6_ScopeIsolation(params) {
  const { projectRootA, projectRootB, projectARoot, projectBRoot, canaryContentText } = params
  const rootA = projectRootA || projectARoot
  const rootB = projectRootB || projectBRoot

  const scopeA = computeProjectScopeId(rootA)
  const scopeB = computeProjectScopeId(rootB)

  if (scopeA === scopeB) {
    return { pass: false, reason: 'project_scopes_not_isolated' }
  }

  const factStateB = await inspectFactStoreState(rootB)
  if (factStateB.shortTerm.length > 0 || factStateB.longTerm.length > 0 || factStateB.forget.length > 0) {
    return { pass: false, reason: 'project_b_facts_contaminated' }
  }

  const genStateB = await inspectCurrentGeneration(rootB)
  if (genStateB && genStateB.world && genStateB.world.manifest) {
    const manifestStr = JSON.stringify(genStateB.world.manifest)
    if (canaryContentText && manifestStr.includes(canaryContentText)) {
      return { pass: false, reason: 'canary_content_leaked_into_project_b' }
    }
  }

  return { pass: true }
}
