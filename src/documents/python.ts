import { proseBlocks } from "./prose.ts"
import type { TextUnit } from "../model/document.ts"
import { parseMarkdown } from "./markdown.ts"
import { sourceReferences } from "./references.ts"
import { SourceMap } from "./sourceMap.ts"
import { endsProseLine, markdownTree, children } from "./tree.ts"
import type { MarkdownNode } from "./tree.ts"
import type { CodeSpan, RegionToken, SourceToken } from "./tokenization.ts"
import { regionToken } from "./tokenization.ts"

/** Python's interpolation scopes and grouping depth belong to its literal syntax. */
export function* pythonTokens(source: string, tokens: Iterable<SourceToken>): Iterable<RegionToken> {
  let depth = 0
  for (const token of tokens) {
    const fstring = token.scopes.includes("meta.fstring.python")
    const classified = regionToken(token, fstring ? "string.interpolated.python" : undefined)
    if (!classified) {
      for (const character of source.slice(token.start, token.end)) {
        if ("([{".includes(character)) depth++
        else if (")]}".includes(character)) depth--
      }
      continue
    }
    const expression = fstring && (!token.scopes.includes("string.interpolated.python") || token.scopes.filter((scope) => scope === "meta.fstring.python").length > 1)
    yield {
      ...classified,
      depth,
      complete: token.scopes.includes("punctuation.definition.string.end.python") && !expression,
      protected: classified.protected || expression || token.scopes.includes("storage.type.string.python")
    }
  }
}

export function joinPythonLiterals(source: string, spans: readonly CodeSpan[]): readonly (CodeSpan & { readonly literals?: readonly PythonLiteral[] })[] {
  const joined: (CodeSpan & { literals?: PythonLiteral[] })[] = []
  for (const next of spans) {
    const previous = joined.at(-1)
    const gap = previous ? source.slice(previous.end, next.start) : ""
    const adjacent = /^[\t ]*(?:\\\r?\n[\t ]*|\r?\n[\t ]*)*$/u.test(gap) && (!/[\r\n]/u.test(gap) || (previous?.depth ?? 0) > 0 || /\\\r?\n/u.test(gap))
    if (previous?.kind === "string" && next.kind === "string" && previous.depth === next.depth && adjacent) {
      previous.literals!.push(next)
      previous.end = next.end
    } else joined.push({ ...next, literals: next.kind === "string" ? [next] : undefined })
  }
  return joined
}

export interface PythonLiteral {
  readonly start: number
  readonly end: number
  readonly protected: readonly { readonly start: number; readonly end: number }[]
}

interface LiteralSyntax {
  readonly unit: TextUnit
  readonly prefix: string
  readonly continuation: string
  readonly quote: string
  readonly raw: boolean
  readonly formatted: boolean
  readonly expressions: readonly string[]
}

const escapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'" }
const encodedEscapes: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(escapes).map(([code, value]) => [value, "\\" + code]))

