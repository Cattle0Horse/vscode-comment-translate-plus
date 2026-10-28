import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { splitTranslations } from "../src/translation/providers/prompts.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { TranslationStore } from "../src/translation/store.ts"

test("numeric prose preserves values while translating sentence punctuation, ranges and units", () => {
  for (const [source, output] of [
    ["Wait at most 86400000.", "最多等待 86400000。"],
    ["Wait 6000-240000 milliseconds.", "等待 6000 到 240000 毫秒。"],
    ["Generate a 2048-bit key.", "生成 2048 位密钥。"],
    ["Scan B2:G250 or Demo!B2:G250.", "扫描 B2:G250 或 Demo!B2:G250。"]
  ])
    for (const format of ["text", "markdown"] as const) {
      const unit = { id: "numeric", start: 0, end: source.length, text: source, format }
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.restore(output), output)
      assert.equal(validateTranslation(unit, output), undefined)
      const changed = output.replace(/86400000|240000|2048|G250/u, "99999")
      assert.throws(() => prepared.restore(changed), /structure-invalid/u)
    }
})

test("template URLs are indivisible protected fragments including parameters and trailing paths", () => {
  for (const url of [
    "https://example.com/sheets/d/<BOOK_ID>/",
    "https://example.com/sheets/d/<BOOK_ID>/edit?tab=<TAB_ID>#range",
    "https://example.com/slides/d/<DECK_ID>/...",
    "https://example.com/sheets/d/{item}",
    "https://example.com/sheets/d/${item}",
    "https://example.com/sheets/d/{item}/edit?tab=${tab}#range"
  ])
    for (const format of ["text", "markdown"] as const) {
      const source = "Open " + url + " now."
      const unit = { id: "url", start: 0, end: source.length, text: source, format }
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.text, "Open <CTP0> now.")
      const expected = "现在打开 " + url + "。"
      assert.equal(prepared.restore("现在打开 <CTP0>。"), expected)
      assert.equal(validateTranslation(unit, expected), undefined)
      assert.equal(prepared.restore(expected), expected)
      for (const damaged of ["现在打开。", "现在打开 <CTP0><CTP0>。", "现在打开 <CTP9>。", expected.replace(/BOOK_ID|DECK_ID|item/u, "other")])
        assert.throws(() => prepared.restore(damaged), /marker-mismatch/u)
    }
})

test("template URL recognition preserves containing code and neighbouring HTML ownership", () => {
  const code = "`https://example.com/sheets/d/<BOOK_ID>/`"
  const source = "Open " + code + " now."
  const unit = { id: "code", start: 0, end: source.length, text: source, format: "markdown" as const }
  const prepared = prepareTranslation(unit, 32)
  assert.equal(prepared.text, "Open <CTP0> now.")
  assert.equal(prepared.restore("打开 <CTP0>。"), "打开 " + code + "。")
  const html = "Open https://example.com/path/<b>important</b> now."
  const htmlUnit = { ...unit, text: html, end: html.length }
  const htmlPrepared = prepareTranslation(htmlUnit, 32)
  assert.ok(htmlPrepared.text.includes("important"), "Ordinary HTML prose was swallowed by a template URL.")
  const output = htmlPrepared.restore(htmlPrepared.text.replace("important", "重要"))
  assert.equal(output, html.replace("important", "重要"))
  assert.equal(validateTranslation(htmlUnit, output), undefined)
})

test("Chinese sentence punctuation stays outside bare URLs while explicit targets stay exact", () => {
  for (const format of ["text", "markdown"] as const) {
    const url = "https://example.com/a-long-resource"
    const source = "Open " + url + " now."
    const unit = { id: "punctuation", start: 0, end: source.length, text: source, format }
    for (const punctuation of ["，", "。", "！", "？", "；"]) {
      const output = "打开 " + url + punctuation
      assert.equal(validateTranslation(unit, prepareTranslation(unit, 32).restore(output)), undefined)
    }
    for (const source of ["Open [guide](" + url + "。)", "Open <" + url + "。>"]) {
      const explicit = { ...unit, text: source, end: source.length }
      assert.ok(validateTranslation(explicit, source.replace("。", "")), "Sentence punctuation rules must not alter an explicit link destination.")
    }
  }
})

test("an exact URL marker may echo a complete code wrapper without hiding source link syntax", () => {
  for (const source of ["Open https://example.com/a-long-resource.", "Open [guide](https://example.com/a-long-resource)."])
    for (const format of ["text", "markdown"] as const) {
      const unit = { id: "wrapper", start: 0, end: source.length, text: source, format }
      const prepared = prepareTranslation(unit, 32)
      const output = prepared.text.replace("Open", "打开").replace("<CTP0>", "`<CTP0>`")
      const restored = prepared.restore(output)
      assert.equal(restored, source.replace("Open", "打开"))
      assert.equal(validateTranslation(unit, restored), undefined)
      assert.equal(prepared.restore(output.replace("<CTP0>", "https://example.com/a-long-resource")), restored, "Expanded URL data must use the same representation rule.")
      const malformed = prepared.restore(output.replace("`<CTP0>`", "`<CTP0>"))
      assert.equal(
        malformed,
        source.replace("Open", "打开").replace("https://example.com/a-long-resource", "`https://example.com/a-long-resource"),
        "An incomplete wrapper must not be silently repaired."
      )
      assert.ok(validateTranslation(unit, prepared.restore(output.replace("`<CTP0>`", "`extra <CTP0>`"))), "A wrapper containing extra prose must not be removed.")
    }
})

test("nontrailing empty slots cannot establish batch ownership", () => {
  for (const output of ["%%\n第一项译文\n%%\n第三项译文", "第一项译文\n%%\n\n%%\n第二项译文"]) assert.throws(() => splitTranslations(output, "%%", 3), /items-mismatch/u)
  assert.deepEqual(splitTranslations("第一项译文\n%%\n", "%%", 2), ["第一项译文", ""])
})

test("ambiguous batch output is never published or cached under a neighbouring item", async (t) => {
  const source = "First original paragraph.\n\nSecond original paragraph.\n\nThird original paragraph."
  const input = inputOf(parseMarkdown(source))
  const outputs = ["第一段译文。", "第二段译文。", "第三段译文。"]
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 1) return "%%\n" + outputs[0] + "\n%%\n" + outputs[2]
    return items.map((item) => outputs[input.units.findIndex((unit) => unit.text === item)]).join("\n%%\n")
  })
  const published: string[] = []
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate(
      "ambiguous",
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, { ...fixture.settings, batchBySemanticScope: false }, batch, signal, fixture.gate, completed),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  const results = await run()
  assert.deepEqual(
    input.units.map((unit) => results.get(unit.id)),
    outputs
  )
  assert.deepEqual([...published].sort(), [...outputs].sort())
  assert.equal(fixture.seen[0].items.length, 3)
  assert.ok(fixture.seen.length > 1)
  const requests = fixture.seen.length
  assert.deepEqual(await run(), results)
  assert.equal(fixture.seen.length, requests, "Corrected results did not enter the shared cache.")
})
