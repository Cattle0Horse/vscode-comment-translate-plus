import { parseDocument } from "yaml"
import type { TextUnit, TextGroup, ParsedDocument, EmbeddedCode, ReferenceBlock } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { markdownTree, children, makeUnit } from "./tree.ts"
import { yamlUnits } from "./yaml.ts"
import { codeBlock, embeddedUnit, embeddedOffset } from "./embedding.ts"

function prose(node: MarkdownNode, source: string): boolean {
  const excluded: MarkdownNode[] = []

  function visit(current: MarkdownNode): void {
    if (["InlineCode", "URL", "HTMLTag"].includes(current.name)) excluded.push(current)
    else for (const child of children(current)) visit(child)
  }

  visit(node)
  let cursor = node.from
  for (const range of excluded) {
    if (/\p{L}/u.test(source.slice(cursor, range.from))) return true
    cursor = range.to
  }
  return /\p{L}/u.test(source.slice(cursor, node.to))
}

function startWithPrefix(source: string, start: number): number {
  const line = source.lastIndexOf("\n", start - 1) + 1
  const prefix = source.slice(line, start)
  return /^[\t >]*(?:(?:[-+*]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?)?$/.test(prefix) ? line : start
}

export function parseMarkdown(source: string): ParsedDocument {
  const groups: TextGroup[] = []
  const errors: string[] = []
  const codeBlocks: EmbeddedCode[] = []
  let bodyStart = 0
  const opening = source.match(/^\uFEFF?---[\t ]*\r?\n/)
  if (opening) {
    const delimiter = /^---[\t ]*\r?$/gm
    delimiter.lastIndex = opening[0].length
    const closing = delimiter.exec(source)
    if (!closing) return { source, groups, errors: ["frontmatter-incomplete"] }
    bodyStart = closing.index + closing[0].length
    try {
      const units = yamlUnits(source, opening[0].length, parseDocument(source.slice(opening[0].length, closing.index), { strict: true }))
      if (units.length) groups.push({ start: 0, end: bodyStart, units })
    } catch {
      errors.push("frontmatter-invalid")
    }
  }
  const body = source.slice(bodyStart)
  const parsed = markdownTree(body)
  const headings: { level: number; node: MarkdownNode }[] = []
  const blocks = children(parsed.topNode)
  const titleNode = blocks.find((node) => /^(?:ATX|Setext)Heading1$/.test(node.name))
  const documentLead = blocks[0]?.name === "Paragraph" && blocks.some((node) => /Heading[1-6]$/.test(node.name)) ? blocks[0] : undefined

  function reference(kind: string, node: { from: number; to: number }, container: number): ReferenceBlock {
    const start = startWithPrefix(source, bodyStart + node.from)
    const end = bodyStart + node.to + (body.slice(node.to).match(/^\r?\n/)?.[0].length ?? 0)
    return { kind, text: source.slice(start, end), range: { start, end, container } }
  }

  function headingExplanation(node: MarkdownNode): MarkdownNode | undefined {
    const next = node.nextSibling
    if (next?.name === "Paragraph") return next
    if (next?.name !== "BulletList" && next?.name !== "OrderedList") return
    const item = next.firstChild
    return item?.name === "ListItem" ? children(item).find((child) => child.name === "Paragraph" || child.name === "Task") : undefined
  }

  function neighbouringBlocks(node: MarkdownNode): ReferenceBlock[] {
    if (node.name !== "Paragraph" && node.name !== "Task") return []
    const item = node.parent?.name === "ListItem" ? node.parent : undefined
    const anchor = item && children(item).find((child) => child.name === "Paragraph" || child.name === "Task")?.from === node.from ? item : node
    const matches = (other: MarkdownNode | null): other is MarkdownNode =>
      !!other && (anchor.name === "ListItem" ? other.name === "ListItem" : other.name === "Paragraph" || other.name === "Task")
    const windows: ReferenceBlock[] = []
    for (const [before, after] of [
      [2, 2],
      [1, 1],
      [1, 0],
      [0, 1]
    ]) {
      let first = anchor
      let last = anchor
      for (let index = 0; index < before && matches(first.prevSibling); index++) first = first.prevSibling!
      for (let index = 0; index < after && matches(last.nextSibling); index++) last = last.nextSibling!
      if (first.from === anchor.from && last.to === anchor.to) continue
      windows.push({ ...reference("Neighbouring blocks", { from: first.from, to: last.to }, bodyStart + (anchor.parent?.from ?? 0)), alternative: bodyStart + node.from })
    }
    return windows
  }

  function referencesFor(node: MarkdownNode, parentItems: readonly MarkdownNode[], container: number, headingPath: typeof headings): ReferenceBlock[] {
    const level = Number(node.name.match(/Heading([1-6])$/)?.[1])
    const parents = level ? headingPath.filter((heading) => heading.level < level) : headingPath
    const references: ReferenceBlock[] = []
    for (const parent of parentItems.slice().reverse()) references.push(reference("Parent list item", parent, container))
    for (const heading of parents.slice().reverse()) {
      if (heading.node.nextSibling?.name === "Paragraph") references.push(reference("Section introduction", heading.node.nextSibling, bodyStart))
      if (heading.node.from !== titleNode?.from) references.push(reference("Section", heading.node, bodyStart))
    }
    if (titleNode && titleNode.from < node.from) references.push(reference("Document title", titleNode, bodyStart))
    if (documentLead && documentLead.from < node.from) references.push(reference("Document introduction", documentLead, bodyStart))
    return references
  }

  for (const block of blocks) {
    const start = bodyStart + block.from
    const end = bodyStart + block.to
    const units: TextUnit[] = []

    function visit(node: MarkdownNode, parentItems: readonly MarkdownNode[] = [], headingPath = headings): void {
      if (node.name === "FencedCode") {
        const block = codeBlock(source, node, bodyStart)
        if (block) codeBlocks.push({ ...block, reference: referencesFor(node, parentItems, start, headingPath) })
        return
      }
      if (node.name === "ListItem") {
        const nodes = children(node)
        const own = nodes.find((child) => child.name === "Paragraph" || child.name === "Task")
        const itemHeadings = headingPath.slice()
        for (const child of nodes) visit(child, child === own || !own ? parentItems : [...parentItems, own], itemHeadings)
        return
      }
      const level = Number(node.name.match(/Heading([1-6])$/)?.[1])
      if ((["Paragraph", "Task", "TableCell"].includes(node.name) || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) && prose(node, body)) {
        const unit = makeUnit(source, startWithPrefix(source, bodyStart + node.from), bodyStart + node.to, "markdown")
        const parents = level ? headingPath.filter((heading) => heading.level < level) : headingPath
        const references: ReferenceBlock[] = []
        const explanation = level ? headingExplanation(node) : undefined
        if (node.name === "TableCell" && node.parent) {
          const table = node.parent.parent!
          const header = table.firstChild
          let delimiter = header?.nextSibling
          while (delimiter && delimiter.name !== "TableDelimiter") delimiter = delimiter.nextSibling
          const ranges = header ? [{ from: header.from, to: delimiter?.to ?? header.to }] : []
          if (!header || header.from !== node.parent.from) ranges.push(node.parent)
          for (const range of ranges) references.push({ ...reference("Table", range, bodyStart + table.from), group: bodyStart + node.parent.from })
        }
        const ancestry = referencesFor(node, parentItems, start, headingPath)
        references.push(...ancestry.slice(0, parentItems.length))
        references.push(...neighbouringBlocks(node))
        if (explanation && prose(explanation, body)) references.push(reference("Section introduction", explanation, bodyStart + (node.parent?.from ?? 0)))
        references.push(...ancestry.slice(parentItems.length))
        const listParent = parentItems.at(-1) ?? (node.parent?.name === "ListItem" ? node.parent.parent : undefined)
        units.push({
          ...unit,
          reference: references,
          scope:
            node.name === "TableCell"
              ? "table:" + (bodyStart + node.parent!.parent!.from)
              : listParent
                ? "list:" + (bodyStart + listParent.from)
                : "markdown:" + (bodyStart + (level ? node.from : (parents.at(-1)?.node.from ?? 0))) + ":" + (bodyStart + (node.parent?.from ?? 0)),
          ...(node.name === "TableCell" && node.parent ? { display: { start: bodyStart + node.parent.from, end: bodyStart + node.parent.to } } : {})
        })
      } else if (!["FencedCode", "CodeBlock", "HTMLBlock", "LinkReference"].includes(node.name)) {
        const childHeadings = headingPath.slice()
        for (const child of children(node)) visit(child, parentItems, childHeadings)
      }
      if (level) {
        while (headingPath.length && headingPath.at(-1)!.level >= level) headingPath.pop()
        headingPath.push({ level, node })
      }
    }

    visit(block)
    if (units.length) groups.push({ start, end, units })
  }
  return { source, groups, errors, codeBlocks }
}

/** Parse every fence through the same language parser, keeping exact source ownership. */
export async function parseMarkdownWithCode(
  source: string,
  parseCode: (source: string, language: string) => Promise<ParsedDocument>,
  resolveLanguage: (language: string) => string = (language) => language
): Promise<ParsedDocument> {
  const parsed = parseMarkdown(source)
  const groups = [...parsed.groups]
  const errors = [...parsed.errors]
  const blocks: EmbeddedCode[] = []
  for (const raw of parsed.codeBlocks ?? []) {
    const block = { ...raw, language: resolveLanguage(raw.language) }
    const inner = await parseCode(block.source, block.language)
    blocks.push({ ...block, parsed: inner })
    errors.push(...inner.errors)
    for (const group of inner.groups) {
      const units = group.units.map((unit) => embeddedUnit(source, block, unit))
      if (units.length) groups.push({ start: embeddedOffset(block, group.start), end: embeddedOffset(block, group.end, true), units })
    }
  }
  return { source, groups: groups.sort((a, b) => a.start - b.start), errors, codeBlocks: blocks }
}
