import assert from "node:assert/strict"
import { test } from "node:test"
import { readingText, displayTranslations } from "../src/documents/presentation.ts"
import type { TextUnit } from "../src/model/document.ts"
import { parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { prepareTranslation } from "../src/documents/terms.ts"

function unit(text: string, kind?: TextUnit["kind"], commentPrefix?: string): TextUnit {
  return { id: "display", start: 0, end: text.length, text, format: "text", kind, commentPrefix }
}

test("ordinary text and strings retain symbols that resemble comment syntax", () => {
  for (const text of ["# Read this", "/gallery/map", "* multiplier", "Read */", "/* Read */", "<!-- Read -->"])
    for (const kind of [undefined, "string"] as const) assert.equal(readingText(text, unit(text, kind)), text)
})

test("complete comment display requires both source-owned boundaries", () => {
  for (const [source, translated] of [
    ["/* Read */", "/* 阅读 */"],
    ["<!-- Read -->", "<!-- 阅读 -->"]
  ]) {
    const comment = unit(source, "comment")
    assert.equal(readingText(translated, comment), "阅读")
    for (const damaged of [translated.slice(0, -2).trim(), translated.slice(2).trim(), "*/ 阅读 /*", "阅读"]) assert.equal(readingText(damaged, comment), damaged)
  }
})

test("parser-split C fragments and explicit line prefixes strip only their owned syntax", () => {
  assert.equal(readingText("/* 阅读", unit("/* Read", "comment")), "阅读")
  assert.equal(readingText("阅读 */", unit("Read */", "comment")), "阅读")
  assert.equal(readingText("阅读 */", unit("Read", "comment")), "阅读 */")
  assert.equal(readingText("<!-- 阅读", unit("<!-- Read", "comment")), "<!-- 阅读")
  assert.equal(readingText("阅读 -->", unit("Read -->", "comment")), "阅读 -->")
  assert.equal(readingText("// 阅读\n// 保留", unit("// Read\n// Keep", "comment", "//")), "阅读 保留")
  assert.equal(readingText("// 阅读\n/ 保留", unit("// Read\n// Keep", "comment", "//")), "// 阅读 / 保留")
  assert.equal(readingText("# 阅读", unit("Read", "comment")), "# 阅读")
})

test("C star decorations follow the source layout while literal stars remain text", () => {
  assert.equal(readingText("/**\n * 阅读\n * 保留\n */", unit("/**\n * Read\n * Keep\n */", "comment")), "阅读 保留")
  assert.equal(readingText("/* * 保留 */", unit("/* * Keep */", "comment")), "* 保留")
})

test("quoted fenced comments retain their original syntax owner after display decoding", async () => {
  for (const comment of ["/* Read */", "<!-- Read -->"]) {
    const source = "> ```fixture\n> " + comment + "\n> ```"
    const parsed = await parseMarkdownWithCode(source, async (text) => {
      const end = text.trimEnd().length
      return { source: text, errors: [], groups: [{ start: 0, end, units: [unit(text.slice(0, end), "comment")] }] }
    })
    const translated = parsed.groups.flatMap((group) => group.units).map((unit) => ({ ...unit, translation: prepareTranslation(unit, 32).restore("阅读") }))
    const [row] = displayTranslations(source, translated)
    assert.equal(readingText(row.translation, row.source), "阅读")
  }
})
