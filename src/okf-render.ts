import { compareCodePoints } from './protocol/canonical.js'
import type { LongTermMemoryFact, ShortTermMemoryFact } from './memory-fact.js'
import { MemoryStoreError } from './memory-store-error.js'

const COMPONENT_TAG_REGEX = /^component-([a-z0-9][a-z0-9_-]{0,23})$/

export function deriveComponentSlug(tags: string[]): string {
  const componentTags: string[] = []
  for (const tag of tags) {
    if (tag.startsWith('component-')) {
      const match = COMPONENT_TAG_REGEX.exec(tag)
      if (!match) {
        throw new MemoryStoreError('memory_compile_invalid_input')
      }
      componentTags.push(match[1])
    }
  }

  if (componentTags.length === 0) {
    return 'general'
  }
  if (componentTags.length === 1) {
    return componentTags[0]
  }

  throw new MemoryStoreError('memory_compile_invalid_input')
}
export function sanitizeSingleLine(text: string): string {
  if (!text) return ''
  // 1. Normalize CR/LF into spaces to prevent line breaking
  let s = text.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ')
  // 2. Escape HTML brackets
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 3. Escape Markdown control characters
  s = s.replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1')
  return s
}

export function escapeMarkdownText(text: string): string {
  return sanitizeSingleLine(text)
}

export function quoteMarkdownBlock(text: string): string {
  if (!text || text.length === 0) {
    return '> (empty)'
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  return lines
    .map((line) => {
      if (line.length === 0) {
        return '>'
      }
      const escaped = sanitizeSingleLine(line)
      return `> ${escaped}`
    })
    .join('\n')
}

export interface RootPageData {
  generation_id: string
  evaluation_at: string
  short_term_count: number
  long_term_count: number
  sessions: string[]
  components: string[]
  memories_count: number
}

export function renderRootPage(data: RootPageData): string {
  const sortedSessions = [...data.sessions].sort(compareCodePoints)
  const sortedComponents = [...data.components].sort(compareCodePoints)

  const lines: string[] = [
    '# Open Knowledge Fact Index',
    '',
    '## Metadata',
    `- Generation ID: \`${data.generation_id}\``,
    `- Evaluation At: \`${data.evaluation_at}\``,
    `- Total Memories: ${data.memories_count}`,
    `- Short-term Memories: ${data.short_term_count}`,
    `- Long-term Memories: ${data.long_term_count}`,
    '',
    '## Short-term Sessions',
  ]

  if (sortedSessions.length === 0) {
    lines.push('- (none)')
  } else {
    for (const session of sortedSessions) {
      lines.push(`- [Session: ${session}](short-term/${session}.md)`)
    }
  }

  lines.push('')
  lines.push('## Long-term Components')

  if (sortedComponents.length === 0) {
    lines.push('- (none)')
  } else {
    for (const comp of sortedComponents) {
      lines.push(`- [Component: ${comp}](components/${comp}.md)`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

export interface SessionPageData {
  session_scope_id: string
  evaluation_at: string
  facts: ShortTermMemoryFact[]
}

export function renderSessionPage(data: SessionPageData): string {
  const sortedFacts = [...data.facts].sort((a, b) => compareCodePoints(a.memory_id, b.memory_id))

  const lines: string[] = [
    `# Short-term Session: ${data.session_scope_id}`,
    '',
    '## Metadata',
    `- Session Scope ID: \`${data.session_scope_id}\``,
    `- Evaluation At: \`${data.evaluation_at}\``,
    `- Fact Count: ${sortedFacts.length}`,
    '',
    '## Memories',
  ]

  if (sortedFacts.length === 0) {
    lines.push('(none)')
  } else {
    for (const fact of sortedFacts) {
      const safeTitle = sanitizeSingleLine(fact.title)
      lines.push(`### [${fact.memory_id}](../memories/${fact.memory_id}.md) - ${safeTitle}`)
      lines.push(`- Created At: \`${fact.created_at}\``)
      lines.push(`- Expires At: \`${fact.expires_at}\``)
      lines.push(`- Content SHA256: \`${fact.content_sha256}\``)
      lines.push(`- Tags: ${fact.tags.map((t) => `\`${sanitizeSingleLine(t)}\``).join(', ')}`)
      lines.push('')
      lines.push('#### Summary')
      lines.push(quoteMarkdownBlock(fact.summary))
      lines.push('')
    }
  }

  lines.push('')
  return lines.join('\n')
}

export interface ComponentPageData {
  component: string
  evaluation_at: string
  facts: LongTermMemoryFact[]
}

export function renderComponentPage(data: ComponentPageData): string {
  const sortedFacts = [...data.facts].sort((a, b) => compareCodePoints(a.memory_id, b.memory_id))

  const lines: string[] = [
    `# Component: ${data.component}`,
    '',
    '## Metadata',
    `- Component Slug: \`${data.component}\``,
    `- Evaluation At: \`${data.evaluation_at}\``,
    `- Fact Count: ${sortedFacts.length}`,
    '',
    '## Memories',
  ]

  if (sortedFacts.length === 0) {
    lines.push('(none)')
  } else {
    for (const fact of sortedFacts) {
      const safeTitle = sanitizeSingleLine(fact.title)
      lines.push(`### [${fact.memory_id}](../memories/${fact.memory_id}.md) - ${safeTitle}`)
      lines.push(`- Created At: \`${fact.created_at}\``)
      lines.push(`- Content SHA256: \`${fact.content_sha256}\``)
      lines.push(`- Tags: ${fact.tags.map((t) => `\`${sanitizeSingleLine(t)}\``).join(', ')}`)
      lines.push('')
      lines.push('#### Summary')
      lines.push(quoteMarkdownBlock(fact.summary))
      lines.push('')
    }
  }

  lines.push('')
  return lines.join('\n')
}

export interface MemoryPageData {
  fact: ShortTermMemoryFact | LongTermMemoryFact
  component: string | null
  evaluation_at: string
}

export function renderMemoryPage(data: MemoryPageData): string {
  const { fact } = data
  const safeTitle = sanitizeSingleLine(fact.title)
  const lines: string[] = [
    `# Memory: ${fact.memory_id}`,
    '',
    '## Metadata',
    `- Title: ${safeTitle}`,
    `- Tier: \`${fact.tier}\``,
    `- Project Scope ID: \`${fact.project_scope_id}\``,
  ]

  if (fact.tier === 'short_term') {
    lines.push(`- Session Scope ID: \`${(fact as ShortTermMemoryFact).session_scope_id}\``)
    lines.push(`- Expires At: \`${(fact as ShortTermMemoryFact).expires_at}\``)
  } else if (data.component) {
    lines.push(`- Component: \`${data.component}\``)
  }

  lines.push(`- Created At: \`${fact.created_at}\``)
  lines.push(`- Content SHA256: \`${fact.content_sha256}\``)
  lines.push(`- Tags: ${fact.tags.map((t) => `\`${sanitizeSingleLine(t)}\``).join(', ')}`)
  lines.push('')
  lines.push('## Summary')
  lines.push(quoteMarkdownBlock(fact.summary))
  lines.push('')
  lines.push('## Body')
  lines.push(quoteMarkdownBlock(fact.body))
  lines.push('')

  return lines.join('\n')
}
