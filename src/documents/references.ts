import type { ReferenceBlock } from "../model/document.ts"
import type { TextUnit } from "../model/document.ts"

function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

/** Whole references omit duplicate plain source; Original blocks expose text hidden by markers. */
export function referenceCandidates(unit: TextUnit, prepared: { readonly source: string; readonly hasMarkers: boolean }): readonly (readonly ReferenceBlock[])[] {
  const selected: ReferenceBlock[] = []
  const seen = new Set<string>()
  const original = comparable(unit.text)
  const body = comparable(unit.content ?? prepared.source)
  const candidates = [...(unit.reference ?? [])]
  if (prepared.hasMarkers) {
    const original = { kind: "Original", text: unit.text, range: { start: unit.start, end: unit.end, container: unit.start } }
    if (candidates.some((block) => block.range && block.range.start <= unit.start && block.range.end >= unit.end)) candidates.push(original)
    else candidates.unshift(original)
  }
  for (const block of candidates) {
    const text = comparable(block.text)
    if (!text || (!prepared.hasMarkers && (text === original || text === body))) continue
    const key = block.range ? "range:" + block.kind + ":" + block.range.container + ":" + block.range.start + ":" + block.range.end : "text:" + text
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(block)
  }
  const groups = new Map<number, ReferenceBlock[]>()
  const candidatesInOrder: ReferenceBlock[][] = []
  for (const block of selected) {
    if (block.group === undefined) candidatesInOrder.push([block])
    else {
      let group = groups.get(block.group)
      if (!group) {
        group = []
        groups.set(block.group, group)
        candidatesInOrder.push(group)
      }
      group.push(block)
    }
  }
  return candidatesInOrder
}

/** Merge references using the protection fact supplied by the preparation stage. */
export function referenceText(units: readonly { readonly source: TextUnit; readonly hasMarkers: boolean }[]): string {
  const blocks: ReferenceBlock[] = []
  const seen = new Set<string>()
  let includesOriginal = false
  for (const { source: unit, hasMarkers } of units) {
    const original = comparable(unit.text)
    const body = unit.content === undefined ? original : comparable(unit.content)
    includesOriginal ||= !!unit.reference?.some((block) => block.kind === "Original")
    for (const block of unit.reference ?? []) {
      const text = comparable(block.text)
      if (!text) continue
      if (block.kind !== "Original" && (text === original || text === body)) {
        if (!hasMarkers) continue
        includesOriginal = true
      }
      if (!block.range && seen.has(text)) continue
      if (!block.range) seen.add(text)
      blocks.push(block)
    }
  }
  // A heading introduction and a marker's Original block can describe the same
  // source span with different roles. Exact ranges prove containment across roles.
  const groups: ReferenceBlock[][] = []
  let coveredEnd = -1
  blocks.sort((a, b) => (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity) || (b.range?.end ?? 0) - (a.range?.end ?? 0))
  for (const block of blocks) {
    if (block.range && block.range.end <= coveredEnd) continue
    const group = groups.at(-1)
    const previous = group?.at(-1)
    if (block.range && previous?.range && block.kind === previous.kind && block.range.container === previous.range.container) group!.push(block)
    else groups.push([block])
    coveredEnd = Math.max(coveredEnd, block.range?.end ?? -1)
  }
  const context = groups
    .map((group) => {
      let text = ""
      let end = -1
      for (const block of group) {
        // Parser-owned offsets prove overlap; equal text alone never proves source ownership.
        if (block.range && block.range.start <= end) {
          if (block.range.end > end) text += block.text.slice(end - block.range.start)
        } else text += (text && !text.endsWith("\n") ? "\n" : "") + block.text
        end = Math.max(end, block.range?.end ?? -1)
      }
      return trimBlankLines(text)
    })
    .join("\n\n")
  const body = units.map(({ source }) => source.content ?? source.text).join("\n\n")
  return comparable(context) === comparable(body) && !includesOriginal ? "" : trimBlankLines(context)
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, "")
}

export function sourceReferences(source: string, unit: Pick<TextUnit, "start" | "end">, language: string): readonly ReferenceBlock[] {
  const windows: ReferenceBlock[] = []
  for (const neighbors of [2, 1, 0]) {
    let beforeStart = unit.start ? source.lastIndexOf("\n", unit.start - 1) + 1 : 0
    for (let index = 0; index < neighbors && beforeStart > 0; index++) beforeStart = beforeStart < 2 ? 0 : source.lastIndexOf("\n", beforeStart - 2) + 1
    let afterEnd = Math.max(unit.start, unit.end - 1)
    for (let index = 0; index <= neighbors; index++) {
      const newline = source.indexOf("\n", afterEnd)
      if (newline < 0) {
        afterEnd = source.length
        break
      }
      afterEnd = newline + 1
    }
    windows.push({ kind: "Source (" + language + ")", text: source.slice(beforeStart, afterEnd), range: { start: beforeStart, end: afterEnd, container: 0 }, alternative: unit.start })
  }
  return windows
}
