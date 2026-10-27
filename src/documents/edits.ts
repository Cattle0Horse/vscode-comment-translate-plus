import type { TextUnit } from "../model/document.ts"

export interface SourceEdit {
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
}

/** Each batch uses the offsets of its own pre-edit document version. */
export function unchangedUnitRanges(units: readonly TextUnit[], edits: readonly (readonly SourceEdit[])[]): ReadonlyMap<string, TextUnit> {
  const result = new Map<string, TextUnit>()
  for (const unit of units) {
    const range = unchangedRange(unit, edits)
    if (range) result.set(range.start + ":" + range.end, unit)
  }
  return result
}

export function unchangedRange(range: { readonly start: number; readonly end: number }, edits: readonly (readonly SourceEdit[])[]): { start: number; end: number } | undefined {
  let { start, end } = range
  for (const batch of edits) {
    let shift = 0
    for (const edit of batch) {
      if (!edit.rangeLength && !edit.text.length) continue
      const from = edit.rangeOffset
      const to = from + edit.rangeLength
      if (from < end && (edit.rangeLength ? to > start : from > start)) {
        return
      }
      if (to <= start) shift += edit.text.length - edit.rangeLength
    }
    start += shift
    end += shift
  }
  return { start, end }
}

/** Content and syntax identity, independent of source position and neighbouring references. */
export function unitContentKey(unit: TextUnit): readonly unknown[] {
  return [
    unit.format,
    unit.kind,
    unit.commentPrefix,
    unit.language,
    unit.text,
    unit.content,
    unit.yamlKey === true,
    unit.protected,
    unit.linkLabels,
    unit.display !== undefined,
    unit.embedding ? [unitContentKey(unit.embedding.unit), unit.embedding.prefixes] : undefined,
    unit.pythonString
      ? [
          unitContentKey(unit.pythonString.unit),
          unit.pythonString.prefix,
          unit.pythonString.continuation,
          unit.pythonString.quote,
          unit.pythonString.raw,
          unit.pythonString.formatted,
          unit.pythonString.expressions
        ]
      : undefined
  ]
}
