import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml"
import type { TextUnit, ParsedDocument } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree, standalone } from "./tree.ts"
import { unembedTranslation } from "./embedding.ts"
import { validateTranslation, markdownDocumentShape } from "./validation.ts"
import { assertYamlStructure } from "./yaml.ts"

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

/** Reassemble translated fields and table rows from their original separators for editor display. */
export function displayTranslations(source: string, units: readonly (TextUnit & { readonly translation: string })[]): (TextUnit & { readonly translation: string })[] {
  const groups = new Map<string, { unit: TextUnit; parts: (TextUnit & { readonly translation: string })[] }>()
  for (const part of units) {
    if (part.translation === part.text) continue
    const { start, end } = part.display ?? part
    const key = start + ":" + end
    let group = groups.get(key)
    if (!group) {
      group = { unit: { id: key, start, end, text: source.slice(start, end), format: part.format, kind: part.kind, commentPrefix: part.commentPrefix }, parts: [] }
      groups.set(key, group)
    }
    group.parts.push(part)
  }
  return [...groups.values()].map(({ unit, parts }) => {
    const translation = assembleText(
      source,
      parts.map((part) => ({ start: part.start, end: part.end, text: part.translation })),
      unit
    )
    return { ...unit, translation: parts.length === 1 && !parts[0].display ? translationDisplayText(translation, unit.format, parts[0]) : translation }
  })
}

/** Validate the assembled document too: individually valid cells or list items can change their parent structure. */
export function translatedMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, string>): string {
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
    } else if (["markdown", "md", "skill", "prompt", "instructions", "chatagent"].includes(block.language)) translatedMarkdown(block.parsed, inner)
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
export function progressiveMarkdown(document: ParsedDocument, translations: ReadonlyMap<string, string>): string {
  const text = translatedMarkdown(document, translations)
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
  for (const [offset, marker] of [...points].sort(([a], [b]) => a - b)) {
    while (index < units.length && units[index].end <= offset) {
      const unit = units[index++]
      const translated = translations.get(unit.id)
      if (translated !== undefined) delta += translated.length - (unit.end - unit.start)
    }
    const position = offset + delta
    chunks.push(text.slice(cursor, position), marker)
    cursor = position
  }
  chunks.push(text.slice(cursor))
  return chunks.join("")
}
