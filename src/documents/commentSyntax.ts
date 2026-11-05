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
