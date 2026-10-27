import type { TextUnit } from "../model/document.ts"
import { parseMarkdown } from "./markdown.ts"
import { sourceReferences } from "./references.ts"

interface Literal {
  readonly start: number
  readonly end: number
  readonly protected: readonly { readonly start: number; readonly end: number }[]
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

function expressionSyntax(expression: string, syntax: NonNullable<TextUnit["pythonString"]>): string {
  if (syntax.formatted) return expression
  // An interpolation from a later f-string must remain executable when the paragraph starts in a plain literal.
  return syntax.quote + " f" + syntax.quote + expression + syntax.quote + " " + (syntax.raw ? "r" : "") + syntax.quote
}

function encode(text: string, syntax: NonNullable<TextUnit["pythonString"]>): string {
  let output = ""
  let cursor = 0
  for (const expression of [...syntax.expressions, ""]) {
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

export function restorePythonString(unit: TextUnit, text: string): string {
  const syntax = unit.pythonString!
  if (text === syntax.unit.text) return unit.text
  return syntax.prefix + encode(text, syntax) + syntax.continuation
}

export function pythonStringContent(unit: TextUnit, translated: string): string {
  const syntax = unit.pythonString!
  if (translated === unit.text) return syntax.unit.text
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
  decode(body, syntax.raw, syntax.formatted, expressions, (value, _from, _to, protectedToken) => {
    const index = protectedToken ? expressions.indexOf(value) : -1
    result += index < 0 ? value : syntax.expressions[index]
  })
  for (const range of syntax.unit.protected ?? []) {
    const value = syntax.unit.text.slice(range.start, range.end)
    if (result.split(value).length !== syntax.unit.text.split(value).length) throw Error("translation-structure-invalid")
  }
  return result
}

/** Paragraphs, list items and docstring fields own their continuations; labels own no following prose. */
function proseBlocks(text: string, protectedRanges: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = []
  const multiline = protectedRanges.filter((range) => /[\r\n]/u.test(text.slice(range.start, range.end)))
  let current: { start: number; end: number } | undefined
  let exampleIndent: number | undefined
  let fence: string | undefined
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0].replace(/\r?\n$/u, "")
    const indent = line.match(/^[\t ]*/u)![0].length
    const content = line.trim()
    if (multiline.some((range) => range.start < match.index + match[0].length && range.end > match.index)) {
      if (!current) {
        current = { start: match.index, end: match.index + line.length }
        blocks.push(current)
      } else current.end = match.index + line.length
      continue
    }
    if (!content) {
      current = undefined
      continue
    }
    if (exampleIndent !== undefined && indent > exampleIndent) {
      current = undefined
      continue
    }
    exampleIndent = undefined
    const mark = content.match(/^(`{3,}|~{3,})/u)?.[0]
    if (fence || mark) {
      if (fence && mark?.[0] === fence[0] && mark.length >= fence.length) fence = undefined
      else if (!fence) fence = mark
      current = undefined
      continue
    }
    const label = /^[\p{L}\w /-]+:[\t ]*$/u.test(content)
    const field = /^(?:\*{0,2}[\w]+(?:[\t ]+\([^)]*\))?):[\t ]+\S/u.test(content)
    const list = /^(?:[-+*]|\d+[.)])[\t ]+/u.test(content)
    if (content.startsWith(">>>")) {
      current = undefined
      continue
    }
    if (!current || label || field || list) {
      current = { start: match.index, end: match.index + line.length }
      blocks.push(current)
    } else current.end = match.index + line.length
    if (label) {
      current = undefined
      if (/^(?:examples?|usage):$/iu.test(content)) exampleIndent = indent
    }
  }
  return blocks
}

export function pythonStringUnits(source: string, region: TextUnit, literals: readonly Literal[]): (TextUnit & { readonly kind: "string" })[] {
  let text = ""
  const positions: { start: number; end: number; literal: number }[] = []
  const protectedRanges: { start: number; end: number }[] = []
  const expressionRanges: { start: number; end: number; text: string }[] = []
  const formats: { quote: string; raw: boolean; formatted: boolean; opener: string }[] = []
  for (const [index, literal] of literals.entries()) {
    const original = source.slice(literal.start, literal.end)
    const opening = original.match(/^([rRuUbBfF]*)("""|'''|"|')/u)
    if (!opening || /b/iu.test(opening[1]) || !original.endsWith(opening[2])) return []
    const start = literal.start + opening[0].length
    const end = literal.end - opening[2].length
    const formatted = /f/iu.test(opening[1])
    const expressions = formatted
      ? literal.protected.flatMap((range) => {
          const value = source.slice(Math.max(start, range.start), Math.min(end, range.end))
          return value.startsWith("{") && value.endsWith("}") && !value.startsWith("{{") ? [value] : []
        })
      : []
    formats.push({ quote: opening[2], raw: /r/iu.test(opening[1]), formatted, opener: opening[0] })
    decode(source.slice(start, end), /r/iu.test(opening[1]), formatted, expressions, (value, from, to, protectedToken) => {
      if (protectedToken) protectedRanges.push({ start: text.length, end: text.length + value.length })
      if (protectedToken && expressions.includes(value)) expressionRanges.push({ start: text.length, end: text.length + value.length, text: value })
      text += value
      for (let character = 0; character < value.length; character++) positions.push({ start: start + from, end: start + to, literal: index })
    })
  }
  const blocks = proseBlocks(text, protectedRanges)
  const units: (TextUnit & { readonly kind: "string" })[] = []
  for (const block of blocks) {
    const raw = text.slice(block.start, block.end)
    const lines = [...raw.matchAll(/[^\n]*(?:\n|$)/gu)].filter((match) => match[0])
    const indent = Math.min(...lines.filter((line) => line[0].trim()).map((line) => line[0].match(/^[\t ]*/u)![0].length))
    let logical = ""
    const offsets: number[] = []
    for (const line of lines) {
      const position = block.start + line.index
      const remove = protectedRanges.some((range) => range.start < position && range.end > position) ? 0 : Math.min(indent, line[0].match(/^[\t ]*/u)![0].length)
      logical += line[0].slice(remove)
      for (let index = remove; index < line[0].length; index++) offsets.push(block.start + line.index + index)
    }
    const parsed = parseMarkdown(logical)
    for (const inner of parsed.groups.flatMap((group) => group.units)) {
      const first = positions[offsets[inner.start]]
      const last = positions[offsets[inner.end - 1]]
      if (!first || !last) continue
      const firstFormat = formats[first.literal]
      const lastFormat = formats[last.literal]
      const start = inner.start === 0 ? positions[block.start].start : first.start
      const end = last.end
      const unit: TextUnit = {
        ...inner,
        language: "python",
        protected: protectedRanges.flatMap((range) => {
          const from = offsets.indexOf(range.start, inner.start)
          const to = offsets.indexOf(range.end - 1, inner.start)
          return from >= inner.start && to < inner.end && to >= from ? [{ start: from - inner.start, end: to - inner.start + 1 }] : []
        })
      }
      const expressions = expressionRanges.filter((range) => range.start >= offsets[inner.start] && range.end <= offsets[inner.end - 1] + 1).map((range) => range.text)
      // If a paragraph crosses unlike literals, reopen the final literal for the untouched suffix.
      const transition = firstFormat.opener === lastFormat.opener ? "" : firstFormat.quote + " " + lastFormat.opener
      units.push({
        ...region,
        kind: "string",
        id: `u${start}-${end}`,
        start,
        end,
        text: source.slice(start, end),
        reference: sourceReferences(source, { start, end }, "python"),
        protected: expressionRanges
          .filter((range) => range.start >= offsets[inner.start] && range.end <= offsets[inner.end - 1] + 1)
          .map((range) => ({ start: positions[range.start].start - start, end: positions[range.end - 1].end - start })),
        pythonString: {
          unit,
          prefix: source.slice(start, first.start),
          continuation: transition,
          quote: firstFormat.quote,
          raw: firstFormat.raw,
          formatted: firstFormat.formatted,
          expressions
        }
      })
    }
  }
  return units
}
