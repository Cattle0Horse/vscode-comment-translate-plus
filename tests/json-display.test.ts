import assert from "node:assert/strict"
import { test } from "node:test"
import { displayTranslations } from "../src/documents/presentation.ts"
import type { TextUnit } from "../src/model/document.ts"

test("JSON display keeps source key/value syntax, untranslated values and independent JSONL rows", () => {
  const source = '{"title": "Gallery guide", "open": true, "count": 7}\r\n{"title": "Printed map", "open": false}'
  const part = (text: string, translation: string): TextUnit & { translation: string } => {
    const start = source.indexOf(text)
    return { id: String(start), start, end: start + text.length, text, translation, format: "text", kind: "string", language: "json" }
  }
  const title = part('"title"', '"标题"')
  const guide = part('"Gallery guide"', '"画廊指南"')
  const map = part('"Printed map"', '"印刷地图"')
  const rows = displayTranslations(source, [map, guide, title])
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.translation) as unknown),
    [
      { 标题: "画廊指南", open: true, count: 7 },
      { title: "印刷地图", open: false }
    ]
  )
  assert.equal(displayTranslations(source, [guide])[0].translation, '{"title": "画廊指南", "open": true, "count": 7}')
  assert.equal(displayTranslations(source, [{ ...guide, translation: guide.text }]).length, 0)
})
