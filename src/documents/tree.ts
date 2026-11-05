import type { TextUnit } from "../model/document.ts"
import { parser, GFM } from "@lezer/markdown"
import { angleProseEnd } from "./angleProse.ts"

// XML-style prompt delimiters own one line, not the Markdown up to the next blank line.
function xmlDelimiter(text: string): boolean {
  const tag = text.match(/^<\/?([A-Za-z][\w:.-]*)[\t ]*\/?>[\t ]*$/u)
  return !!tag && /[_:]/u.test(tag[1])
}

const markdown = parser.configure([
  GFM,
  {
    defineNodes: ["AngleProse"],
    parseInline: [
      {
        name: "AngleProse",
        before: "HTMLTag",
        parse(context, next, position) {
          if (next !== 60) return -1
          const end = angleProseEnd(context.text, position - context.offset)
          return end === undefined ? -1 : context.addElement(context.elt("AngleProse", position, end + context.offset))
        }
      }
    ],
    parseBlock: [
      {
        name: "XMLDelimiter",
        before: "HTMLBlock",
        parse(context, line) {
          if (!xmlDelimiter(line.text.slice(line.pos))) return false
          context.addElement(context.elt("HTMLTag", context.lineStart + line.pos, context.lineStart + line.text.trimEnd().length))
          context.nextLine()
          return true
        },
        endLeaf(_context, line) {
          return line.indent < line.baseIndent + 4 && xmlDelimiter(line.text.slice(line.pos))
        }
      }
    ]
  }
])
// Code-comment prose can start with a tag without turning the entire remainder
// into an opaque Markdown HTML block. Keep each tag and its attributes visible.
const inlineHtmlMarkdown = markdown.configure({ remove: ["HTMLBlock"] })

export type MarkdownNode = ReturnType<typeof markdown.parse>["topNode"]

/** A code span owns equal backtick runs; the first matching run must close the whole input. */
export function inlineCodeProcessor(text: string): { delimiter: string; content: string } | undefined {
  let width = 0
  while (text[width] === "`") width++
  if (!width) return
  for (let position = width; position < text.length;) {
    if (text[position] !== "`") {
      position++
      continue
    }
    const start = position
    while (text[position] === "`") position++
    if (position - start !== width) continue
    if (position !== text.length) return
    return { delimiter: text.slice(0, width), content: text.slice(width, start) }
  }
}

export function endsProseLine(text: string): boolean {
  return /[.!?。！？]$/u.test(text.trimEnd())
}

/** Lezer splits lines at LF; exclude CR from parsing without shifting source offsets. */
export function markdownTree(source: string, inlineHtml = false): ReturnType<typeof markdown.parse> {
  const reader = inlineHtml ? inlineHtmlMarkdown : markdown
  const ranges: { from: number; to: number }[] = []
  let from = 0
  for (const match of source.matchAll(/\r(?=\n)/g)) {
    if (match.index > from) ranges.push({ from, to: match.index })
    from = match.index + 1
  }
  if (!from) return reader.parse(source)
  if (from < source.length) ranges.push({ from, to: source.length })
  return reader.parse(source, [], ranges)
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
