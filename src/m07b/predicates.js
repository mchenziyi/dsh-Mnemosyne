import { computeProjectScopeId, computeSha256 } from './canary-protocol.js'
import {
  inspectFactStoreState,
  inspectCurrentGeneration,
  captureRunStateSnapshot,
  computeFactDiff,
} from './state-evidence.js'
import { validateSearchOpenBinding, validateStrictSessionEvidence } from './business-evidence.js'

function requireStrictSessionEvidence(evidence) {
  try {
    return validateStrictSessionEvidence(evidence)
  } catch {
    return null
  }
}

export async function predicateRun1_AutomaticCapture(params) {
  const {
    snapshotBefore,
    snapshotAfter,
    sessionEvidence,
    expectedSessionId,
    expectedSessionIdHash,
    projectRoot,
  } = params

  let before = snapshotBefore
  let after = snapshotAfter
  const strictEvidence = requireStrictSessionEvidence(sessionEvidence)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }

  const targetSessionHash = expectedSessionIdHash || (expectedSessionId ? computeSha256(expectedSessionId) : null)

  if (!after && projectRoot) {
    after = await captureRunStateSnapshot({
      runId: 'run_1',
      projectRoot,
      sessionId: expectedSessionId || 'canary_session_1',
    })
  }

  if (!after) {
    return { pass: false, reason: 'state_snapshot_missing' }
  }

  if (strictEvidence) {
    if (strictEvidence.completed_turns < 1) {
      return { pass: false, reason: 'turn_not_completed' }
    }

    if (Array.isArray(strictEvidence.tool_executions)) {
      const hasRemember = strictEvidence.tool_executions.some((t) => t.tool_name === 'mnemosyne_remember')
      if (hasRemember) {
        return { pass: false, reason: 'manual_remember_forbidden_in_automatic_capture' }
      }
    }
  }

  if (!after) {
    return { pass: false, reason: 'state_snapshot_missing' }
  }

  if (before) {
    const diff = computeFactDiff(before, after)
    if (diff.added_short_term.length !== 1) {
      return { pass: false, reason: 'expected_exactly_one_short_term_fact_added' }
    }
  } else if (after.short_term_refs.length < 1) {
    return { pass: false, reason: 'target_short_term_fact_missing' }
  }

  const targetFact = after.short_term_refs[after.short_term_refs.length - 1]
  if (!targetFact) {
    return { pass: false, reason: 'target_short_term_fact_missing' }
  }

  if (expectedSessionId || expectedSessionIdHash) {
    const isMatch =
      targetFact.session_scope_id === expectedSessionId ||
      targetFact.session_scope_id === expectedSessionIdHash ||
      targetFact.session_scope_id === targetSessionHash ||
      strictEvidence.session_id_sha256 === expectedSessionIdHash ||
      strictEvidence.session_id_sha256 === targetSessionHash
    if (!isMatch) {
      return { pass: false, reason: 'session_id_mismatch' }
    }
  }

  if (params.expectedMemoryId && targetFact.memory_id !== params.expectedMemoryId) {
    return { pass: false, reason: 'memory_id_mismatch' }
  }

  if (!after.current_ref) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  const inIndex = (after.index_memory_refs || []).some((r) => r.memory_id === targetFact.memory_id)
  if (!inIndex) {
    return { pass: false, reason: 'target_fact_missing_from_generation_index' }
  }

  return { pass: true, memory_ref: targetFact, target_short_term_ref: targetFact }
}

