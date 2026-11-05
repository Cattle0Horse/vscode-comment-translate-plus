import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { translationIsUnchanged, validateTranslation } from "../src/documents/validation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { pythonStringUnits } from "../src/documents/python.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("prose punctuation is decoded before translation while an unchanged reply restores the exact source", () => {
  for (const [source, expected] of [
    ["Read the museum guide\\.", "Read the museum guide."],
    ["Choose sub\\-panels \\(map or hours\\)\\.", "Choose sub-panels (map or hours)."],
    ['Panel options: \\{"Map": true, "Hours": false\\}\\.', 'Panel options: {"Map": true, "Hours": false}.']
  ])
    for (const format of ["markdown", "text"] as const) {
      const unit = { id: "description", start: 0, end: source.length, text: source, format }
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.text, expected)
      assert.equal(prepared.hasMarkers, false)
      assert.equal(prepared.restore(expected), source)
      assert.equal(validateTranslation(unit, expected), undefined)
      assert.equal(translationIsUnchanged(unit, expected), true)
    }
})

test("decoding prose escapes cannot create links, list markers or a thematic break", () => {
  for (const source of ["Read [map]\\(guide\\).", "\\- Read the map.", "1\\. Read the map.", "1\\) Read the map.", "\\-\\-\\-"]) {
    const unit = { id: "structure", start: 0, end: source.length, text: source, format: "markdown" as const }
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.text, source)
    assert.equal(prepared.restore(prepared.text), source)
  }
})

test("Markdown code, link destinations, literal backslashes and source-language escapes keep their owned spelling", () => {
  const source = "Read " + String.fromCharCode(96) + "literal\\." + String.fromCharCode(96) + " at [map](https://example.com/a\\(b\\))\\."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, 200)
  assert.equal(prepared.text, source.slice(0, -2) + ".")
  assert.equal(prepared.restore(prepared.text), source)
  for (const text of ["Read \\\\.", "Read \\*literal\\*.", "Read \\_literal\\_.", "Read \\[literal\\]."])
    assert.equal(prepareTranslation({ id: "literal", start: 0, end: text.length, text, format: "markdown" }, 32).text, text)
  const text = "Read\\."
  assert.equal(prepareTranslation({ id: "string", start: 0, end: text.length, text, format: "text", kind: "string", protected: [{ start: 4, end: 6 }] }, 32).text, text)
  const literal = 'r"Read\\."'
  const [python] = pythonStringUnits(literal, { id: "raw", start: 0, end: literal.length, text: literal, format: "text", kind: "string", language: "python" }, [
    { start: 0, end: literal.length, protected: [] }
  ])
  assert.equal(prepareTranslation(python, 32).text, text)
})

test("decoded settings prose completes on the first HTTP response, assembles and shares the validated cache", async (t) => {
  const source = 'Choose sub\\-panels \\(map or hours\\)\\. Example: \\{"Map": true, "Hours": false\\}'
  const output = '选择子面板（地图或开放时间）。示例：{"Map": true, "Hours": false}'
  const fixture = await chatFixture(t, () => output)
  const parsed = parseMarkdown(source)
  const input = inputOf(parsed)
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate("settings-escapes", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  assert.equal(translatedMarkdown(parsed, await translate()), output)
  assert.equal(translatedMarkdown(parsed, await translate()), output)
  assert.equal(parsed.source, source)
  assert.equal(fixture.seen.length, 1)
  assert.deepEqual(fixture.seen[0].items, ['Choose sub-panels (map or hours). Example: {"Map": true, "Hours": false}'])
})
