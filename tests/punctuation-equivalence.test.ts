import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { translationIsUnchanged } from "../src/documents/validation.ts"
import { displayTranslations } from "../src/documents/presentation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TextUnit } from "../src/model/document.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("punctuation form changes complete, cache and suppress duplicate immersive rows", async (t) => {
  const fixture = await chatFixture(t, () => "Codex：")
  const input = inputOf(parseMarkdown("Codex:"))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate("punctuation", input, (batch, signal) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate), new AbortController().signal)
  const results = await run()
  const unit = input.units[0]
  assert.equal(results.get(unit.id), unit.text)
  assert.equal(displayTranslations("Codex:", [{ ...unit, translation: results.get(unit.id)! }]).length, 0)
  const calls = fixture.seen.length
  assert.deepEqual(await run(), results)
  assert.equal(fixture.seen.length, calls)
})

test("punctuation equivalence preserves content, native fragments and decoded string whitespace", () => {
  const unit = (text: string): TextUnit => ({ id: "body", start: 0, end: text.length, text, format: "text" })
  assert.equal(translationIsUnchanged(unit("Codex: Ready!"), "Codex： Ready！"), true)
  assert.equal(translationIsUnchanged(unit("Ready."), "Ready。"), true)
  for (const output of ["codex： Ready!", "Codex： Ready?", "Codex Ready!", "Codex： Changed!"]) assert.equal(translationIsUnchanged(unit("Codex: Ready!"), output), false)
  assert.equal(translationIsUnchanged(unit("See https://gallery.example/a:b"), "See https://gallery.example/a：b"), false)
  const json: TextUnit = { ...unit('"Codex:"'), kind: "string", language: "json", content: "Codex:" }
  assert.equal(translationIsUnchanged(json, '"Codex："'), true)
  assert.equal(translationIsUnchanged(json, '" Codex："'), false)
  const literal: TextUnit = { ...json, content: undefined, language: "javascript" }
  assert.equal(translationIsUnchanged(literal, '"Codex："'), true)
  assert.equal(translationIsUnchanged(literal, '" Codex："'), false)
})
