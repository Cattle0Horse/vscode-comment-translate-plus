import type { TextUnit } from "../model/document.ts"
import { parseMarkdown } from "./markdown.ts"
import { translatedMarkdown } from "./presentation.ts"
import { sourceReferences } from "./references.ts"

/** Capture one selected range; only parser-owned prose ranges become translation items. */
export function prepareSelection(source: string, start: number, end: number, format: TextUnit["format"], language: string) {
  const target: TextUnit = { id: "selection", start, end, text: source.slice(start, end), format }
  const parsed =
    format === "markdown"
      ? parseMarkdown(target.text)
      : { source: target.text, groups: [{ start: 0, end: target.text.length, units: [{ ...target, start: 0, end: target.text.length }] }], errors: [] }
  const units = parsed.groups.flatMap((group) => group.units)
  const input = units.map((unit) => {
    const from = start + unit.start
    const to = start + unit.end
    return {
      ...unit,
      start: from,
      end: to,
      display: unit.display ? { start: start + unit.display.start, end: start + unit.display.end } : undefined,
      reference: [
        ...(unit.reference ?? []).map((reference) => ({
          ...reference,
          range: reference.range ? { start: start + reference.range.start, end: start + reference.range.end, container: start + reference.range.container } : undefined,
          group: reference.group === undefined ? undefined : start + reference.group,
          alternative: reference.alternative === undefined ? undefined : start + reference.alternative
        })),
        ...sourceReferences(source, { start: from, end: to }, language)
      ]
    }
  })
  return {
    target,
    units: input,
    restore(translations: ReadonlyMap<string, string>): string {
      if (format === "markdown") return translatedMarkdown(parsed, translations)
      return translations.get(target.id) ?? target.text
    }
  }
}