/** Decode without evaluating Python or interpreting f-string expressions. */
function decode(text: string, raw: boolean, formatted: boolean, expressions: readonly string[], emit: (value: string, start: number, end: number, protectedToken: boolean) => void): void {
  let expressionIndex = 0
  for (let cursor = 0; cursor < text.length;) {
    const start = cursor
    const expression = expressions[expressionIndex]
    if (expression && text.startsWith(expression, cursor)) {
      emit(expression, cursor, cursor + expression.length, true)
      cursor += expression.length
      expressionIndex++
      continue
    }
    if (formatted && (text.startsWith("{{", cursor) || text.startsWith("}}", cursor))) {
      emit(text[cursor], cursor, cursor + 2, false)
      cursor += 2
      continue
    }
    if (!raw && text[cursor] === "\\" && cursor + 1 < text.length) {
      const next = text[cursor + 1]
      const hex = text.slice(cursor).match(/^\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|([0-7]{1,3}))/u)
      if (hex) {
        const value = Number.parseInt(hex[1] ?? hex[2] ?? hex[3] ?? hex[4], hex[4] ? 8 : 16)
        if (value > 0x10ffff) throw Error("translation-structure-invalid")
        cursor += hex[0].length
        emit(String.fromCodePoint(value), start, cursor, true)
        continue
      }
      if (next === "\n" || (next === "\r" && text[cursor + 2] === "\n")) {
        cursor += next === "\n" ? 2 : 3
        continue
      }
      if (Object.hasOwn(escapes, next)) {
        cursor += 2
        emit(escapes[next], start, cursor, next !== "n" && next !== "r")
        continue
      }
      // Named Unicode escapes require Python's Unicode database. Keep their spelling native.
      const named = text.slice(cursor).match(/^\\N\{[^}]+\}/u)?.[0]
      if (named) {
        cursor += named.length
        emit(named, start, cursor, true)
        continue
      }
    }
    emit(text[cursor], cursor, cursor + 1, false)
    cursor++
  }
  if (expressionIndex !== expressions.length) throw Error("translation-structure-invalid")
}

function expressionSyntax(expression: string, syntax: LiteralSyntax): string {
  if (syntax.formatted) return expression
  // An interpolation from a later f-string must remain executable when the paragraph starts in a plain literal.
  return syntax.quote + " f" + syntax.quote + expression + syntax.quote + " " + (syntax.raw ? "r" : "") + syntax.quote
}

/** Match only complete source-owned expressions, retaining exact multiplicity. */
function expressionOrder(text: string, expressions: readonly string[]): string[] {
  if (!expressions.length) return []
  const pattern = [...new Set(expressions)]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|")
  const ordered = [...text.matchAll(new RegExp(pattern, "gu"))].map((match) => match[0])
  const expected = [...expressions].sort()
  const actual = [...ordered].sort()
  if (actual.length !== expected.length || actual.some((expression, index) => expression !== expected[index])) throw Error("translation-structure-invalid")
  return ordered
}

function encode(text: string, syntax: LiteralSyntax): string {
  let output = ""
  let cursor = 0
  for (const expression of [...expressionOrder(text, syntax.expressions), ""]) {
    const end = expression ? text.indexOf(expression, cursor) : text.length
    if (end < cursor) throw Error("translation-structure-invalid")
    const prose = text.slice(cursor, end)
    let encoded: string
    if (syntax.raw) encoded = prose
    else {
      encoded = prose.replace(/\\N\{[^}]+\}|[\s\S]/gu, (value) => {
        if (value.startsWith("\\N{")) return value
        if (value === '"' || value === "'") return syntax.quote[0] === value ? "\\" + value : value
        if (encodedEscapes[value]) return encodedEscapes[value]
        const code = value.charCodeAt(0)
        if (code < 32 || code === 127) return "\\x" + code.toString(16).padStart(2, "0")
        if (value.length === 1 && code >= 0xd800 && code <= 0xdfff) return "\\u" + code.toString(16)
        return value
      })
    }
    output +=
      (syntax.formatted ? encoded.replace(/\\N\{[^}]+\}|[{}]/gu, (brace) => (brace.length === 1 ? brace + brace : brace)) : encoded) +
      (expression ? expressionSyntax(expression, syntax) : "")
    cursor = end + expression.length
  }
  return output
}

function restoreString(original: string, syntax: LiteralSyntax, text: string): string {
  if (text === syntax.unit.text) return original
  return syntax.prefix + encode(text, syntax) + syntax.continuation
}

