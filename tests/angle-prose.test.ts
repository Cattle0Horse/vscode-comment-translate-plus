import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("angle-bracket instructions inside prose translate without being treated as HTML attributes", async (t) => {
  const source = "Choose <pick from the list>, because <brief note: compare the routes and consider the expected visiting time>. Is this suitable?"
  const output = "请选择<列表中的一个>，因为<简短说明：比较路线并考虑预计参观时间>。这样合适吗？"
  const fixture = await chatFixture(t, () => output)
  const parsed = parseMarkdown(source)
  const input = inputOf(parsed)
  assert.equal(prepareTranslation(input.units[0], 32).hasMarkers, false)
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, output)
  assert.equal(fixture.seen.length, 1)
  assert.ok(validateTranslation(input.units[0], output.replace("<", "")))
  assert.equal(translatedMarkdown(parsed, new Map([[input.units[0].id, result[0].text]])), output)
})

test("actual tags, valued attributes, custom names and paired unknown elements remain protected", () => {
  for (const tag of [
    "<input disabled>",
    "<span hidden>",
    "<path focusable>",
    "<mrow displaystyle>",
    "<gallery-item compact>",
    "<GalleryWidget compact>",
    "<artifact compact>label</artifact>",
    '<artifact role="note">',
    "<artifact compact />"
  ]) {
    const source = "Read " + tag + " carefully."
    const [unit] = inputOf(parseMarkdown(source)).units
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.restore(prepared.text), source)
    assert.ok(validateTranslation(unit, "请仔细阅读。"), tag)
  }
})
