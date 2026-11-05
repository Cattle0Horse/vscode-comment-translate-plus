import type { TextUnit } from "../model/document.ts"

/** Select a concrete syntax owner before extracting either side of a comment shell. */
export function blockCommentProcessor(text: string) {
  let opening: string
  let closing: string
  let kind: "html" | "c"
  if (text.startsWith("<!--")) {
    opening = "<!--"
    closing = "-->"
    kind = "html"
  } else if (text.startsWith("/*")) {
    let end = 2
    while (text[end] === "*") end++
    if (text[end] === "!") end++
    opening = text.slice(0, end)
    closing = "*/"
    kind = "c"
  } else return undefined

  const firstClose = text.indexOf(closing, opening.length)
  const body = firstClose === text.length - closing.length ? { start: opening.length, end: firstClose } : undefined
  return {
    opening,
    closing,
    kind,
    body,
    delimiters(value: string): string[] {
      const result: string[] = []
      const open = kind === "c" ? "/*" : opening
      for (let position = 0; position < value.length;) {
        const delimiter = value.startsWith(open, position) ? open : value.startsWith(closing, position) ? closing : undefined
        if (delimiter) {
          result.push(delimiter)
          position += delimiter.length
        } else position++
      }
      return result
    }
  }
}

/** Source-owned display syntax may be a complete block or a parser-split comment fragment. */
export function commentDisplayProcessor(unit: TextUnit): { content(text: string): string | undefined } | undefined {
  while (unit.projection?.kind === "container") unit = unit.projection.unit
  if (unit.kind !== "comment") return
  if (unit.commentPrefix) {
    const prefix = unit.commentPrefix
    return {
      content(text) {
        const lines = text.split(/\r\n|[\r\n]/u).map((line) => line.trimStart())
        if (lines.some((line) => line && !line.startsWith(prefix))) return
        return lines.map((line) => line.slice(prefix.length)).join("\n")
      }
    }
  }
  const source = unit.text.trim()
  const block = blockCommentProcessor(source)
  if (block?.kind === "html") {
    if (!block.body) return
    return {
      content(text) {
        const value = text.trim()
        const candidate = blockCommentProcessor(value)
        if (candidate?.kind === "html" && candidate.body) return value.slice(candidate.body.start, candidate.body.end)
      }
    }
  }
  const opening = block?.opening ?? ""
  const closing = source.endsWith("*/") ? "*/" : ""
  if (!opening && !closing) return
  const body = source.slice(opening.length, source.length - closing.length)
  const starred =
    !!opening &&
    body
      .split(/\r\n|[\r\n]/u)
      .slice(1)
      .every((line) => !line.trim() || starLineContent(line) !== undefined)
  return {
    content(text) {
      const value = text.trim()
      if ((opening && blockCommentProcessor(value)?.opening !== opening) || (closing && !value.endsWith(closing)) || value.length < opening.length + closing.length) return
      const content = value.slice(opening.length, value.length - closing.length)
      if (!starred) return content
      return content
        .split(/\r\n|[\r\n]/u)
        .map((line, index) => (index > 0 ? (starLineContent(line) ?? line) : line))
        .join("\n")
    }
  }
}

/** A star decorates a comment continuation only when followed by whitespace or line end. */
function starLineContent(line: string): string | undefined {
  const text = line.trimStart()
  if (text.startsWith("*") && (text.length === 1 || /\s/u.test(text[1]))) return text.slice(1)
}