function stringContent(original: string, syntax: LiteralSyntax, translated: string): string {
  if (translated === original) return syntax.unit.text
  const suffix = syntax.continuation
  if (!translated.startsWith(syntax.prefix) || !translated.endsWith(suffix) || translated.length < syntax.prefix.length + suffix.length) throw Error("translation-structure-invalid")
  const body = translated.slice(syntax.prefix.length, translated.length - suffix.length)
  const expressions = syntax.expressions.map((expression) => expressionSyntax(expression, syntax))
  // A local serializer may escape quotes; a model cannot close the source literal.
  for (let index = 0; index < body.length; index++) {
    const expression = expressions.find((value) => body.startsWith(value, index))
    if (expression) {
      index += expression.length - 1
      continue
    }
    if (body[index] === "\\") {
      if (index === body.length - 1) throw Error("translation-structure-invalid")
      index++
      continue
    }
    if (body.startsWith(syntax.quote, index) || (syntax.quote.length === 1 && /[\r\n]/u.test(body[index]))) throw Error("translation-structure-invalid")
  }
  let result = ""
  decode(body, syntax.raw, syntax.formatted, expressionOrder(body, expressions), (value, _from, _to, protectedToken) => {
    const index = protectedToken ? expressions.indexOf(value) : -1
    result += index < 0 ? value : syntax.expressions[index]
  })
  for (const range of syntax.unit.protected ?? []) {
    const value = syntax.unit.text.slice(range.start, range.end)
    if (result.split(value).length !== syntax.unit.text.split(value).length) throw Error("translation-structure-invalid")
  }
  return result
}

