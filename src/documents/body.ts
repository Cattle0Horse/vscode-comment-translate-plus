import { protectedFragments, translationBodyRange } from "./protection.ts"
import type { TextUnit } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree } from "./tree.ts"

const analyses = new WeakMap<TextUnit, ReturnType<typeof analyzeTranslationBody>>()

/** Source facts belong to the immutable unit, never to a candidate translation or configuration. */
export function translationBody(unit: TextUnit) {
  let analysis = analyses.get(unit)
  if (!analysis) {
    analysis = analyzeTranslationBody(unit)
    analyses.set(unit, analysis)
  }
  return analysis
}

/** Resolve source-owned shells, protected fragments and continuation decoration in source coordinates. */
function analyzeTranslationBody(unit: TextUnit) {
  const original = unit.content ?? unit.text
  const natural = unit.content === undefined ? unit : { ...unit, text: original, format: "text" as const, protected: undefined }

  type ProtectedRange = { start: number; end: number; kind?: string; pair?: string; side?: "open" | "close"; fold?: boolean }

  let ranges: ProtectedRange[] = [...(natural.protected ?? []), ...protectedFragments(natural)].map((range) => ({ ...range })).sort((a, b) => a.start - b.start || b.end - a.end)
  for (const range of ranges)
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > original.length)
      throw Error("translation-structure-invalid")
  const delimiter = /^(?:\/{2,}!?|\/\*+!?|\*\/|#+|[rRuUbBfF]*(?:"{1,3}|'{1,3})|\x60)$/
  let start = unit.format === "markdown" || unit.kind === "string" ? (original.match(/^[\t ]*/)?.[0].length ?? 0) : 0
  let end = original.length
  const markdownPrefix: string[] = []
  for (const range of ranges) {
    if (
      range.start !== start ||
      !((unit.kind && delimiter.test(original.slice(range.start, range.end))) || ["HeaderMark", "ListMark", "QuoteMark", "TaskMarker"].includes(range.kind ?? ""))
    )
      break
    if (unit.format === "markdown") {
      const mark = original.slice(range.start, range.end)
      if (range.kind === "ListMark") markdownPrefix.push(/^\d/u.test(mark) ? "\\d+[.)][\\t ]+" : "[-+*][\\t ]+")
      else if (range.kind === "QuoteMark") markdownPrefix.push(">[\\t ]*")
      else if (range.kind === "TaskMarker") markdownPrefix.push("\\[[ xX]\\][\\t ]+")
      else if (range.kind === "HeaderMark" && /^#+$/u.test(mark)) markdownPrefix.push(mark + "[\\t ]+")
    }
    start = range.end
    while (start < end && /\s/.test(original[start])) start++
  }
  const echoedPrefix = markdownPrefix.length ? new RegExp("^[\\t ]*" + markdownPrefix.join(""), "u") : undefined
  const last = ranges.at(-1)
  if (last && last.start >= start && last.end === end && ((unit.kind && delimiter.test(original.slice(last.start, last.end))) || last.kind === "HeaderMark")) {
    end = last.start
    while (end > start && /\s/.test(original[end - 1])) end--
  }
  // Some grammars (notably Rust) identify the comment region but do not label its delimiter tokens.
  const block = unit.kind === "comment" ? original.match(/^\/\*+[!]?/u) : undefined
  const decorated =
    !!block &&
    original
      .slice(block[0].length)
      .split(/\r\n|[\r\n]/u)
      .slice(1, -1)
      .every((line) => !line.trim() || /^[\t ]*\*(?:[\t ]|$)/u.test(line))
  const layout: ProtectedRange[] = []
  if (unit.commentPrefix) {
    if (!original.startsWith(unit.commentPrefix)) throw Error("translation-structure-invalid")
    start = Math.max(start, unit.commentPrefix.length)
    while (start < end && /[\t ]/u.test(original[start])) start++
    const prefix = unit.commentPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    for (const match of original.matchAll(new RegExp("(?:\\r\\n|[\\r\\n])[\\t ]*" + prefix + "[\\t ]*", "gu"))) {
      layout.push({ start: match.index, end: match.index + match[0].length, fold: true })
    }
  }
  if (block) {
    start = Math.max(start, block[0].length)
    if (original.endsWith("*/")) end = Math.min(end, original.length - 2)
    if (decorated) {
      for (const match of original.matchAll(/(?:\r\n|[\r\n])[\t ]*(?:\*(?=[\t \r\n]|$)[\t ]?)?/gu)) {
        if (match.index < end) layout.push({ start: match.index, end: Math.min(end, match.index + match[0].length), fold: true })
      }
    }
    for (;;) {
      while (start < end && /\s/u.test(original[start])) start++
      const firstPrefix = layout.find((range) => range.start <= start && range.end > start)
      if (!firstPrefix) break
      start = firstPrefix.end
    }
    for (;;) {
      while (end > start && /\s/u.test(original[end - 1])) end--
      const lastPrefix = layout.find((range) => range.start >= start && range.start < end && range.end >= end)
      if (!lastPrefix) break
      end = lastPrefix.start
    }
  }
  if (unit.kind === "string") {
    // Boundary whitespace stays local; internal continuation layout folds with its line break.
    while (start < end && /\s/u.test(original[start])) start++
    while (end > start && /\s/u.test(original[end - 1])) end--
  } else if (unit.content === undefined) {
    const body = translationBodyRange(original.slice(start, end))
    end = start + body.end
    start += body.start
  }
  const source = original.slice(start, end)
  if (start || end !== original.length || layout.length) {
    let input = source
    for (const range of [...layout].reverse()) {
      const from = Math.max(start, range.start) - start
      const to = Math.min(end, range.end) - start
      if (to > from) input = input.slice(0, from) + input.slice(from, to).replace(/[^\r\n]/g, " ") + input.slice(to)
    }
    ranges = [
      ...(natural.protected ?? []),
      ...protectedFragments({
        ...natural,
        text: input,
        protected: natural.protected
          ?.filter((range) => range.end > start && range.start < end)
          .map((range) => ({ start: Math.max(start, range.start) - start, end: Math.min(end, range.end) - start }))
      }).map((range) => ({ ...range, start: range.start + start, end: range.end + start })),
      ...layout
    ]
      .map((range) => ({ ...range }))
      .sort((a, b) => a.start - b.start || b.end - a.end)
  }
  if (unit.format === "markdown") {
    const paragraphs: MarkdownNode[] = []

    function visit(node: MarkdownNode) {
      if (["Paragraph", "Task", "TableCell"].includes(node.name)) paragraphs.push(node)
      else for (const child of children(node)) visit(child)
    }

    visit(markdownTree(original).topNode)
    for (const match of original.matchAll(/\r\n|[\r\n]/gu)) {
      if (match.index < start || match.index >= end) continue
      const next = match.index + match[0].length
      if (!paragraphs.some((node) => node.from <= match.index && node.to > next)) {
        ranges.push({ start: match.index, end: next, kind: "LineBoundary" })
        continue
      }
      // A quote's continuation prefix belongs to the folded source line, not to translated prose.
      let to = next
      while (to < end && /[\t >]/u.test(original[to])) to++
      if (ranges.some((range) => range.kind === "QuoteMark" && range.start >= next && range.end <= to)) ranges.push({ start: match.index, end: to, fold: true })
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  }
  const protectedRanges: typeof ranges = []
  for (const range of ranges) {
    // Keep recognizable link/image punctuation in the request; validation still checks its structure.
    if (range.kind === "LinkMark") continue
    if (range.end <= start || range.start >= end) continue
    range.start = Math.max(start, range.start) - start
    range.end = Math.min(end, range.end) - start
    const previous = protectedRanges.at(-1)
    if (previous && (range.start < previous.end || (range.start === previous.end && range.kind === undefined && previous.kind === undefined && !!range.fold === !!previous.fold))) {
      if (range.end <= previous.end) continue
      // Continuation decoration must never turn protected code or escapes into foldable prose.
      if (!!previous.fold !== !!range.fold) {
        if (previous.fold) previous.end = range.start
        else range.start = previous.end
        protectedRanges.push(range)
        continue
      }
      if (range.pair || previous.pair) {
        if (source.slice(range.start, previous.end).trim()) throw Error("translation-structure-invalid")
        range.start = previous.end
      } else {
        previous.end = range.end
        continue
      }
    }
    protectedRanges.push(range)
  }
  return { original, source, start, end, ranges: protectedRanges as readonly Readonly<ProtectedRange>[], echoedPrefix }
}

/** Identify surviving source breaks before folding prose; embedding prefixes follow these exact source positions. */
export function translationLineBreaks(unit: TextUnit): readonly boolean[] {
  if (unit.projection?.kind === "container") return translationLineBreaks(unit.projection.unit)
  if (unit.projection?.kind === "literal") {
    return [...unit.text.matchAll(/\r?\n/gu)].map(({ index }) => unit.protected?.some((range) => range.start <= index && range.end > index) ?? false)
  }
  const { original, start, end, ranges } = translationBody(unit)
  return [...original.matchAll(/\r\n|[\r\n]/gu)].map(
    ({ index }) => index < start || index >= end || ranges.some((range) => !range.fold && range.start <= index - start && range.end > index - start)
  )
}
