import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const profileDir = process.argv[2]
if (!profileDir) throw new Error('profile directory is required')

async function load(specifier) {
  const parts = specifier.startsWith('@') ? specifier.split('/') : [specifier]
  const roots = [join(profileDir, 'node_modules'), join(dirname(profileDir), 'node_modules')]
  for (const root of roots) {
    const packageDir = join(root, ...parts)
    try {
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
      const entry = manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? manifest.exports?.['.'] ?? manifest.module ?? manifest.main
      if (typeof entry !== 'string') throw new Error(`package ${specifier} has no ESM entry`)
      return import(pathToFileURL(join(packageDir, entry)).href)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`cannot resolve ${specifier} from the isolated profile`)
}

const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }, { ToolCallId }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-llm'),
  load('@cziyi/dsh-mnemosyne'),
])

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
const fiber = await ctx.plugin({
  name: plugin.name,
  Config: plugin.Config,
  inject: plugin.inject,
  apply: plugin.apply,
}, { enabled: true })

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId('m0-profile-status'),
  name: 'mnemosyne_status',
  arguments: {},
})

if (JSON.stringify(result.value) !== JSON.stringify(plugin.STATUS_OUTPUT)) {
  throw new Error('profile-installed status tool returned an unexpected result')
}

const searchResult = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId('m0-profile-search'),
  name: 'mnemosyne_search',
  arguments: { query: 'compiler cache targeted rebuild' },
})
if (searchResult.isError || !searchResult.value?.items?.length || searchResult.value.level !== 2) {
  throw new Error('profile-installed search tool did not return an L2 disclosure')
}
const search = searchResult.value
const openResult = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId('m0-profile-open'),
  name: 'mnemosyne_open',
  arguments: {
    retrieval_id: search.retrieval_ref,
    search_disclosure_sha256: search.content_sha256,
    memory_id: search.items[0].memory_id,
  },
})
if (openResult.isError || openResult.value?.level !== 3 || typeof openResult.value?.body !== 'string') {
  throw new Error('profile-installed open tool did not return an L3 disclosure')
}

await fiber.dispose()
for (const name of ['mnemosyne_status', 'mnemosyne_search', 'mnemosyne_open']) {
  if (ctx.tools.get(name) !== undefined) throw new Error(`profile-installed ${name} survived plugin disposal`)
}

process.stdout.write(`${JSON.stringify(result.value)}\n`)
