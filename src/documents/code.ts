import type { TextUnit } from "../model/document.ts"
import { sourceReferences } from "./references.ts"
import { endsProseLine, markdownTree, children } from "./tree.ts"
import { pythonStringUnits, pythonTokens, joinPythonLiterals } from "./python.ts"
import type { PythonLiteral } from "./python.ts"
import { regionToken, sourceTokens } from "./tokenization.ts"
import type { CodeTokenizer, CodeSpan, RegionToken } from "./tokenization.ts"
import { proseUnits } from "./prose.ts"
import { blockCommentProcessor } from "./commentSyntax.ts"
import { SourceMap } from "./sourceMap.ts"

export interface CodeRegion extends TextUnit {
  readonly kind: "comment" | "string"
}

/** Collect complete syntax regions before any paragraph or literal grouping. */
function collectRegions(source: string, tokens: Iterable<RegionToken>): CodeSpan[] {
  const spans: CodeSpan[] = []
  let previousDelimiter = false
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
      const delimiter = token.scopes.some((value) => value.startsWith("punctuation.definition.string"))
      if (previousRange?.end === token.start && !delimiter && !previousDelimiter) previousRange.end = token.end
      else active.protected.push({ start: token.start, end: token.end })
      previousDelimiter = delimiter
    } else previousDelimiter = false
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
        !endsProseLine(source.slice(previous.start, previous.end)) &&
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

/** Parse block-comment prose with the same paragraph/list/example boundaries as docstrings. */
function blockCommentSpans(source: string, span: CodeSpan): CodeSpan[] {
  if (span.kind !== "comment" || !span.scope.startsWith("comment.block")) return [span]
  const raw = source.slice(span.start, span.end)
  const processor = blockCommentProcessor(raw)
  if (!processor || !raw.includes("\n")) return [span]
  const html = processor.kind === "html"
  if (html && !processor.body) return [span]
  const tail = raw.trimEnd()
  const closeAt = tail.endsWith(processor.closing) ? tail.length - processor.closing.length : -1
  const closeLine = closeAt < 0 ? -1 : raw.lastIndexOf("\n", closeAt) + 1
  const closing = closeAt >= 0 && !raw.slice(closeLine, closeAt).trim()
  const inlineClosing = !closing && closeAt >= 0
  let end = raw.length
  if (closing) end = closeLine
  else if (inlineClosing) end = closeAt
  const body = raw.slice(processor.opening.length, end)
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/gu)].filter((line) => line[0])
  const decorated = !html && lines.slice(1).every((line) => !line[0].trim() || /^[\t ]*\*(?:[\t ]|$)/u.test(line[0].trimEnd()))
  const indent = Math.min(...lines.filter((line) => line[0].trim()).map((line) => line[0].match(/^[\t ]*/u)![0].length))
  const positions = new SourceMap()
  let text = ""
  for (const [index, line] of lines.entries()) {
    let prefix: number
    if (decorated && index > 0) prefix = line[0].match(/^[\t ]*\*(?:[\t ]|(?=[\r\n]|$))/u)?.[0].length ?? 0
    else prefix = Math.min(indent, line[0].match(/^[\t ]*/u)![0].length)
    const start = span.start + processor.opening.length + line.index + prefix
    const content = line[0].slice(prefix)
    text += content
    positions.append(content.length, start, start + content.length)
  }
  const protectedRanges = span.protected.flatMap((range) => {
    const start = positions.logical(range.start)
    const end = positions.logical(range.end, true)
    return start !== undefined && end !== undefined && end > start ? [{ start, end }] : []
  })
  return proseUnits(text, protectedRanges).map((block, index) => {
    const mapped = positions.range(block.start, block.end)
    const lineStart = source.lastIndexOf("\n", mapped.start - 1) + 1
    const prefix = !html ? source.slice(lineStart, mapped.start).match(/^[\t ]*(\*[\t ]*)$/u) : undefined
    let start = prefix ? lineStart + prefix[0].length - prefix[1].length : mapped.start
    if (!html && index === 0 && !text.slice(0, block.start).trim()) start = span.start
    const end = inlineClosing && !html && !text.slice(block.end).trim() ? span.end : mapped.end
    return { ...span, start, end, commentPrefix: prefix && start !== span.start ? "*" : undefined, protected: span.protected.filter((range) => range.start >= start && range.end <= end) }
  })
}