export function pythonStringUnits(source: string, region: TextUnit, literals: readonly PythonLiteral[]): (TextUnit & { readonly kind: "string" })[] {
  let text = ""
  const positions = new SourceMap()
  const protectedRanges: { start: number; end: number }[] = []
  const expressionRanges: { start: number; end: number; text: string }[] = []
  const formats: { quote: string; raw: boolean; formatted: boolean; opener: string }[] = []
  const sentenceBoundaries = new Set<number>()
  for (const [index, literal] of literals.entries()) {
    const previous = literals[index - 1]
    if (previous && /[\r\n]/u.test(source.slice(previous.end, literal.start)) && endsProseLine(text)) sentenceBoundaries.add(text.length)
    const original = source.slice(literal.start, literal.end)
    const opening = original.match(/^([rRuUbBfF]*)("""|'''|"|')/u)
    if (!opening || /b/iu.test(opening[1]) || !original.endsWith(opening[2])) return []
    const start = literal.start + opening[0].length
    const end = literal.end - opening[2].length
    const raw = /r/iu.test(opening[1])
    const formatted = /f/iu.test(opening[1])
    const expressions = formatted
      ? literal.protected.flatMap((range) => {
          const value = source.slice(Math.max(start, range.start), Math.min(end, range.end))
          return value.startsWith("{") && value.endsWith("}") && !value.startsWith("{{") ? [value] : []
        })
      : []
    formats.push({ quote: opening[2], raw, formatted, opener: opening[0] })
    decode(source.slice(start, end), raw, formatted, expressions, (value, from, to, protectedToken) => {
      if (protectedToken) protectedRanges.push({ start: text.length, end: text.length + value.length })
      if (protectedToken && expressions.includes(value)) expressionRanges.push({ start: text.length, end: text.length + value.length, text: value })
      text += value
      positions.append(value.length, start + from, start + to)
    })
  }

  // A source-line boundary can end prose, but cannot cut syntax spanning adjacent literals.
  function protectInline(node: MarkdownNode): void {
    if (["InlineCode", "Link", "Image", "Emphasis", "StrongEmphasis", "Strikethrough", "HTMLTag", "FencedCode", "CodeBlock", "HTMLBlock"].includes(node.name)) {
      for (const boundary of sentenceBoundaries) if (node.from < boundary && node.to > boundary) sentenceBoundaries.delete(boundary)
    } else for (const child of children(node)) protectInline(child)
  }

  if (sentenceBoundaries.size) protectInline(markdownTree(text).topNode)
  const blocks = proseBlocks(text, protectedRanges).flatMap((block) => {
    const starts = [block.start, ...[...sentenceBoundaries].filter((boundary) => boundary > block.start && boundary < block.end)]
    return starts.map((start, index) => ({ start, end: starts[index + 1] ?? block.end }))
  })
  const units: (TextUnit & { readonly kind: "string" })[] = []
  let previousDecodedEnd = 0
  for (const block of blocks) {
    const raw = text.slice(block.start, block.end)
    const lines = [...raw.matchAll(/[^\n]*(?:\n|$)/gu)]
      .filter((match) => match[0])
      .map((match) => ({
        text: match[0],
        start: block.start + match.index,
        indent: match[0].match(/^[\t ]*/u)![0].length
      }))
    const indent = Math.min(...lines.filter((line) => line.text.trim()).map((line) => line.indent))
    let logical = ""
    const offsets = new SourceMap()
    for (const line of lines) {
      const remove = protectedRanges.some((range) => range.start < line.start && range.end > line.start) ? 0 : Math.min(indent, line.indent)
      logical += line.text.slice(remove)
      offsets.append(line.text.length - remove, line.start + remove, line.start + line.text.length)
    }
    const parsed = parseMarkdown(logical)
    for (const inner of parsed.groups.flatMap((group) => group.units)) {
      const decoded = offsets.range(inner.start, inner.end)
      const mapped = positions.range(decoded.start, decoded.end)
      const firstLiteral = literals.findIndex((literal) => literal.start <= mapped.start && literal.end > mapped.start)
      const lastLiteral = literals.findIndex((literal) => literal.start < mapped.end && literal.end >= mapped.end)
      if (firstLiteral < 0 || lastLiteral < 0) throw Error("translation-structure-invalid")
      const firstFormat = formats[firstLiteral]
      const lastFormat = formats[lastLiteral]
      const start = inner.start === 0 ? positions.offset(block.start) : mapped.start
      const end = mapped.end
      const unit: TextUnit = {
        ...inner,
        language: "python",
        protected: protectedRanges.flatMap((range) => {
          const from = offsets.logical(range.start)
          const to = offsets.logical(range.end, true)
          return from !== undefined && to !== undefined && from >= inner.start && to <= inner.end && to > from ? [{ start: from - inner.start, end: to - inner.start }] : []
        })
      }
      const expressions = expressionRanges.filter((range) => range.start >= decoded.start && range.end <= decoded.end)
      // If a paragraph crosses unlike literals, reopen the final literal for the untouched suffix.
      const transition = firstFormat.opener === lastFormat.opener ? "" : firstFormat.quote + " " + lastFormat.opener
      const original = source.slice(start, end)
      const syntax: LiteralSyntax = {
        unit,
        prefix: source.slice(start, mapped.start),
        continuation: transition,
        quote: firstFormat.quote,
        raw: firstFormat.raw,
        formatted: firstFormat.formatted,
        expressions: expressions.map((range) => range.text)
      }
      units.push({
        ...region,
        kind: "string",
        id: `u${start}-${end}`,
        start,
        end,
        text: original,
        reference: sourceReferences(source, { start, end }, "python"),
        protected: expressions.map((range) => ({ start: positions.offset(range.start) - start, end: positions.offset(range.end, true) - start })),
        projection: {
          kind: "literal",
          unit,
          preceding: units.length ? { id: units.at(-1)!.id, text: text.slice(previousDecodedEnd, decoded.start) } : undefined,
          codec: {
            identity: JSON.stringify([syntax.prefix, transition, syntax.quote, syntax.raw, syntax.formatted, syntax.expressions]),
            invalid: {
              reason: "The response changed Python string syntax.",
              instruction: "Translate only the requested prose; preserve string escapes and interpolations.",
              difference: { reason: "译文破坏了 Python 字符串语法或插值。" }
            },
            restore: (text) => restoreString(original, syntax, text),
            content: (text) => stringContent(original, syntax, text),
            display: (text) => syntax.prefix + stringContent(original, syntax, text)
          }
        }
      })
      previousDecodedEnd = decoded.end
    }
  }
  return units
}
