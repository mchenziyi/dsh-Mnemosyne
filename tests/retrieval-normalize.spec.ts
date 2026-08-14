import { describe, expect, it } from 'vitest'
import { normalizeQuery, tokenize } from '../src/retrieval/normalize.js'

describe('M0.5B Unicode retrieval normalization', () => {
  it('uses deterministic NFKC/lowercase and code-point-safe tokenization', () => {
    expect(normalizeQuery('  ＡＢＣ   TEST  ')).toBe('abc test')
    expect(tokenize('😀Build')).toEqual(['build'])
    expect(tokenize('中文测试')).toEqual(['中', '文', '测', '试', '中文', '文测', '测试', '中文测', '文测试'])
    expect(tokenize('𠀀')).toEqual(['𠀀'])
  })

  it('rejects excessive token counts deterministically', () => {
    expect(() => tokenize('a '.repeat(257))).toThrow()
  })
})