/** Split physical prose lines without cutting grammar-owned escapes or interpolations. */
function sentenceSpans(source: string, span: CodeSpan): CodeSpan[] {
  const text = source.slice(span.start, span.end)
  if (!text.includes("\n")) return [span]
  const ranges: { start: number; end: number }[] = []
  const inline: { start: number; end: number }[] = []

  function visit(node: ReturnType<typeof markdownTree>["topNode"]): void {
    if (["InlineCode", "Link", "Image", "Emphasis", "StrongEmphasis", "Strikethrough", "HTMLTag"].includes(node.name))
      inline.push({ start: span.start + node.from, end: span.start + node.to })
    else for (const child of children(node)) visit(child)
  }

  if (span.kind === "comment") visit(markdownTree(text).topNode)
  let start = span.start
  for (const match of text.matchAll(/[^\n]*\n/gu)) {
    const next = span.start + match.index + match[0].length
    const end = span.start + match.index + match[0].trimEnd().length
    if (
      !endsProseLine(match[0]) ||
      span.protected.some((range) => (range.start < next && range.end > next) || (range.start < end && range.end >= end)) ||
      inline.some((range) => range.start < next && range.end > next)
    )
      continue
    ranges.push({ start, end })
    start = next
  }
  if (!ranges.length) return [span]
  if (start < span.end) ranges.push({ start, end: span.end })
  const tail = ranges.at(-1)!
  if (ranges.length > 1 && !/[\p{L}\p{N}]/u.test(source.slice(tail.start, tail.end))) {
    ranges[ranges.length - 2].end = tail.end
    ranges.pop()
  }
  return ranges.map((part) => {
    // A block-comment continuation owns its star just as a line comment owns its delimiter.
    const prefix = span.kind === "comment" && span.scope.startsWith("comment.block") ? source.slice(part.start, part.end).match(/^[\t ]*(\*(?!\/)[\t ]+)/u) : undefined
    if (prefix) part.start += prefix[0].length - prefix[1].length
    return {
      ...span,
      ...part,
      commentPrefix: prefix ? "*" : span.commentPrefix,
      protected: span.protected.filter((range) => range.start >= part.start && range.end <= part.end)
    }
  })
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
  // An interpreter directive is executable file metadata, not comment prose.
  const paragraphs = commentParagraphs(
    source,
    spans.filter((span) => !(span.kind === "comment" && span.start === (source.charCodeAt(0) === 0xfeff ? 1 : 0) && source.startsWith("#!", span.start)))
  )
  const semantic: readonly (CodeSpan & { readonly literals?: readonly PythonLiteral[] })[] = language === "python" ? joinPythonLiterals(source, paragraphs) : paragraphs
  const regions = semantic
    .flatMap<CodeSpan & { readonly literals?: readonly PythonLiteral[] }>((span) => {
      if (span.literals) return [span]
      const blocks = blockCommentSpans(source, span)
      if (span.kind === "comment" && source.startsWith("<!--", span.start)) return blocks
      return blocks.flatMap((part) => sentenceSpans(source, part))
    })
    .filter((span) => /\p{L}/u.test(source.slice(span.start, span.end)))
    .flatMap((span) => {
      const region: CodeRegion = {
        id: `u${span.start}-${span.end}`,
        start: span.start,
        end: span.end,
        text: source.slice(span.start, span.end),
        content: span.kind === "string" && ["json", "jsonc", "jsonl"].includes(language) ? (JSON.parse(source.slice(span.start, span.end)) as string) : undefined,
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
