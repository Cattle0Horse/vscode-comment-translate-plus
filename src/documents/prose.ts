/** Paragraphs, list items and docstring fields own their continuations; labels own no following prose. */
export function proseBlocks(text: string, protectedRanges: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = []
  const multiline = protectedRanges.filter((range) => /[\r\n]/u.test(text.slice(range.start, range.end)))
  let current: { start: number; end: number } | undefined
  let exampleIndent: number | undefined
  let fence: string | undefined
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0].replace(/\r?\n$/u, "")
    const indent = line.match(/^[\t ]*/u)![0].length
    const content = line.trim()
    if (multiline.some((range) => range.start < match.index + match[0].length && range.end > match.index)) {
      if (!current) {
        current = { start: match.index, end: match.index + line.length }
        blocks.push(current)
      } else current.end = match.index + line.length
      continue
    }
    if (!content) {
      current = undefined
      continue
    }
    if (exampleIndent !== undefined && indent > exampleIndent) {
      current = undefined
      continue
    }
    exampleIndent = undefined
    const mark = content.match(/^(`{3,}|~{3,})/u)?.[0]
    if (fence || mark) {
      if (fence && mark?.[0] === fence[0] && mark.length >= fence.length) fence = undefined
      else if (!fence) fence = mark
      current = undefined
      continue
    }
    const label = /^[\p{L}\w /-]+:[\t ]*$/u.test(content)
    const field = /^(?:\*{0,2}[\w]+(?:[\t ]+\([^)]*\))?):[\t ]+\S/u.test(content)
    const list = /^(?:[-+*]|\d+[.)])[\t ]+/u.test(content)
    if (content.startsWith(">>>")) {
      current = undefined
      continue
    }
    if (!current || label || field || list) {
      current = { start: match.index, end: match.index + line.length }
      blocks.push(current)
    } else current.end = match.index + line.length
    if (label) {
      current = undefined
      if (/^(?:examples?|usage):$/iu.test(content)) exampleIndent = indent
    }
  }
  return blocks
}
