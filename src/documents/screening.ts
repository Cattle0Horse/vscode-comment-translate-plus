import type { PreserveTerms, PreservePhrase } from "../model/translation.ts"

// Consume whole Latin tokens; Han adjacency is a boundary, another Latin letter,
// digit or combining mark is not. Keep this grammar shared with phrase compilation.
const detectionTokens =
  /(?<![\p{Script=Latin}\p{N}\p{M}_$])[A-Za-z_$][A-Za-z\d_$]*(?:(?:(?:::|[./:+-])[A-Za-z\d_$]+)|(?:\([A-Za-z\d_$]+\)))*(?:\+{1,2}|#{1,2})?(?![\p{Script=Latin}\p{N}\p{M}_$])/gu

/** Compile only phrases that screening can match, preserving exact whitespace. */
export function indexScreeningPhrases(literals: ReadonlySet<string>): ReadonlyMap<string, readonly PreservePhrase[]> {
  const phrases = new Map<string, PreservePhrase[]>()
  for (const literal of literals) {
    if (!/[\t ]/u.test(literal)) continue
    const tokens = [...literal.matchAll(detectionTokens)]
    if (tokens.length < 2) continue
    const last = tokens[tokens.length - 1]
    if (tokens[0].index !== 0 || last.index + last[0].length !== literal.length) continue
    const tail = tokens.slice(1).map((token, index) => ({ word: token[0], gap: literal.slice(tokens[index].index + tokens[index][0].length, token.index) }))
    if (tail.some((part) => !/^[\t ]+$/u.test(part.gap))) continue
    const first = tokens[0][0]
    const candidates = phrases.get(first) ?? []
    candidates.push(tail)
    phrases.set(first, candidates)
  }
  for (const candidates of phrases.values()) candidates.sort((a, b) => b.length - a.length)
  return phrases
}

export function screeningText(text: string, terms?: PreserveTerms): string {
  const tokens = [...text.matchAll(detectionTokens)]
  if (!tokens.length) return text
  const words = tokens.map((token) => token[0].toLowerCase())
  let result = ""
  let cursor = 0
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const start = token.index
    let last = index
    // Longest complete phrase owns its words, even if its first word is itself
    // a preserved term or identifier. Only inspect candidates sharing this word.
    for (const phrase of terms?.phrases.get(words[index]) ?? []) {
      if (index + phrase.length >= tokens.length) continue
      let matches = true
      for (let offset = 0; offset < phrase.length; offset++) {
        const previous = tokens[index + offset]
        const gapStart = previous.index + previous[0].length
        const { word, gap } = phrase[offset]
        if (words[index + offset + 1] !== word || tokens[index + offset + 1].index !== gapStart + gap.length || !text.startsWith(gap, gapStart)) {
          matches = false
          break
        }
      }
      if (matches) {
        last = index + phrase.length
        break
      }
    }
    const preserved =
      last > index ||
      terms?.literals.has(words[index]) ||
      // Ordinary words, acronyms and hyphenated prose are not identifier evidence.
      /^(?:[$_]+[A-Za-z][A-Za-z\d_$]*|[A-Za-z][A-Za-z\d_$]*_)$/u.test(token[0]) ||
      (/^[A-Za-z_$][A-Za-z\d_$]*$/u.test(token[0]) && /[a-z][A-Z]|[A-Z]{2}[a-z]|[A-Za-z\d]_[A-Za-z\d]/u.test(token[0])) ||
      /^[A-Za-z_$][A-Za-z\d_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z\d_$]*)+$/u.test(token[0]) ||
      terms?.expressions.some((expression) => expression.test(token[0]))
    if (!preserved) continue
    result += text.slice(cursor, start) + " "
    cursor = tokens[last].index + tokens[last][0].length
    index = last
  }
  return result + text.slice(cursor)
}
