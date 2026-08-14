import { assertSafeText, ProtocolValidationError } from '../protocol/canonical.js'

export function normalizeQuery(value: unknown): string {
  assertSafeText(value, 500)
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  if (!normalized) throw new ProtocolValidationError()
  return normalized
}

function isHan(value: string): boolean { return /^\p{Script=Han}$/u.test(value) }

export function tokenize(value: string): string[] {
  const tokens: string[] = []
  const characters = Array.from(value.normalize('NFKC').toLowerCase())
  let index = 0
  while (index < characters.length) {
    if (isHan(characters[index])) {
      let end = index + 1
      while (end < characters.length && isHan(characters[end])) end++
      const segment = characters.slice(index, end)
      for (const character of segment) tokens.push(character)
      for (let width = 2; width <= 3; width++) for (let offset = 0; offset + width <= segment.length; offset++) tokens.push(segment.slice(offset, offset + width).join(''))
      if (tokens.length > 256) throw new ProtocolValidationError()
      index = end
      continue
    }
    const match = characters.slice(index).join('').match(/^[\p{L}\p{N}]+/u)
    if (match) { tokens.push(match[0]); index += Array.from(match[0]).length } else index++
    if (tokens.length > 256) throw new ProtocolValidationError()
  }
  return tokens
}
