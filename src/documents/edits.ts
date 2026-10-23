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
    let { start, end } = unit
    let unchanged = true
    for (const batch of edits) {
      let shift = 0
      for (const edit of batch) {
        if (!edit.rangeLength && !edit.text.length) continue
        const from = edit.rangeOffset
        const to = from + edit.rangeLength
        if (from < end && (edit.rangeLength ? to > start : from > start)) {
          unchanged = false
          break
        }
        if (to <= start) shift += edit.text.length - edit.rangeLength
      }
      if (!unchanged) break
      start += shift
      end += shift
    }
    if (unchanged) result.set(start + ":" + end, unit)
  }
  return result
}
