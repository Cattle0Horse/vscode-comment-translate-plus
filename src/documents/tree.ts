import type { TextUnit } from "../model/document.ts"
import { parser, GFM } from "@lezer/markdown"
const markdown = parser.configure(GFM)

export type MarkdownNode = ReturnType<typeof markdown.parse>["topNode"]

/** Lezer splits lines at LF; exclude CR from parsing without shifting source offsets. */
export function markdownTree(source: string): ReturnType<typeof markdown.parse> {
  const ranges: { from: number; to: number }[] = []
  let from = 0
  for (const match of source.matchAll(/\r(?=\n)/g)) {
    if (match.index > from) ranges.push({ from, to: match.index })
    from = match.index + 1
  }
  if (!from) return markdown.parse(source)
  if (from < source.length) ranges.push({ from, to: source.length })
  return markdown.parse(source, [], ranges)
}

export function children(node: MarkdownNode): MarkdownNode[] {
  const values: MarkdownNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) values.push(child)
  return values
}

export function standalone(text: string): string {
  const indent = text.match(/^[\t ]*/)?.[0] ?? ""
  return indent
    ? text
        .split(/\r?\n/)
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join("\n")
    : text
}

export function makeUnit(source: string, start: number, end: number, format: TextUnit["format"]): TextUnit {
  while (end > start && /[\r\n]/.test(source[end - 1])) end--
  return { id: `u${start}-${end}`, start, end, text: source.slice(start, end), format }
}