export async function predicateRun2_RestartPersistence(params) {
  const {
    snapshotAfter,
    sessionEvidence,
    sourceShortMemoryId,
    targetMemoryId,
    resumeReceipt,
  } = params

  if (resumeReceipt) {
    if (!resumeReceipt.same_session || resumeReceipt.resumed_session_id_sha256 !== resumeReceipt.run_1_session_id_sha256) {
      return { pass: false, reason: 'resume_receipt_session_mismatch' }
    }
  }

  const strictEvidence = requireStrictSessionEvidence(sessionEvidence)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }

  const toolExecs = strictEvidence.tool_executions

  // Check strict sequence if v2 tool_executions available
  if (toolExecs.length > 0) {
    const statusExec = toolExecs.find((e) => e.tool_name === 'mnemosyne_status')
    const listExec = toolExecs.find((e) => e.tool_name === 'mnemosyne_list')
    const searchExec = toolExecs.find((e) => e.tool_name === 'mnemosyne_search')
    const openExec = toolExecs.find((e) => e.tool_name === 'mnemosyne_open')

    if (!statusExec || !listExec || !searchExec || !openExec) {
      return { pass: false, reason: 'required_tool_sequence_missing_or_out_of_order' }
    }

    if (!(statusExec.ordinal < listExec.ordinal && listExec.ordinal < searchExec.ordinal && searchExec.ordinal < openExec.ordinal)) {
      return { pass: false, reason: 'required_tool_sequence_missing_or_out_of_order' }
    }

    // Verify search
    if (searchExec.result_binding.contains_body !== false) {
      return { pass: false, reason: 'search_disclosure_contained_body' }
    }

    const targetShortId = sourceShortMemoryId || params.targetMemoryId
    if (!targetShortId) {
      return { pass: false, reason: 'missing_target_short_memory_id' }
    }

    const foundInSearch = (searchExec.result_binding.memory_refs || []).some((r) => r.memory_id === targetShortId)
    if (!foundInSearch) {
      return { pass: false, reason: 'target_memory_not_found_in_search' }
    }

    // Verify search/open binding
    try {
      validateSearchOpenBinding(searchExec, openExec)
    } catch {
      return { pass: false, reason: 'search_open_binding_invalid' }
    }

    if (openExec.argument_binding.memory_id !== targetShortId) {
      return { pass: false, reason: 'open_target_memory_mismatch' }
    }

    if (openExec.result_binding.body_present !== true || !openExec.result_binding.body_sha256) {
      return { pass: false, reason: 'open_body_missing' }
    }

    return {
      pass: true,
      open_grant: {
        retrieval_id: openExec.argument_binding.retrieval_id,
        search_disclosure_sha256: openExec.argument_binding.search_disclosure_sha256,
        disclosure_sha256: openExec.argument_binding.search_disclosure_sha256,
        body_sha256: openExec.result_binding.body_sha256,
      },
      open_body_sha256: openExec.result_binding.body_sha256,
    }
  }
  return { pass: false, reason: 'required_tool_sequence_missing_or_out_of_order' }
}

export async function predicateRun3_Promotion(params) {
  const {
    snapshotBefore,
    snapshotAfter,
    sessionEvidence,
    sourceShortMemoryId,
    sourceMemoryId,
    promotedLongMemoryId,
    targetMemoryId,
    resumeReceipt,
  } = params

  const shortId = sourceShortMemoryId || sourceMemoryId
  const longId = promotedLongMemoryId || targetMemoryId
  const strictEvidence = requireStrictSessionEvidence(sessionEvidence)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }

  if (resumeReceipt) {
    if (!resumeReceipt.same_session || resumeReceipt.resumed_session_id_sha256 !== resumeReceipt.run_1_session_id_sha256) {
      return { pass: false, reason: 'resume_receipt_session_mismatch' }
    }
  }

  let after = snapshotAfter
  if (!after && params.projectRoot) {
    after = await captureRunStateSnapshot({
      runId: 'run_3',
      projectRoot: params.projectRoot,
      sessionId: 'canary_session_1',
    })
  }

  if (!after) {
    return { pass: false, reason: 'state_snapshot_missing' }
  }

  if (Array.isArray(strictEvidence.tool_executions)) {
    const execs = strictEvidence.tool_executions
    const listExec = execs.find((e) => e.tool_name === 'mnemosyne_list')
    const promotes = execs.filter((e) => e.tool_name === 'mnemosyne_promote')

    if (!listExec || promotes.length < 2) {
      return { pass: false, reason: 'missing_promote_tool_calls' }
    }

    if (listExec.ordinal > promotes[0].ordinal) {
      return { pass: false, reason: 'list_must_precede_promote' }
    }

    if (promotes[0].result_status !== 'promoted' || promotes[1].result_status !== 'noop') {
      return { pass: false, reason: 'promote_status_mismatch' }
    }
  }

  // Check physical retention of source short-term fact
  if (!shortId) {
    return { pass: false, reason: 'missing_source_short_memory_id' }
  }
  const sourceShort = after.short_term_refs.find((f) => f.memory_id === shortId)
  if (!sourceShort) {
    return { pass: false, reason: 'source_short_term_fact_deleted' }
  }

  // Check presence of promoted long-term fact
  let targetPromotedId = longId
  if (!targetPromotedId && Array.isArray(strictEvidence.tool_executions)) {
    const p0 = strictEvidence.tool_executions.find((e) => e.tool_name === 'mnemosyne_promote' && e.result_status === 'promoted')
    if (p0?.result_binding?.promoted_memory_id) {
      targetPromotedId = p0.result_binding.promoted_memory_id
    }
  }

  const longFact = after.long_term_refs.find((f) =>
    (targetPromotedId && f.memory_id === targetPromotedId) ||
    f.memory_id === shortId ||
    (Array.isArray(f.source_short_term_refs) && f.source_short_term_refs.some((r) => r.memory_id === shortId))
  )
  if (!longFact) {
    return { pass: false, reason: 'promoted_long_term_fact_missing' }
  }

  // Verify index disclosure
  if (after.index_memory_refs) {
    const inIndexLong = after.index_memory_refs.some((r) => r.memory_id === longFact.memory_id)
    if (!inIndexLong) {
      return { pass: false, reason: 'promoted_long_term_missing_from_index' }
    }
    const inIndexShort = after.index_memory_refs.some((r) => r.memory_id === sourceShort.memory_id)
    if (inIndexShort) {
      return { pass: false, reason: 'source_short_term_still_disclosed_in_index' }
    }
  }

  return { pass: true, promoted_long_term_ref: longFact }
}

