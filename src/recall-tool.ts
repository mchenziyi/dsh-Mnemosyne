import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRecallReceipt, createRecallContext, encodeRecallContext, replayDisclosure, type RecallContextReceipt } from './protocol/recall.js'
import { ProtocolValidationError } from './protocol/canonical.js'

export const RECALL_PREFIX = '[Mnemosyne Recall v1 — plugin generated; not user authored]'
const PARAMETERS = { search_disclosure_json: { type: 'string', required: true }, open_disclosure_jsons: { type: 'array', required: true, items: { type: 'string' } } } as const
const OUTPUT = { type: 'object', additionalProperties: false, properties: { schema_version: { type: 'integer', required: true }, context_id: { type: 'string', required: true }, retrieval_id: { type: 'string', required: true }, memory_ids: { type: 'array', required: true, items: { type: 'string' } }, context_content_sha256: { type: 'string', required: true }, content_sha256: { type: 'string', required: true } } } as const

export function createRecallContextTool(): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'mnemosyne_eval_recall_context',
    description: 'Evaluation-only context plumbing tool; not part of the production plugin.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT as never, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, exec: { deferContext: (message: never) => void }): Promise<RecallContextReceipt> => {
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join('\0') !== ['open_disclosure_jsons', 'search_disclosure_json'].sort().join('\0')) throw new ProtocolValidationError()
        const input = args as { search_disclosure_json: string; open_disclosure_jsons: string[] }
        if (typeof input.search_disclosure_json !== 'string' || input.search_disclosure_json.length > 1_000_000 || !Array.isArray(input.open_disclosure_jsons) || input.open_disclosure_jsons.length < 1 || input.open_disclosure_jsons.length > 2 || input.open_disclosure_jsons.some((item) => typeof item !== 'string' || item.length > 1_000_000)) throw new ProtocolValidationError()
        const search = replayDisclosure(input.search_disclosure_json)
        if (search.level !== 2) throw new ProtocolValidationError()
        const opens = input.open_disclosure_jsons.map((item) => replayDisclosure(item))
        if (opens.some((item) => item.level !== 3)) throw new ProtocolValidationError()
        const context = createRecallContext(search, opens)
        const receipt = createRecallReceipt(context)
        const message = createUserMessage({ content: [{ type: 'text', text: `${RECALL_PREFIX}\n${encodeRecallContext(context)}` }], source: { kind: 'plugin', plugin: 'dsh-mnemosyne', form: 'recall' } })
        exec.deferContext(message as never)
        return receipt
      } catch {
        throw new Error('recall context validation failed')
      }
    },
  } as never)
}
