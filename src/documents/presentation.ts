import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml"
import type { TextUnit, ParsedDocument } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree, standalone } from "./tree.ts"
import { unembedTranslation } from "./embedding.ts"
import { validateTranslation, markdownDocumentShape } from "./validation.ts"
import { assertYamlStructure } from "./yaml.ts"
import { commentDisplayProcessor } from "./commentSyntax.ts"
import type { TranslationValue } from "../model/translation.ts"

/** Short editor rows strip only syntax owned by the source unit; literals retain their punctuation. */
export function readingText(text: string, unit: TextUnit): string {
  if (unit.kind === "string") return text.replace(/\r\n|[\r\n]/gu, "\\n").trim()
  const comment = commentDisplayProcessor(unit)
  if (comment) text = comment.content(text) ?? text
  const lines = translationDisplayText(text, unit.format).split(/\r?\n/)
  if (unit.format === "text" || unit.format === "yaml")
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
  return lines.map((line) => line.replace(/^\s*(?:>\s*)*(?:(?:#{1,6}|[-+*]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/, "").trim()).join(" ")
}

/** Assemble source-owned ranges once, rejecting overlap instead of guessing alignment. */
function assembleText(source: string, replacements: readonly { readonly start: number; readonly end: number; readonly text: string }[], range = { start: 0, end: source.length }): string {
  const chunks: string[] = []
  let cursor = range.start
  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    if (replacement.start < cursor || replacement.end > range.end) throw Error("translation-structure-invalid")
    chunks.push(source.slice(cursor, replacement.start), replacement.text)
    cursor = replacement.end
  }
  chunks.push(source.slice(cursor, range.end))
  return chunks.join("")
}

/** Display text uses scalar values, while validation and Markdown previews retain valid YAML. */
export function translationDisplayText(text: string, format: TextUnit["format"], unit?: TextUnit): string {
  while (unit?.projection?.kind === "container") {
    text = unembedTranslation(unit, text)
    unit = unit.projection.unit
  }
  if (unit?.projection?.kind === "literal") return unit.projection.codec.display(text)
  if (format !== "yaml") return text
  const source = standalone(text)
  const document = parseDocument(source)
  if (document.errors.length) throw Error("translation-structure-invalid")

  function displayNode(node: unknown): string {
    if (isAlias(node) && node.range) return source.slice(node.range[0], node.range[1])
    if (isScalar(node)) {
      if (typeof node.value === "string") return node.value
      if (node.range) return source.slice(node.range[0], node.range[1])
      throw Error("translation-structure-invalid")
    }
    if (isMap(node)) return node.items.map((pair) => displayNode(pair.key) + ": " + displayNode(pair.value)).join("\n")
    if (isSeq(node)) return node.items.map((item) => "- " + displayNode(item)).join("\n")
    if (node === null) return ""
    throw Error("translation-structure-invalid")
  }

  return displayNode(document.contents)
}

export interface DisplayTranslation extends TextUnit {
  readonly translation: string
  /** Syntax ownership stays with the original unit after its displayed text has been decoded. */
  readonly source: TextUnit
  readonly candidate?: true
}

/** Reassemble translated fields and table rows from their original separators for editor display. */
export function displayTranslations(source: string, units: readonly (TextUnit & { readonly translation: TranslationValue })[]): DisplayTranslation[] {
  const groups = new Map<string, { unit: TextUnit; parts: (TextUnit & { readonly translation: string })[]; candidate?: true }>()
  const candidates: DisplayTranslation[] = []
  for (const part of units) {
    const json = part.kind === "string" && part.language !== undefined && ["json", "jsonc", "jsonl"].includes(part.language)
    if (typeof part.translation !== "string" && !json) {
      candidates.push({ id: part.id, start: part.start, end: part.end, text: part.text, format: "text", translation: part.translation.text, source: part, candidate: true })
      continue
    }
    if (part.translation === part.text) continue
    const translation = typeof part.translation === "string" ? part.translation : JSON.stringify(part.translation.text)
    let { start, end } = part.display ?? part
    if (json) {
      // A JSON row owns its keys, values and punctuation even when only one string changed.
      start = source.lastIndexOf("\n", start - 1) + 1
      const next = source.indexOf("\n", end)
      end = next < 0 ? source.length : next
      if (source[end - 1] === "\r") end--
    }
    const key = start + ":" + end
    let group = groups.get(key)
    if (!group) {
      group = { unit: { id: key, start, end, text: source.slice(start, end), format: part.format, kind: part.kind, commentPrefix: part.commentPrefix }, parts: [] }
      groups.set(key, group)
    }
    group.parts.push({ ...part, translation })
    if (typeof part.translation !== "string") group.candidate = true
  }
  const rows: DisplayTranslation[] = []
  let previousLiteral: TextUnit | undefined
  for (const { unit, parts, candidate } of [...groups.values()].sort((a, b) => a.unit.start - b.unit.start)) {
    const translation =
      parts.length === 1 && !parts[0].display && unit.start === parts[0].start && unit.end === parts[0].end
        ? translationDisplayText(parts[0].translation, unit.format, parts[0])
        : assembleText(
            source,
            parts.map((part) => ({ start: part.start, end: part.end, text: part.translation })),
            unit
          )
    const row = { ...unit, translation, source: parts.length === 1 ? parts[0] : unit, candidate }
    let literal: TextUnit | undefined = parts.length === 1 ? parts[0] : undefined
    while (literal?.projection?.kind === "container") literal = literal.projection.unit
    const preceding = literal?.projection?.kind === "literal" ? literal.projection.preceding : undefined
    const previous = rows.at(-1)
    // Translation/cache units stay independent. Only completed display rows sharing
    // a physical source line rejoin their exact decoded, source-owned separator.
    if (
      previous &&
      preceding &&
      preceding.id === previousLiteral?.id &&
      literal?.language === "python" &&
      source.lastIndexOf("\n", previous.end - 1) === source.lastIndexOf("\n", row.end - 1)
    ) {
      rows[rows.length - 1] = { ...previous, end: row.end, text: source.slice(previous.start, row.end), translation: previous.translation + preceding.text + row.translation }
    } else rows.push(row)
    previousLiteral = literal
  }
  return [...rows, ...candidates].sort((a, b) => a.start - b.start)
}

/** Candidate text is shown outside its enclosing block, never interpreted as replacement source syntax. */
function candidateInsertions(document: ParsedDocument, translations: ReadonlyMap<string, TranslationValue>): { start: number; end: number; text: string }[] {
  const units = document.groups
    .flatMap((group) => group.units)
    .flatMap((unit) => {
      const value = translations.get(unit.id)
      return value !== undefined && typeof value !== "string" ? [{ unit, value }] : []
    })
  if (!units.length) return []
  const frontmatter = document.groups.find((group) => group.start === 0 && group.units.some((unit) => unit.format === "yaml" && !unit.projection))
  const from = frontmatter?.end ?? 0
  const blocks = children(markdownTree(document.source.slice(from)).topNode)
  const insertions = new Map<number, string[]>()
  for (const { unit, value } of units) {
    const block = blocks.find((node) => from + node.from <= unit.start && from + node.to >= unit.end)
    const end = unit.end <= from ? from : block ? from + block.to : document.source.length
    let width = 3
    for (const match of value.text.matchAll(/`+/gu)) width = Math.max(width, match[0].length + 1)
    const fence = "`".repeat(width)
    const texts = insertions.get(end) ?? []
    texts.push("\n\n" + fence + "text\n" + value.text + "\n" + fence + "\n\n")
    insertions.set(end, texts)
  }
  return [...insertions].map(([start, texts]) => ({ start, end: start, text: texts.join("") })).sort((a, b) => a.start - b.start)
}

function renderMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, TranslationValue>) {
  const accepted = new Map([...translations].filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const text = validatedMarkdown(document, accepted)
  const units = document.groups.flatMap((group) => group.units)
  const candidates = candidateInsertions(document, translations)
  const insertions = candidates.map((insertion) => {
    let offset = insertion.start
    for (const unit of units) {
      const translated = accepted.get(unit.id)
      if (translated !== undefined && unit.end <= insertion.start) offset += translated.length - (unit.end - unit.start)
    }
    return { ...insertion, start: offset, end: offset }
  })
  return { text: assembleText(text, insertions), candidates }
}

/** Full preview text and progressive loading share the same rendering and source mapping. */
export function translatedMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, TranslationValue>): string {
  return renderMarkdown(document, translations).text
}

/** Validate the assembled document too: individually valid cells or list items can change their parent structure. */
function validatedMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, string>): string {
  const units = document.groups.flatMap((group) => group.units)
  const replacements = units.flatMap((unit) => {
    const text = translations.get(unit.id)
    if (text === undefined) return []
    if (unit.projection?.kind === "container") {
      const failure = validateTranslation(unit, text)
      if (failure) throw failure
    }
    return [{ start: unit.start, end: unit.end, text }]
  })
  const translated = assembleText(document.source, replacements)

  for (const block of document.codeBlocks ?? []) {
    if (!block.parsed) continue
    const inner = new Map<string, string>()
    for (const unit of units) {
      if (unit.projection?.kind !== "container" || unit.start < block.start || unit.end > block.end) continue
      const text = translations.get(unit.id)
      if (text !== undefined) inner.set(unit.projection.unit.id, unembedTranslation(unit, text))
    }
    if (!inner.size) continue
    if (block.language === "yaml" || block.language === "yml") {
      const replacements = block.parsed.groups
        .flatMap((group) => group.units)
        .flatMap((unit) => {
          const text = inner.get(unit.id)
          return text === undefined ? [] : [{ start: unit.start, end: unit.end, text }]
        })
      assertYamlStructure(block.source, assembleText(block.source, replacements))
    } else if (["markdown", "md", "skill", "prompt", "instructions", "chatagent"].includes(block.language)) validatedMarkdown(block.parsed, inner)
  }
  // Only the assembler can permit fence-body changes: every edit above owns a validated unit.
  const embedded = units.some((unit) => unit.projection?.kind === "container")
  const linkLabels = document.linkLabels
  if (JSON.stringify(markdownDocumentShape(document.source, embedded, linkLabels)) !== JSON.stringify(markdownDocumentShape(translated, embedded, linkLabels)))
    throw Error("translation-structure-invalid")
  return translated
}

export const previewLoadingMarker = '<span class="ctp-preview-loading" role="progressbar" aria-label="正在翻译"></span>'

/** Loading markers belong only to the rendered preview, after validating the actual document. */
export function progressiveMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, TranslationValue>): string {
  const { text, candidates } = renderMarkdown(document, translations)
  const units = document.groups.flatMap((group) => group.units).sort((a, b) => a.start - b.start)
  const pendingEnds = new Set(units.filter((unit) => unit.projection?.kind !== "container" && unit.format === "markdown" && !translations.has(unit.id)).map((unit) => unit.end))
  const icon = previewLoadingMarker
  const points = new Map([...pendingEnds].map((end) => [end, " " + icon]))
  for (const group of document.groups)
    if (group.units.some((unit) => unit.projection?.kind !== "container" && unit.format === "yaml" && !translations.has(unit.id))) {
      const offset = group.end + (document.source[group.end] === "\n" ? 1 : 0)
      const newline = document.source.includes("\r\n") ? "\r\n" : "\n"
      points.set(offset, (document.source[offset - 1] === "\n" ? newline : newline + newline) + icon + newline)
    }
  const bodyStart = document.groups.find((group) => group.units.some((unit) => unit.format === "markdown"))?.start
  if (pendingEnds.size && bodyStart !== undefined) {
    const start = bodyStart

    function visit(node: MarkdownNode): void {
      let nodeEnd = node.to
      while (nodeEnd > node.from && /[\r\n]/.test(document.source[start + nodeEnd - 1])) nodeEnd--
      const sourceEnd = start + nodeEnd
      if (pendingEnds.has(sourceEnd) && (["Paragraph", "Task", "TableCell"].includes(node.name) || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name))) {
        const last = node.lastChild
        let end = nodeEnd
        if (last?.name === "HardBreak" && last.to === node.to) end = last.from
        else if (node.name.startsWith("SetextHeading") && last) {
          end = last.from
          while (end > node.from && /[\r\n\t ]/.test(document.source[start + end - 1])) end--
        } else if (node.name.startsWith("ATXHeading") && last?.name === "HeaderMark" && last.from !== node.firstChild?.from) end = last.from
        while (end > node.from && /[\t ]/.test(document.source[start + end - 1])) end--
        points.delete(sourceEnd)
        points.set(start + end, " " + icon)
      }
      for (const child of children(node)) visit(child)
    }

    visit(markdownTree(document.source.slice(bodyStart)).topNode)
  }
  const chunks: string[] = []
  let cursor = 0
  let index = 0
  let delta = 0
  let candidateIndex = 0
  for (const [offset, marker] of [...points].sort(([a], [b]) => a - b)) {
    while (index < units.length && units[index].end <= offset) {
      const unit = units[index++]
      const translated = translations.get(unit.id)
      if (typeof translated === "string") delta += translated.length - (unit.end - unit.start)
    }
    while (candidateIndex < candidates.length && candidates[candidateIndex].start <= offset) delta += candidates[candidateIndex++].text.length
    const position = offset + delta
    chunks.push(text.slice(cursor, position), marker)
    cursor = position
  }
  chunks.push(text.slice(cursor))
  return chunks.join("")
}
