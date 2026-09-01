import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { MapOfferV3 } from './map-offer.js'

export const MAP_CONTEXT_PREFIX = '[Mnemosyne Map v3 — plugin generated; not user authored]'

export function createMapContextMessageV3(offer: MapOfferV3): UserMessage {
  const entries = offer.entries.map((entry) => ({ ref: entry.ref, title: entry.title, kind: entry.kind }))
  const payload = JSON.stringify({ schema_version: 1, generation_id: offer.generation_id, catalog_id: offer.catalog_id, node_id: offer.node_id, entries, next_cursor: offer.next_cursor })
  return createUserMessage({ content: [{ type: 'text', text: `${MAP_CONTEXT_PREFIX}\n${payload}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'catalog' } })
}
