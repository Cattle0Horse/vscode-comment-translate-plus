import type { SourcePiece } from "../model/document.ts"

/** Linear runs coalesce; an escape maps its decoded characters to the whole source spelling. */
export class SourceMap {
  private readonly runs: { from: number; to: number; start: number; end: number }[] = []

  get pieces(): readonly SourcePiece[] {
    return this.runs
  }

  append(length: number, start: number, end: number): void {
    if (!Number.isInteger(length) || length < 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw Error("translation-structure-invalid")
    if (!length) return
    const previous = this.runs.at(-1)
    const from = previous?.to ?? 0
    if (previous && previous.end === start && previous.to - previous.from === previous.end - previous.start && length === end - start) {
      previous.to = from + length
      previous.end = end
    } else this.runs.push({ from, to: from + length, start, end })
  }

  offset(position: number, end = false): number {
    return sourceOffset(this.runs, position, end)
  }

  range(start: number, end: number): { start: number; end: number } {
    if (end <= start) throw Error("translation-structure-invalid")
    return { start: this.offset(start), end: this.offset(end, true) }
  }

  /** Reverse lookup succeeds only at an exact source boundary, never inside an escape or removed prefix. */
  logical(position: number, end = false): number | undefined {
    let low = 0
    let high = this.runs.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.runs[middle].start < position || (!end && this.runs[middle].start === position)) low = middle + 1
      else high = middle
    }
    const piece = this.runs[Math.max(0, low - 1)]
    if (!piece || position < piece.start || position > piece.end) return
    if (piece.to - piece.from === piece.end - piece.start) return piece.from + position - piece.start
    if (position === piece.start) return piece.from
    if (position === piece.end) return piece.to
  }
}

/** Starts select the right run; ends select the left run at a removed source boundary. */
export function sourceOffset(pieces: readonly SourcePiece[], position: number, end = false): number {
  if (!Number.isInteger(position) || position < 0) throw Error("translation-structure-invalid")
  let low = 0
  let high = pieces.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (pieces[middle].from < position || (!end && pieces[middle].from === position)) low = middle + 1
    else high = middle
  }
  const piece = pieces[Math.max(0, low - 1)]
  if (!piece || position < piece.from || position > piece.to) throw Error("translation-structure-invalid")
  if (piece.to - piece.from === piece.end - piece.start) return piece.start + position - piece.from
  if (position === piece.from) return piece.start
  if (position === piece.to) return piece.end
  return end ? piece.end : piece.start
}
