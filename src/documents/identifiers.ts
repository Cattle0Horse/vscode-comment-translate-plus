import type { TextUnit } from "../model/document.ts"
import type { SourceToken } from "./tokenization.ts"

/** Split naming conventions without guessing what an abbreviation stands for. */
export function identifierWords(name: string): string {
  return name
    .replace(/[_$]+/gu, " ")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .trim()
}

/** Grammar scopes establish code ownership; the Unicode word must fit its complete token. */
export function identifierUnit(source: string, offset: number, language: string, tokens: Iterable<SourceToken>): TextUnit | undefined {
  for (const token of tokens) {
    if (token.start > offset) return
    if (offset >= token.end) continue
    if (!token.scopes.some((scope) => scope.startsWith("source."))) return
    if (
      token.scopes.some((scope) =>
        /^(?:comment|string|keyword|storage|punctuation|invalid|variable\.language|constant\.(?:numeric|language)|entity\.(?:name\.tag|other\.attribute-name))(?:\.|$)/u.test(scope)
      )
    )
      return
    for (const match of source.slice(token.start, token.end).matchAll(/[\p{ID_Start}_$][\p{ID_Continue}$]*/gu)) {
      const start = token.start + match.index
      const end = start + match[0].length
      if (start > offset || offset >= end) continue
      if (/[\p{ID_Continue}$]/u.test(source.slice(start - 1, start)) || /[\p{ID_Continue}$]/u.test(source.slice(end, end + 1))) return
      if (!/\p{L}/u.test(match[0])) return
      const lineStart = source.lastIndexOf("\n", start - 1) + 1
      let lineEnd = source.indexOf("\n", end)
      if (lineEnd < 0) lineEnd = source.length
      if (source[lineEnd - 1] === "\r") lineEnd--
      return {
        id: "identifier:" + start + ":" + end,
        start,
        end,
        text: match[0],
        format: "text",
        kind: "identifier",
        language,
        reference: lineEnd - lineStart <= 2048 ? [{ kind: "Source", text: source.slice(lineStart, lineEnd) }] : []
      }
    }
    return
  }
}
