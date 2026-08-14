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

const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }, { CallId }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-llm'),
  load('dsh-mnemosyne'),
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
  callId: CallId('m0-profile-status'),
  name: 'mnemosyne_status',
  arguments: {},
})

if (JSON.stringify(result.value) !== JSON.stringify(plugin.STATUS_OUTPUT)) {
  throw new Error('profile-installed status tool returned an unexpected result')
}

await fiber.dispose()
if (ctx.tools.get('mnemosyne_status') !== undefined) {
  throw new Error('profile-installed status tool survived plugin disposal')
}

process.stdout.write(`${JSON.stringify(result.value)}\n`)
