import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { translationIsUnchanged } from "../src/documents/validation.ts"
import { displayTranslations, translatedMarkdown } from "../src/documents/presentation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TextUnit } from "../src/model/document.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("punctuation and whitespace changes complete, cache and suppress duplicate immersive rows", async (t) => {
  const source = "索引、队列与文件回归，类型/lint 和最终检查"
  const fixture = await chatFixture(t, () => "索引、队列 与 文件回归，类型 / lint 和最终检查。")
  const input = inputOf(parseMarkdown(source))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate("punctuation", input, (batch, signal) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate), new AbortController().signal)
  const results = await run()
  const unit = input.units[0]
  assert.equal(results.get(unit.id), unit.text)
  assert.equal(displayTranslations(source, [{ ...unit, translation: results.get(unit.id)! }]).length, 0)
  assert.equal(fixture.seen.length, 1)
  const calls = fixture.seen.length
  assert.deepEqual(await run(), results)
  assert.equal(fixture.seen.length, calls)
})

test("punctuation equivalence ignores prose punctuation additions and removals while preserving content and protected data", () => {
  const unit = (text: string): TextUnit => ({ id: "body", start: 0, end: text.length, text, format: "text" })
  assert.equal(translationIsUnchanged(unit("Codex: Ready!"), "Codex： Ready！"), true)
  assert.equal(translationIsUnchanged(unit("Ready."), "Ready。"), true)
  for (const output of ["Codex： Ready?", "Codex Ready!", "Codex Ready", "Codex: Ready!!!", "Codex、 Ready。"]) assert.equal(translationIsUnchanged(unit("Codex: Ready!"), output), true)
  assert.equal(translationIsUnchanged(unit("检查 队列"), "检\t查、队\u3000列。"), true)
  for (const output of ["codex： Ready!", "Codex： Changed!", "Codex： Ready2!", "Codex： Ready+!"]) assert.equal(translationIsUnchanged(unit("Codex: Ready!"), output), false)
  assert.equal(translationIsUnchanged(unit("See https://gallery.example/a:b"), "See https://gallery.example/a：b"), false)
  const markdown = (text: string) => inputOf(parseMarkdown(text)).units[0]
  assert.equal(translationIsUnchanged(markdown("Check `item.id`, then continue"), "Check `item.id` then continue。"), true)
  assert.equal(translationIsUnchanged(markdown("Check `item.id`, then continue"), "Check `itemid`, then continue。"), false)
  assert.equal(translationIsUnchanged(markdown("Read [guide](https://gallery.example/a-b)"), "Read [guide](https://gallery.example/ab)。"), false)
  const json: TextUnit = { ...unit('"Codex:"'), kind: "string", language: "json", content: "Codex:" }
  assert.equal(translationIsUnchanged(json, '"Codex："'), true)
  assert.equal(translationIsUnchanged(json, '"Codex"'), true)
  assert.equal(translationIsUnchanged(json, '" Codex："'), false)
  const literal: TextUnit = { ...json, content: undefined, language: "javascript" }
  assert.equal(translationIsUnchanged(literal, '"Codex："'), true)
  assert.equal(translationIsUnchanged(literal, '"Codex!"'), true)
  assert.equal(translationIsUnchanged(literal, '" Codex："'), false)
})

test("progress and batch completion publish the same finalized results to cache, reading and preview", async (t) => {
  for (const progressive of [false, true]) {
    await t.test(progressive ? "progress" : "batch", async (t) => {
      const parsed = parseMarkdown("检查队列\n\nRead the map.")
      const input = inputOf(parsed)
      const store = new TranslationStore()
      t.after(() => store.clear())
      const completed: string[] = []
      const result = await store.translate(
        "finalized",
        input,
        async (batch, _signal, accept) => {
          const items = batch.units.map((unit, index) => ({ id: unit.id, text: index ? "阅读地图。" : "检查 队列。" }))
          if (progressive) for (const item of items) accept(item)
          return items
        },
        new AbortController().signal,
        false,
        (item) => completed.push(String(item.text))
      )
      assert.deepEqual([...result.values()], ["检查队列", "阅读地图。"])
      assert.deepEqual(completed, [...result.values()])
      assert.equal(
        displayTranslations(
          parsed.source,
          input.units.map((unit) => ({ ...unit, translation: result.get(unit.id)! }))
        ).length,
        1
      )
      assert.equal(translatedMarkdown(parsed, result), "检查队列\n\n阅读地图。")
      assert.deepEqual(await store.translate("finalized", input, () => assert.fail("A completed result escaped the cache."), new AbortController().signal), result)
    })
  }
})