export async function predicateRun4_CrossSessionReading(params) {
  const {
    snapshotAfter,
    sessionEvidence,
    targetMemoryId,
    sessionA1Hash,
    oldRetrievalId,
  } = params

  let after = snapshotAfter
  const strictEvidence = requireStrictSessionEvidence(sessionEvidence)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }
  if (!after && params.projectRoot) {
    after = await captureRunStateSnapshot({
      runId: 'run_4',
      projectRoot: params.projectRoot,
      sessionId: 'canary_session_4',
    })
  }

  if (!after || !after.current_ref) {
    return { pass: false, reason: 'valid_current_generation_missing' }
  }

  if (strictEvidence) {
    if (sessionA1Hash && strictEvidence.session_id_sha256 === sessionA1Hash) {
      return { pass: false, reason: 'run_4_must_use_fresh_session' }
    }

    if (Array.isArray(strictEvidence.tool_executions)) {
      const searchExec = strictEvidence.tool_executions.find((e) => e.tool_name === 'mnemosyne_search')
      const openExec = strictEvidence.tool_executions.find((e) => e.tool_name === 'mnemosyne_open')

      if (!searchExec || !openExec || searchExec.ordinal >= openExec.ordinal) {
        return { pass: false, reason: 'missing_search_or_open_calls' }
      }

      if (oldRetrievalId && openExec.argument_binding.retrieval_id === oldRetrievalId) {
        return { pass: false, reason: 'reused_old_session_grant' }
      }

      try {
        validateSearchOpenBinding(searchExec, openExec)
      } catch {
        return { pass: false, reason: 'search_open_binding_invalid' }
      }

      if (targetMemoryId && openExec.argument_binding.memory_id !== targetMemoryId) {
        return { pass: false, reason: 'target_memory_mismatch' }
      }
    }
  }

  return { pass: true }
}

