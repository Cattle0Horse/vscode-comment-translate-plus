import { INITIAL } from "vscode-textmate"
import type { IGrammar } from "vscode-textmate"
import type { TextUnit } from "../model/document.ts"
import { sourceReferences } from "./references.ts"
import { pythonStringUnits } from "./python.ts"

export interface CodeRegion extends TextUnit {
  readonly kind: "comment" | "string"
}

export async function extractCode(source: string, language: string, grammar: IGrammar, checkCurrent: () => void): Promise<readonly CodeRegion[]> {
  let state = INITIAL
  let spans: {
    start: number
    end: number
    kind: CodeRegion["kind"]
    scope: string
    depth: number
    protected: { start: number; end: number }[]
    complete?: boolean
    commentPrefix?: string
    indent?: string
    literals?: { start: number; end: number; protected: { start: number; end: number }[] }[]
  }[] = []
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
      // Shell grammars label executable arguments as strings; quoted children remain translatable.
      const scope = fstring
        ? "string.interpolated.python"
        : token.scopes.find(
            (value) =>
              value.startsWith("comment.") ||
              (value.startsWith("string.") && !(language === "shellscript" && (value === "string.unquoted.shell" || value.startsWith("string.unquoted.argument"))))
          )
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
      const multiline =
        scope.startsWith("comment.block") || token.scopes.some((value) => value.startsWith("string.quoted.") && value.includes(".multi.")) || scope.startsWith("string.template")
      if (previous?.kind === kind && previous.scope === scope && !previous.complete && (previous.end === start || (multiline && /^\s*$/.test(gap)))) previous.end = end
      else spans.push({ start, end, kind, scope, depth, protected: [] })
      const active = spans.at(-1)!
      const fstringExpression = fstring && (!token.scopes.includes("string.interpolated.python") || token.scopes.filter((scope) => scope === "meta.fstring.python").length > 1)
      if (language === "python" && token.scopes.includes("punctuation.definition.string.end.python") && !fstringExpression) active.complete = true
      const protectedToken =
        fstringExpression ||
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
    for (const span of spans) if (span.kind === "string") span.literals = [{ start: span.start, end: span.end, protected: span.protected }]
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
      previous.literals!.push(...next.literals!)
      previous.end = next.end
    }
    spans = joined
  }
  const paragraphs: typeof spans = []
  for (const span of spans) {
    if (span.scope.startsWith("comment.line")) {
      const text = source.slice(span.start, span.end)
      const delimiter = span.protected.find((range) => range.start === span.start)
      span.commentPrefix = text.match(/^(?:\/{2,}!?|#+!?|--+|;+|%+|'+|!)/u)?.[0] ?? (delimiter ? source.slice(delimiter.start, delimiter.end).trimEnd() : undefined)
      if (span.commentPrefix && !text.slice(span.commentPrefix.length).trim()) span.commentPrefix = undefined
      const leading = source.slice(source.lastIndexOf("\n", span.start - 1) + 1, span.start)
      if (/^[\t ]*$/u.test(leading)) span.indent = leading
      const previous = paragraphs.at(-1)
      if (
        span.commentPrefix &&
        span.indent !== undefined &&
        previous?.scope === span.scope &&
        previous.commentPrefix === span.commentPrefix &&
        previous.indent === span.indent &&
        /^\r?\n[\t ]*$/u.test(source.slice(previous.end, span.start))
      ) {
        previous.end = span.end
        previous.protected.push(...span.protected)
        continue
      }
    }
    paragraphs.push(span)
  }
  const regions = paragraphs
    .filter((span) => /\p{L}/u.test(source.slice(span.start, span.end)))
    .flatMap((span) => {
      const region: CodeRegion = {
        id: `u${span.start}-${span.end}`,
        start: span.start,
        end: span.end,
        text: source.slice(span.start, span.end),
        content: span.kind === "string" && (language === "json" || language === "jsonc") ? (JSON.parse(source.slice(span.start, span.end)) as string) : undefined,
        format: "text" as const,
        kind: span.kind,
        commentPrefix: span.commentPrefix,
        reference: sourceReferences(source, span, language),
        scope: "code:" + language,
        language,
        protected: span.protected.map((range) => ({ start: range.start - span.start, end: range.end - span.start }))
      }
      return span.literals ? pythonStringUnits(source, region, span.literals) : [region]
    })
  checkCurrent()
  return regions
}
