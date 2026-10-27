import type { EmbeddedCode, TextUnit } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children } from "./tree.ts"
import { translationLineBreaks } from "./body.ts"
import { SourceMap, sourceOffset } from "./sourceMap.ts"

export function codeBlock(source: string, node: MarkdownNode, offset: number): EmbeddedCode | undefined {
  const nodes = children(node)
  const info = nodes.find((child) => child.name === "CodeInfo")
  const language = info
    ? source
        .slice(offset + info.from, offset + info.to)
        .trim()
        .split(/\s/u)[0]
        .toLowerCase()
    : ""
  if (!language) return
  const opening = offset + node.from
  const column = opening - (source.lastIndexOf("\n", opening - 1) + 1)
  const from = source.indexOf("\n", opening) + 1
  const closing = nodes.at(-1)
  const end = closing?.name === "CodeMark" && closing !== nodes[0] ? source.lastIndexOf("\n", offset + closing.from - 1) + 1 : offset + node.to
  if (!from || from >= end) return
  const mapping = new SourceMap()
  const textNodes = nodes.filter((child) => child.name === "CodeText")
  let text = ""
  let textIndex = 0
  for (let line = from; line < end;) {
    const newline = source.indexOf("\n", line)
    const to = newline < 0 ? end : Math.min(end, newline + 1)
    const lineEnd = to - (source[to - 1] === "\n" ? (source[to - 2] === "\r" ? 2 : 1) : 0)
    while (textNodes[textIndex] && offset + textNodes[textIndex].to <= line) textIndex++
    const candidate = textNodes[textIndex]
    const token = candidate && offset + candidate.from < to ? candidate : undefined
    let start = token ? Math.max(line, offset + token.from) : lineEnd
    while (start < lineEnd && start - line < column && /[\t ]/u.test(source[start])) start++
    mapping.append(to - start, start, to)
    text += source.slice(start, to)
    line = to
  }
  return { start: opening, end: offset + node.to, language, source: text, pieces: mapping.pieces }
}

export function embeddedOffset(block: EmbeddedCode, position: number, end = false): number {
  return sourceOffset(block.pieces, position, end)
}

export function embeddedUnit(source: string, block: EmbeddedCode, unit: TextUnit): TextUnit {
  const start = embeddedOffset(block, unit.start)
  const end = embeddedOffset(block, unit.end, true)
  const prefixes = [...unit.text.matchAll(/\r?\n/gu)].map((match) => {
    const position = unit.start + match.index + match[0].length
    return position === unit.end ? "" : source.slice(embeddedOffset(block, position, true), embeddedOffset(block, position))
  })
  return {
    ...unit,
    id: `u${start}-${end}`,
    start,
    end,
    text: source.slice(start, end),
    // Logical token ranges stay on projection.unit; container prefixes change raw offsets.
    protected: undefined,
    display: unit.display ? { start: embeddedOffset(block, unit.display.start), end: embeddedOffset(block, unit.display.end, true) } : undefined,
    reference: [
      ...(unit.reference ?? []).map((reference) => {
        if (!reference.range) return reference
        const from = embeddedOffset(block, reference.range.start)
        const to = embeddedOffset(block, reference.range.end, true)
        return {
          ...reference,
          text: source.slice(from, to),
          range: { start: from, end: to, container: embeddedOffset(block, reference.range.container) },
          group: reference.group === undefined ? undefined : embeddedOffset(block, reference.group),
          alternative: reference.alternative === undefined ? undefined : embeddedOffset(block, reference.alternative)
        }
      }),
      ...(block.reference ?? [])
    ],
    scope: "embedded:" + block.start + ":" + (unit.scope ?? ""),
    language: unit.language ?? (unit.format === "yaml" ? "yaml" : unit.format === "markdown" ? "markdown" : block.language),
    projection: { kind: "container", unit, prefixes }
  }
}

/** Remove only source-owned container prefixes; unknown prefixes fail closed. */
export function unembedTranslation(unit: TextUnit, text: string): string {
  const projection = unit.projection
  if (projection?.kind !== "container") throw Error("translation-structure-invalid")
  if (text === unit.text) return projection.unit.text
  if (unit.format === "yaml" && /^"(?:[^"\\\r\n]|\\.)*"(?:\r?\n)*$/u.test(text)) return text
  const retained = translationLineBreaks(projection.unit)
  const prefixes = projection.prefixes.filter((_, index) => retained[index])
  let index = 0
  const logical = text.replace(/\r?\n[^\r\n]*/gu, (line) => {
    const newline = line.startsWith("\r\n") ? "\r\n" : "\n"
    const prefix = prefixes[index++]
    if (prefix === undefined || !line.slice(newline.length).startsWith(prefix)) throw Error("translation-structure-invalid")
    return newline + line.slice(newline.length + prefix.length)
  })
  if (index !== prefixes.length) throw Error("translation-structure-invalid")
  return logical
}

export function embedTranslation(unit: TextUnit, text: string): string {
  const projection = unit.projection
  if (projection?.kind !== "container") throw Error("translation-structure-invalid")
  if (text === projection.unit.text) return unit.text
  if (unit.format === "yaml" && /^"(?:[^"\\\r\n]|\\.)*"(?:\r?\n)*$/u.test(text)) return text
  const retained = translationLineBreaks(projection.unit)
  const prefixes = projection.prefixes.filter((_, index) => retained[index])
  let index = 0
  const result = text.replace(/\r?\n/gu, (newline) => {
    const prefix = prefixes[index++]
    if (prefix === undefined) throw Error("translation-structure-invalid")
    return newline + prefix
  })
  if (index !== prefixes.length) throw Error("translation-structure-invalid")
  return result
}
