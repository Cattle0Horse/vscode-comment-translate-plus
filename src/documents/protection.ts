import type { TextUnit, ProtectedFragment } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree, standalone } from "./tree.ts"

/** Shortcut/collapsed references derive their lookup target from the visible label. */
export function labelReference(node: MarkdownNode, source: string): boolean {
  return (
    (node.name === "Link" || node.name === "Image") &&
    !children(node).some(
      (child) =>
        child.name === "URL" || (child.name === "LinkMark" && source.slice(child.from, child.to) === "(") || (child.name === "LinkLabel" && source.slice(child.from, child.to) !== "[]")
    )
  )
}

export function protectedFragments(unit: TextUnit, tree?: MarkdownNode): readonly ProtectedFragment[] {
  if (unit.format === "yaml") return []
  const input = standalone(unit.text)
  let fragments: ProtectedFragment[] = []
  const lines: { input: number; source: number }[] = []
  if (input !== unit.text) {
    const indent = unit.text.match(/^[\t ]*/)?.[0] ?? ""
    let source = 0
    let offset = 0
    for (const line of unit.text.split("\n")) {
      const removed = line.startsWith(indent) ? indent.length : 0
      lines.push({ input: offset, source: source + removed })
      source += line.length + 1
      offset += line.replace(/\r$/, "").length - removed + 1
    }
  }

  function original(offset: number): number {
    if (!lines.length) return offset
    let low = 0
    let high = lines.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (lines[middle].input <= offset) low = middle
      else high = middle
    }
    return lines[low].source + offset - lines[low].input
  }

  function visit(node: MarkdownNode): void {
    if (
      ["InlineCode", "URL", "LinkLabel", "Autolink", "HTMLTag", "Escape"].includes(node.name) ||
      labelReference(node, input) ||
      (unit.format === "markdown" && (["HTMLBlock", "FencedCode", "CodeBlock", "TaskMarker"].includes(node.name) || node.name.endsWith("Mark")))
    ) {
      let start = original(node.from)
      let end = original(node.to)
      // Reference brackets remain native syntax; only their lookup key needs a marker.
      if (node.name === "LinkLabel") {
        start++
        end--
      }
      const parent = node.parent
      const paired = (node.name === "EmphasisMark" || node.name === "StrikethroughMark") && parent
      const side = paired ? (node.from === parent.from ? "open" : "close") : undefined
      // Keep existing flanking whitespace with style delimiters; translated punctuation must not change their parsing.
      if (side === "open") while (start > 0 && /[\t ]/.test(unit.text[start - 1])) start--
      if (side === "close") while (end < unit.text.length && /[\t ]/.test(unit.text[end])) end++
      fragments.push({ kind: node.name, text: unit.text.slice(start, end), start, end, pair: paired ? parent.from + ":" + parent.to : undefined, side })
    } else for (const child of children(node)) visit(child)
  }

  if (unit.kind !== "string") visit(tree ?? markdownTree(input).topNode)
  fragments.sort((a, b) => a.start - b.start || b.end - a.end)
  const data = /[A-Za-z\d][A-Za-z\d._~:+/%=-]*/gu
  const patterns = [
    /https?:\/\/[^\s<>"'\x60，。！？；]+/giu,
    /\b[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}\b/gu,
    /\b[A-Za-z\d.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?(?:\.[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?)+\b/gu,
    /\b0x[\da-fA-F]+\b/gu,
    /(?<![\w.])v?\d+\.\d+\.\d+(?:-[A-Za-z\d]+(?:[.-][A-Za-z\d]+)*)?(?:\+[A-Za-z\d]+(?:[.-][A-Za-z\d]+)*)?(?!\w|\.\w)/gu,
    /(?<![\p{L}\p{N}\p{M}_/\\<])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/(?!\/))[^\s<>"'\x60，。！？；]+/gu,
    /(?<![\w$])HTTP(?:S|\(S\))?\/\d+(?:\.\d+)*(?![\w$])/giu,
    data
  ]
  if (unit.kind) patterns.push(/\b[1-5][xX]{2}\b/gu)
  for (const pattern of patterns) {
    // Matches from one regex never overlap and advance in source order. Check only prior rules,
    // then merge this rule's accepted ranges so syntax and earlier rules keep their priority.
    const accepted: ProtectedFragment[] = []
    let occupied = 0
    for (const match of unit.text.matchAll(pattern)) {
      let text = match[0]
      if (pattern === data) {
        // Classify data by its shape, not by an exhaustive list of address/hash types.
        // Custom tag names remain prose even when they contain digits.
        if (unit.text.lastIndexOf("<", match.index) > unit.text.lastIndexOf(">", match.index)) continue
        const digits = text.match(/\d/gu)?.length ?? 0
        const hex = text.replace(/[.:_+-]/gu, "")
        const numeric = digits >= 4 && !/[A-Za-z]/u.test(text)
        const mixed = digits >= 4 && (digits * 2 >= text.length || /[^\w]{2}|(?:[.:/%+=-].*){2}/u.test(text))
        if (!(/^[\da-f]{32,}$/iu.test(hex) || numeric || mixed)) continue
      }
      if ((/^https?:\/\//iu.test(text) || /^[A-Za-z]:[\\/]|^\.{0,2}[\\/]/u.test(text)) && unit.kind !== "string") {
        text = text.replace(/[.,!?;:]+$/u, "")
        for (const [open, close] of [
          ["(", ")"],
          ["[", "]"],
          ["{", "}"]
        ])
          while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1)
      }
      const start = match.index
      const end = start + text.length
      // Escapes and interpolations are lexical boundaries, not identifier characters.
      if (unit.protected?.some((range) => range.start < end && range.end > start)) continue
      while (occupied < fragments.length && fragments[occupied].end <= start) occupied++
      if (occupied < fragments.length && fragments[occupied].start < end) continue
      accepted.push({ kind: "Technical", text, start, end })
    }
    if (!accepted.length) continue
    const merged: ProtectedFragment[] = []
    let previous = 0
    for (const fragment of accepted) {
      while (previous < fragments.length && fragments[previous].start <= fragment.start) merged.push(fragments[previous++])
      merged.push(fragment)
    }
    while (previous < fragments.length) merged.push(fragments[previous++])
    fragments = merged
  }
  return fragments.filter((fragment) => !!fragment.text)
}

export function fragmentContents(unit: TextUnit, tree?: MarkdownNode): readonly (readonly [string, string])[] {
  return protectedFragments(unit, tree)
    .filter((fragment) => fragment.kind !== "InlineCode" && fragment.kind !== "Technical")
    .map((fragment) => [fragment.kind, fragment.text] as const)
}

/** Peel only complete prose wrappers; partial quotes and inline formatting remain in the sentence. */
export function translationBodyRange(text: string): { start: number; end: number } {
  let start = 0
  let end = text.length
  const quotes: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』", "«": "»" }
  while (start < end) {
    while (start < end && /\s/u.test(text[start])) start++
    while (end > start && /\s/u.test(text[end - 1])) end--
    const input = text.slice(start, end)
    const close = quotes[input[0]]
    if (close && input.length > 2 && input.endsWith(close)) {
      let depth = 1
      let position = 1
      for (; position < input.length; position++) {
        if (input[position] === "\\") position++
        else if (input[position] === close && --depth === 0) break
        else if (input[0] !== close && input[position] === input[0]) depth++
      }
      if (position === input.length - 1) {
        start++
        end--
        continue
      }
    }
    if (!/^(?:\*|_|~|\[)/u.test(input)) break
    if (input[0] === "[" ? !/[)\]]$/u.test(input) : !input.endsWith(input[0])) break
    const block = markdownTree(input).topNode.firstChild
    const wrapper = block?.firstChild
    if (block?.name !== "Paragraph" || block.nextSibling || !wrapper || wrapper.nextSibling || wrapper.from !== 0 || wrapper.to !== input.length) break
    const marks = children(wrapper)
    const first = marks[0]
    const last = marks.at(-1)
    if (["StrongEmphasis", "Emphasis", "Strikethrough"].includes(wrapper.name) && first && last && first !== last) {
      start += first.to
      end = start + last.from - first.to
    } else if (wrapper.name === "Link" && first?.name === "LinkMark" && input.slice(first.from, first.to) === "[") {
      const closing = marks.find((node) => node.name === "LinkMark" && input.slice(node.from, node.to) === "]")
      // Shortcut/collapsed references derive their target from the label itself.
      if (!closing || closing.to === wrapper.to || marks.some((node) => node.name === "LinkLabel" && input.slice(node.from, node.to) === "[]")) break
      start += first.to
      end = start + closing.from - first.to
    } else break
  }
  return { start, end }
}
