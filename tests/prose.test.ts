import assert from "node:assert/strict"
import { test } from "node:test"
import { proseUnits } from "../src/documents/prose.ts"
import { prepareTranslation } from "../src/documents/terms.ts"

test("text blocks produce source-aligned paragraph and list items with merged continuations", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = ["Read the catalog.", "Keep the ticket.", "", "- Read the next", "  gallery guide.", "- Keep the map."].join(newline)
    const units = proseUnits(text)
    assert.deepEqual(
      units.map((unit) => prepareTranslation(unit, 32).text),
      ["Read the catalog. Keep the ticket.", "- Read the next gallery guide.", "- Keep the map."]
    )
    for (const unit of units) {
      assert.equal(unit.text, text.slice(unit.start, unit.end))
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.restore(prepared.text), unit.text)
    }
  }
})
