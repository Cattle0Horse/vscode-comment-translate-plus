import type { TextUnit } from "../model/document.ts"
import { sourceReferences } from "./references.ts"
import { pythonStringUnits, pythonTokens, joinPythonLiterals } from "./python.ts"
import type { PythonLiteral } from "./python.ts"
import { regionToken, sourceTokens } from "./tokenization.ts"
import type { CodeTokenizer, CodeSpan, RegionToken } from "./tokenization.ts"

export interface CodeRegion extends TextUnit {
  readonly kind: "comment" | "string"
}

/** Collect complete syntax regions before any paragraph or literal grouping. */
function collectRegions(source: string, tokens: Iterable<RegionToken>): CodeSpan[] {
  const spans: CodeSpan[] = []
  for (const token of tokens) {
    const previous = spans.at(-1)
    const gap = previous ? source.slice(previous.end, token.start) : ""
    if (previous?.kind === token.kind && previous.scope === token.scope && !previous.complete && (previous.end === token.start || (previous.multiline && /^\s*$/.test(gap))))
      previous.end = token.end
    else spans.push({ start: token.start, end: token.end, kind: token.kind, scope: token.scope, depth: token.depth, multiline: token.multiline, protected: [] })
    const active = spans.at(-1)!
    if (token.complete) active.complete = true
    if (token.protected) {
      const previousRange = active.protected.at(-1)
      if (previousRange?.end === token.start) previousRange.end = token.end
      else active.protected.push({ start: token.start, end: token.end })
    }
  }
  return spans
}

/** Adjacent standalone prose comments form one paragraph; code, empty comments and separators remain boundaries. */
function commentParagraphs(source: string, spans: readonly CodeSpan[]): CodeSpan[] {
  const paragraphs: CodeSpan[] = []
  for (const span of spans) {
    if (span.scope.startsWith("comment.line")) {
      const text = source.slice(span.start, span.end)
      const delimiter = span.protected.find((range) => range.start === span.start)
      span.commentPrefix = text.match(/^(?:\/{2,}!?|#+!?|--+|;+|%+|'+|!)/u)?.[0] ?? (delimiter ? source.slice(delimiter.start, delimiter.end).trimEnd() : undefined)
      if (span.commentPrefix && !/[\p{L}\p{N}]/u.test(text.slice(span.commentPrefix.length))) span.commentPrefix = undefined
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
  return paragraphs
}

export async function extractCode(source: string, language: string, tokenizer: CodeTokenizer, checkCurrent: () => void): Promise<readonly CodeRegion[]> {
  const lines = await tokenizer.tokenize(source, language, checkCurrent)
  const raw = sourceTokens(source, lines)
  const tokens =
    language === "python"
      ? pythonTokens(source, raw)
      : (function* () {
          for (const token of raw) {
            // Shell grammars label executable arguments as strings; quoted children remain translatable.
            const scope = token.scopes.find(
              (value) =>
                value.startsWith("comment.") ||
                (value.startsWith("string.") && !(language === "shellscript" && (value === "string.unquoted.shell" || value.startsWith("string.unquoted.argument"))))
            )
            if (!scope) continue
            const classified = regionToken(token, scope)
            if (classified) yield classified
          }
        })()
  const spans = collectRegions(source, tokens)
  const paragraphs = commentParagraphs(source, spans)
  const semantic: readonly (CodeSpan & { readonly literals?: readonly PythonLiteral[] })[] = language === "python" ? joinPythonLiterals(source, paragraphs) : paragraphs
  const regions = semantic
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
