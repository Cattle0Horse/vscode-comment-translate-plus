import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { parsePreserveTerms } from "./terms.ts"

/** Paths are resolved without depending on the operating system running the caller. */
export function termSource(source: string, workspace?: string, home?: string): string {
  if (!source.trim()) throw Error("保留词文件地址不能为空。")
  let path = source
  if (path.startsWith("~")) {
    if (!/^~(?:[\\/]|$)/u.test(path)) throw Error("保留词路径只支持 ~ 或 ~/，不支持 ~otheruser。")
    if (!home) throw Error("当前 Web 环境无法访问用户主目录，请使用工作区相对路径或完整文件 URI。")
    path = home.replace(/[\\/]$/u, "") + path.slice(1).replaceAll("\\", "/")
  }
  const encodedPath = (value: string) => value.split("/").map(encodeURIComponent).join("/")
  let url: URL
  if (/^[a-z]:[\\/]/iu.test(path)) {
    path = path.replaceAll("\\", "/")
    url = new URL("file:///" + path[0].toLowerCase() + ":" + encodedPath(path.slice(2)))
  } else if (/^(?:\\\\|\/\/)/u.test(path)) {
    const [host, ...parts] = path.replaceAll("\\", "/").slice(2).split("/")
    if (!host || !parts[0]) throw Error("UNC 保留词路径必须包含服务器和共享目录。")
    url = new URL("file://" + host + "/" + encodedPath(parts.join("/")))
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(path)) {
    if (/^[a-z]:/iu.test(path)) throw Error("Windows 保留词路径必须是绝对路径，例如 C:/terms.json。")
    url = new URL(path)
  } else if (path.startsWith("/")) url = new URL("file://" + encodedPath(path))
  else {
    if (!workspace) throw Error("相对保留词路径需要所属工作区，请使用绝对路径或 ~ 路径。")
    url = new URL(encodedPath(path.replaceAll("\\", "/")), workspace.replace(/\/?$/u, "/"))
  }
  if (url.username || url.password || url.hash) throw Error("保留词文件 URI 不允许包含用户名、密码或片段。")
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("网络保留词文件必须使用 HTTPS；HTTP 仅允许回环地址。")
  if (url.protocol === "file:") {
    if (url.search) throw Error("本地保留词文件 URI 不允许包含查询参数。")
    url.pathname = url.pathname.replace(/^\/[A-Z]:/u, (drive) => drive.toLowerCase())
  }
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
  if (rules.literals.has(term)) return text
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const result = bom + applyEdits(text.slice(bom.length), modify(text.slice(bom.length), [values.length], term, { isArrayInsertion: true }))
  parsePreserveTerms(parseTermFile(result, source))
  return result
}
