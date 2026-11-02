/**
 * Hide unresolved Git conflict marker lines while preserving every source offset.
 *
 * The parser can then inspect comments and Markdown around either side of a
 * conflict without treating marker text as translatable content. Newlines are
 * retained so diagnostics and edits continue to refer to the original text.
 */
export function maskGitConflictMarkers(source: string): string {
  let size = 0
  return source.replace(/^[^\r\n]+/gm, (line) => {
    const start = line.match(/^(<{7,})(?:[\t ].*)?$/u)
    if (start) {
      size = start[1].length
    } else {
      if (!size) return line
      const marker = line.match(/^(\|{7,}|={7,}|>{7,})(?:[\t ].*)?$/u)?.[1]
      if (!marker || marker.length !== size || (marker[0] === "=" && line.trimEnd() !== marker)) return line
      if (marker[0] === ">") size = 0
    }
    // Work in UTF-16 code units, including branch labels containing surrogate pairs.
    return " ".repeat(line.length)
  })
}
