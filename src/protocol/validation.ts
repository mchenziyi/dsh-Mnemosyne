// M0.5A's validation facade is intentionally internal.  Keeping the public
// package root unchanged prevents the fixture protocol from becoming a dsh API.
export { ProtocolValidationError, assertArray, assertExactKeys, assertHash, assertId, assertInteger, assertObject, assertSafeText, canonicalBytes, canonicalHash } from './canonical.js'
export { validateCandidate, validateSkipDecision } from './acquisition.js'
export { validateEvaluationProtocol, validateFixtureManifest, validateFixtureSet, validateMemoryCatalog, validatePairedTasks, validateRetrievalCases, validateRunResult, validateSummaryReport } from './evaluation.js'
