import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { parsePreserveTerms } from "./terms.ts"
import { resolveResourceUrl } from "./resourcePaths.ts"

/** Term sources add format and network policy to shared path resolution. */
export function termSource(source: string, workspace?: string, home?: string): string {
  const url = resolveResourceUrl(source, workspace, home)
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("网络保留词文件必须使用 HTTPS；HTTP 仅允许回环地址。")
  if (!/\.jsonc?$/iu.test(url.pathname)) throw Error("保留词文件必须使用 .json 或 .jsonc 扩展名。")
  return url.href
}

/** JSON remains strict; comments and trailing commas are accepted only in JSONC. */
export function parseTermFile(text: string, source: string): unknown[] {
  text = text.replace(/^\uFEFF/u, "")
  let value: unknown
  if (/\.jsonc$/iu.test(new URL(source).pathname)) {
    const errors: ParseError[] = []
    value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length) {
      const error = errors[0]
      const prefix = text.slice(0, error.offset)
      const line = prefix.split("\n").length
      const column = error.offset - prefix.lastIndexOf("\n")
      throw Error("JSONC " + line + ":" + column + " " + printParseErrorCode(error.error))
    }
  } else value = JSON.parse(text)
  if (!Array.isArray(value)) throw Error("保留词文件内容必须是字符串或正则对象的数组。")
  return value
}

/** Add one literal without rewriting existing comments, rules or surrounding text. */
export function appendPreserveTerm(text: string, source: string, term: string): string {
  if (!term.trim()) throw Error("保留词必须是非空字符串。")
  const values = parseTermFile(text, source)
  const rules = parsePreserveTerms(values)
  if (rules.literals.has(term.toLowerCase())) return text
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const result = bom + applyEdits(text.slice(bom.length), modify(text.slice(bom.length), [values.length], term, { isArrayInsertion: true }))
  parsePreserveTerms(parseTermFile(result, source))
  return result
}
