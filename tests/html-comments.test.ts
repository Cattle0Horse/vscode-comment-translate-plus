import assert from "node:assert/strict"
import { test } from "node:test"
import type { TextUnit } from "../src/model/document.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { translationIsUnchanged, validateTranslation } from "../src/documents/validation.ts"
import { INITIAL, type IGrammar } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"

test("HTML comment paragraphs merge physical lines while blank lines and list items stay independent", async () => {
  const grammar = {
    tokenizeLine(line: string, state: typeof INITIAL) {
      return { tokens: [{ startIndex: 0, endIndex: line.length, scopes: ["comment.block.html"] }], ruleStack: state, stoppedEarly: false }
    }
  } as IGrammar
  for (const newline of ["\n", "\r\n"]) {
    const source = ["<!--", "Read the catalog.", "Keep the ticket.", "", "- Read the next", "  gallery guide.", "- Keep the map. -->"].join(newline)
    const units = await extractCode(source, "html", new CodeTokenizer(grammar), () => {})
    assert.deepEqual(
      units.map((unit) => prepareTranslation(unit, 32).text),
      ["Read the catalog. Keep the ticket.", "- Read the next gallery guide.", "- Keep the map."]
    )
    for (const unit of units) {
      assert.equal(source.slice(unit.start, unit.end), unit.text)
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.restore(prepared.text), unit.text)
      assert.equal(validateTranslation(unit, prepared.restore(prepared.text.replaceAll("Read", "阅读").replaceAll("Keep", "保留"))), undefined)
    }
  }
})

test("HTML comment shells stay local with exact whitespace and unchanged restoration", () => {
  for (const text of ["<!-- Read the gallery guide. -->", "<!--\r\n  Read the gallery guide.\r\n-->", "<!--Read the gallery guide.-->"])
    for (const punctuation of [false, true]) {
      const unit: TextUnit = {
        id: "comment",
        start: 0,
        end: text.length,
        text,
        format: "text",
        kind: "comment",
        language: "html",
        protected: punctuation
          ? [
              { start: 0, end: 4 },
              { start: text.length - 3, end: text.length }
            ]
          : undefined
      }
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.text, "Read the gallery guide.")
      assert.equal(prepared.hasMarkers, false)
      assert.equal(prepared.restore(prepared.text), text)
      const translated = prepared.restore("阅读画廊指南。")
      assert.equal(translated, text.replace("Read the gallery guide.", "阅读画廊指南。"))
      assert.equal(validateTranslation(unit, translated), undefined)
      assert.equal(translationIsUnchanged(unit, prepared.restore(prepared.text)), true)
      for (const invalid of [translated.slice(4), translated.slice(0, -3), translated + "<!-- extra -->", prepared.restore("阅读 --> 画廊指南。")])
        assert.ok(validateTranslation(unit, invalid))
    }
})

test("unpaired HTML boundaries are not independently peeled as a complete shell", () => {
  for (const text of ["<!-- Read the gallery guide.", "Read the gallery guide. -->"]) {
    const unit: TextUnit = { id: "partial", start: 0, end: text.length, text, format: "text", kind: "comment", language: "html" }
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.text, text)
    assert.equal(prepared.restore(prepared.text), text)
  }
})
