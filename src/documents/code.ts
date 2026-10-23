import { INITIAL } from "vscode-textmate"
import type { IGrammar } from "vscode-textmate"
import type { TextUnit } from "../model/document.ts"
import { sourceReferences } from "./references.ts"

export interface CodeRegion extends TextUnit {
  readonly kind: "comment" | "string"
}

export async function extractCode(source: string, language: string, grammar: IGrammar, checkCurrent: () => void): Promise<readonly CodeRegion[]> {
  let state = INITIAL
  let spans: { start: number; end: number; kind: CodeRegion["kind"]; scope: string; depth: number; protected: { start: number; end: number }[] }[] = []
  let depth = 0
  let offset = 0
  const lines = source.split(/\r?\n/u)
  for (let line = 0; line < lines.length; line++) {
    if (line && line % 100 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      checkCurrent()
    }
    const current = lines[line]
    const result = grammar.tokenizeLine(current, state, 100)
    if (result.stoppedEarly) throw Error("language-tokenization-timeout")
    state = result.ruleStack
    for (const token of result.tokens) {
      const fstring = language === "python" && token.scopes.includes("meta.fstring.python")
      const scope = fstring ? "string.interpolated.python" : token.scopes.find((value) => value.startsWith("comment.") || value.startsWith("string."))
      if (!scope) {
        if (language === "python")
          for (const character of current.slice(token.startIndex, token.endIndex)) {
            if ("([{".includes(character)) depth++
            else if (")]}".includes(character)) depth--
          }
        continue
      }
      const kind = scope.startsWith("comment.") ? "comment" : "string"
      const start = offset + token.startIndex
      const end = offset + Math.min(token.endIndex, current.length)
      if (end <= start) continue
      const previous = spans.at(-1)
      const gap = previous ? source.slice(previous.end, start) : ""
      const multiline = scope.startsWith("comment.block") || scope.includes("string.quoted.multi") || scope.startsWith("string.template")
      if (previous?.kind === kind && previous.scope === scope && (previous.end === start || (multiline && /^\s*$/.test(gap)))) previous.end = end
      else spans.push({ start, end, kind, scope, depth, protected: [] })
      const active = spans.at(-1)!
      const protectedToken =
        (fstring && (!token.scopes.includes("string.interpolated.python") || token.scopes.filter((scope) => scope === "meta.fstring.python").length > 1)) ||
        token.scopes.some(
          (value) =>
            value.startsWith("punctuation.definition.comment") ||
            value.startsWith("punctuation.definition.string") ||
            value.startsWith("constant.character.escape") ||
            value.startsWith("meta.template.expression") ||
            value.startsWith("meta.interpolation") ||
            (language === "python" && value === "storage.type.string.python")
        )
      if (protectedToken) {
        const previousRange = active.protected.at(-1)
        if (previousRange?.end === start) previousRange.end = end
        else active.protected.push({ start, end })
      }
    }
    offset += current.length + (source.startsWith("\r\n", offset + current.length) ? 2 : 1)
  }
  if (language === "python") {
    const joined: typeof spans = []
    for (const next of spans) {
      const previous = joined.at(-1)
      if (!previous) {
        joined.push(next)
        continue
      }
      const gap = source.slice(previous.end, next.start)
      // A newline joins literals only inside a grouping or through explicit continuation.
      const adjacent = /^[\t ]*(?:\\\r?\n[\t ]*|\r?\n[\t ]*)*$/u.test(gap) && (!/[\r\n]/u.test(gap) || previous.depth > 0 || /\\\r?\n/u.test(gap))
      if (previous.kind !== "string" || next.kind !== "string" || previous.depth !== next.depth || !adjacent) {
        joined.push(next)
        continue
      }
      if (next.start > previous.end) previous.protected.push({ start: previous.end, end: next.start })
      previous.protected.push(...next.protected)
      previous.end = next.end
    }
    spans = joined
  }
  const regions = spans
    .filter((span) => /\p{L}/u.test(source.slice(span.start, span.end)))
    .map((span) => ({
      id: `u${span.start}-${span.end}`,
      start: span.start,
      end: span.end,
      text: source.slice(span.start, span.end),
      content: span.kind === "string" && (language === "json" || language === "jsonc") ? (JSON.parse(source.slice(span.start, span.end)) as string) : undefined,
      format: "text" as const,
      kind: span.kind,
      reference: sourceReferences(source, span, language),
      scope: "code:" + language,
      language,
      protected: span.protected.map((range) => ({ start: range.start - span.start, end: range.end - span.start }))
    }))
  checkCurrent()
  return regions
}
