import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { withRecallPolicyV3 } from '../src/v3/recall-policy.js'

describe('v3 parent recall policy', () => {
  const assembly = (enabled: boolean): PromptAssembly => ({ sections: [{ name: 'persona', text: 'Coding agent' }], contexts: [], tools: enabled ? [{ name: 'mnemosyne_recall' } as never] : [], variables: {} })

  it('adds the relevance decision and disclosure rules without replacing the persona', () => {
    const original = assembly(true)
    const result = withRecallPolicyV3(original)
    expect(result.sections[0]).toEqual(original.sections[0])
    const policy = result.sections[1].text
    expect(policy).toContain('must call mnemosyne_recall')
    expect(policy).toContain('titles are unrelated')
    expect(policy).toContain('Title → Summary → Content')
    expect(policy).toContain('no_match or failed')
    expect(policy).toContain('explicit request not to use memory')
    expect(original.sections).toHaveLength(1)
    expect(withRecallPolicyV3(result)).toBe(result)
  })

  it('does not affect requests without the tool, including memory children', () => {
    const original = assembly(false)
    expect(withRecallPolicyV3(original)).toBe(original)
  })
})
