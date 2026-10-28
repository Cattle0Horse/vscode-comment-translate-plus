import type { TextUnit } from "../model/document.ts"
import { parser, GFM } from "@lezer/markdown"
const markdown = parser.configure(GFM)

export type MarkdownNode = ReturnType<typeof markdown.parse>["topNode"]

export function endsProseLine(text: string): boolean {
  return /[.!?。！？]$/u.test(text.trimEnd())
}

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

export function normalizeLinkLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toUpperCase()
}

/** Definitions can live outside a translated paragraph or selection. */
export function markdownLinkLabels(source: string, tree = markdownTree(source).topNode): readonly string[] {
  const labels = new Set<string>()

  function visit(node: MarkdownNode): void {
    if (node.name === "LinkReference") {
      const label = children(node).find((child) => child.name === "LinkLabel")
      if (label) labels.add(normalizeLinkLabel(source.slice(label.from + 1, label.to - 1)))
    } else for (const child of children(node)) visit(child)
  }

  visit(tree)
  return [...labels].sort()
}

export function standalone(text: string): string {
  const indent = text.match(/^[\t ]*/)?.[0] ?? ""
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n")
}

export function makeUnit(source: string, start: number, end: number, format: TextUnit["format"]): TextUnit {
  while (end > start && /[\r\n]/.test(source[end - 1])) end--
  return { id: `u${start}-${end}`, start, end, text: source.slice(start, end), format }
}