export async function predicateRun5_ForgetAndGrantInvalidation(params) {
  const {
    snapshotAfter,
    sessionEvidence,
    targetMemoryId,
  } = params

  let after = snapshotAfter
  const strictEvidence = requireStrictSessionEvidence(sessionEvidence)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }
  if (!after && params.projectRoot) {
    after = await captureRunStateSnapshot({
      runId: 'run_5',
      projectRoot: params.projectRoot,
      sessionId: 'canary_session_5',
    })
  }

  if (!after) {
    return { pass: false, reason: 'state_snapshot_missing' }
  }

  if (Array.isArray(strictEvidence.tool_executions)) {
    const execs = strictEvidence.tool_executions
    const s1 = execs.find((e) => e.tool_name === 'mnemosyne_search')
    const f1 = execs.find((e) => e.tool_name === 'mnemosyne_forget' && e.result_status === 'forgotten')
    const f2 = execs.find((e) => e.tool_name === 'mnemosyne_forget' && e.result_status === 'noop')

    if (!s1 || !f1 || !f2) {
      return { pass: false, reason: 'missing_search_or_forget_calls' }
    }

    if (!(s1.ordinal < f1.ordinal && f1.ordinal < f2.ordinal)) {
      return { pass: false, reason: 'search_forget_sequence_invalid' }
    }
  }

  // Long-term fact must remain physically on disk
  if (!targetMemoryId) {
    return { pass: false, reason: 'missing_target_memory_id' }
  }
  const targetLong = after.long_term_refs.find((f) => f.memory_id === targetMemoryId)
  if (!targetLong) {
    return { pass: false, reason: 'long_term_fact_physically_deleted' }
  }

  // Forget fact must exist
  const forgetFact = after.forget_refs.find((f) => f.target_memory_id === targetMemoryId)
  if (!forgetFact) {
    return { pass: false, reason: 'forget_fact_missing' }
  }

  // Index must not disclose target
  if (after.index_memory_refs) {
    const inIndex = after.index_memory_refs.some((r) => r.memory_id === targetLong.memory_id)
    if (inIndex) {
      return { pass: false, reason: 'forgotten_memory_still_disclosed_in_index' }
    }
  }

  return { pass: true, forget_ref: forgetFact }
}

export async function predicateRun6_ScopeIsolation(params) {
  const {
    snapshotProjectA_Before,
    snapshotProjectA_After,
    snapshotProjectB,
    sessionEvidenceB,
    projectScopeA,
    projectScopeB,
    projectRootA,
    projectRootB,
    projectARoot,
    projectBRoot,
    canaryContentText,
  } = params

  const rootA = projectRootA || projectARoot
  const rootB = projectRootB || projectBRoot
  const scopeA = projectScopeA || (rootA ? computeProjectScopeId(rootA) : null)
  const scopeB = projectScopeB || (rootB ? computeProjectScopeId(rootB) : null)
  const strictEvidence = requireStrictSessionEvidence(sessionEvidenceB)
  if (!strictEvidence) {
    return { pass: false, reason: 'invalid_session_evidence' }
  }

  if (scopeA && scopeB && scopeA === scopeB) {
    return { pass: false, reason: 'project_scopes_not_isolated' }
  }

  if (snapshotProjectA_Before && snapshotProjectA_After) {
    if (snapshotProjectA_Before.snapshot_sha256 !== snapshotProjectA_After.snapshot_sha256) {
      return { pass: false, reason: 'project_a_state_drifted_during_run_6' }
    }
  }

  if (snapshotProjectB) {
    if (snapshotProjectB.short_term_refs.length > 0 || snapshotProjectB.long_term_refs.length > 0 || snapshotProjectB.forget_refs.length > 0) {
      return { pass: false, reason: 'project_b_facts_contaminated' }
    }
  } else if (rootB) {
    const stateB = await inspectFactStoreState(rootB)
    if (stateB.shortTerm.length > 0 || stateB.longTerm.length > 0 || stateB.forget.length > 0) {
      return { pass: false, reason: 'project_b_facts_contaminated' }
    }
    const currentB = await inspectCurrentGeneration(rootB)
    if (currentB && currentB.world) {
      if (scopeB && currentB.world.generation.project_scope_id !== scopeB) {
        return { pass: false, reason: 'project_b_generation_scope_mismatch' }
      }
      if ((currentB.world.index?.entries || []).length > 0) {
        return { pass: false, reason: 'project_b_facts_contaminated' }
      }
    }
  }

  if (Array.isArray(strictEvidence.tool_executions)) {
    for (const exec of strictEvidence.tool_executions) {
      const bindingStr = JSON.stringify(exec.result_binding)
      if (scopeA && bindingStr.includes(scopeA)) {
        return { pass: false, reason: 'project_a_scope_leaked_into_b_evidence' }
      }
    }
  }

  return { pass: true }
}
