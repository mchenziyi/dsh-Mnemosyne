import catalogJson from '../../fixtures/m0.5/v1/memory-catalog.json' with { type: 'json' }
import { validateMemoryCatalog, type MemoryCatalog } from '../protocol/evaluation.js'

export const FIXTURE_CATALOG: MemoryCatalog = Object.freeze(validateMemoryCatalog(catalogJson))
