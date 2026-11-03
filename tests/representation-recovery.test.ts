import assert from "node:assert/strict"
import { test } from "node:test"
import type { TextUnit } from "../src/model/document.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, modelFeedback, requestTranslation } from "./support/fixtures.ts"

const literal = '`entries[].state == "ready" && entries[].preview_url`'
const markerSource = "Check " + literal + " before continuing."
const markerUnit: TextUnit = { id: "marker", text: markerSource, start: 0, end: markerSource.length, format: "markdown" }

test("known marker shells recover without changing their exact source data", () => {
  const prepared = prepareTranslation(markerUnit, 32)
  for (const variant of ["<CTP0》", "＜CTP0＞", "《CTP0》", "<CTP0", "`CTP0`", "`<CTP0`", "`<CTP0》`", "`＜CTP0＞`"]) {
    const restored = prepared.restore("检查 " + variant + "。")
    assert.equal(restored, "检查 " + literal + "。", variant)
    assert.equal(validateTranslation(markerUnit, restored), undefined)
  }
  const text = "Keep <CTP0> beside " + literal + "."
  const unit = { ...markerUnit, text, end: text.length }
  const namespaced = prepareTranslation(unit, 32)
  assert.equal(namespaced.restore(namespaced.text.replace("<CTP1_0>", "＜CTP1_0》")), text)
})

test("marker recovery refuses unknown identities, duplicates, token continuations and literal collisions", () => {
  const prepared = prepareTranslation(markerUnit, 32)
  for (const variant of ["<CTP9》", "<CTP0x>", "<CTP0_extra", "<CTP0/extra", "<CTP0]", "<CTP0`", "``<CTP0`", "<CTP0> <CTP0》", "<CTP0》 " + literal, "<CTP0> ＜CTP9_0＞", "CTP0", ""]) {
    assert.throws(() => prepared.restore("检查 " + variant + "。"), ModelRetry, variant)
  }
  const text = "Keep CTP0 beside " + literal + "."
  const collision = prepareTranslation({ ...markerUnit, text, end: text.length }, 32)
  assert.equal(collision.restore(collision.text), text)
  assert.throws(() => collision.restore("保留 CTP0 和 `CTP0`。"), ModelRetry)
  const contextCollision = prepareTranslation(markerUnit, 32, "The label CTP0 is literal reference data.")
  assert.throws(() => contextCollision.restore("检查 `CTP0`。"), ModelRetry)
})

test("recovered markers publish and cache the restored source fragment without retrying", async (t) => {
  const fixture = await chatFixture(t, () => "检查 <CTP0》。")
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const run = () =>
    store.translate(
      "marker-shell",
      { units: [markerUnit] },
      (batch, signal, complete) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, complete),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  const result = await run()
  assert.equal(result.get(markerUnit.id), "检查 " + literal + "。")
  assert.deepEqual(published, ["检查 " + literal + "。"])
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 1, "A representational marker change must not consume retries or escape the cache.")
})

test("translated request instructions beside a reference envelope never publish or enter the cache", async (t) => {
  const text = "Verify the attachment before opening it."
  const output = "请仅参考所附信息理解正文。\n<context>虚构花园的开放时间。</context>"
  const fixture = await chatFixture(t, (_request, _items, call) => (call === 1 ? output : "打开附件前先检查附件。"))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const input = { units: [{ id: "body", text, start: 0, end: text.length, format: "markdown" as const, reference: [{ kind: "Neighbour", text: "The fictional garden opens at noon." }] }] }
  const run = () =>
    store.translate(
      "context-leak",
      input,
      (batch, signal, complete) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, complete),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  const result = await run()
  assert.deepEqual([...result.values()], ["打开附件前先检查附件。"])
  assert.deepEqual(published, ["打开附件前先检查附件。"])
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})

test("typographic path quotes are boundaries while path changes remain invalid", () => {
  for (const format of ["text", "markdown"] as const) {
    for (const kind of [undefined, "string"] as const) {
      const text = "Use '/archive' or '/project/notes'."
      const unit: TextUnit = { id: "paths", text, start: 0, end: text.length, format, kind }
      const prepared = prepareTranslation(unit, 32)
      for (const output of ["使用 ‘/archive’ 或 ‘/project/notes’。", "使用 “/archive” 或 “/project/notes”。"]) assert.equal(validateTranslation(unit, prepared.restore(output)), undefined)
      for (const output of ["使用 ‘/archive/extra’ 或 ‘/project/notes’。", "使用 ‘/project/notes’。", "使用 ‘/archive’、‘/archive’ 或 ‘/project/notes’。"])
        assert.throws(() => prepared.restore(output), ModelRetry)
    }
  }
})

test("numeric rates translate their prose denominator but preserve the numeric value and explicit paths", () => {
  for (const rate of ["0.2468/successful", "4800/request"]) {
    const [number] = rate.split("/")
    const text = "Charge " + rate + " request; save in '/archive/4800/request'."
    const unit: TextUnit = { id: "rate", text, start: 0, end: text.length, format: "text", kind: "string" }
    const prepared = prepareTranslation(unit, 32)
    const output = "每次成功请求收费 " + number + "；保存在 ‘/archive/4800/request’。"
    assert.equal(validateTranslation(unit, prepared.restore(output)), undefined)
    assert.throws(() => prepared.restore(output.replace(number, "9999")), ModelRetry)
    assert.throws(() => prepared.restore(output.replace("/archive/4800/request", "/archive/4800/changed")), ModelRetry)
  }
})

test("reference-definition damage retries with the source code boundary instead of asking to delete the description", async (t) => {
  const text = "`[audience]`: reader segment"
  const fixed = "`[audience]`: 读者群体"
  const fixture = await chatFixture(t, (request, _items, call) => {
    if (call === 1) return "[audience]: 读者群体"
    const feedback = modelFeedback(request)
    assert.ok(feedback.includes(JSON.stringify("`[audience]`")), "Recovery must locate the source literal whose delimiters were lost.")
    assert.match(feedback, /inline-code|backtick/u)
    return fixed
  })
  const result = await requestTranslation(
    fixture.service,
    fixture.settings,
    { units: [{ id: "label", text, start: 0, end: text.length, format: "markdown" }] },
    new AbortController().signal,
    fixture.gate
  )
  assert.equal(result[0].text, fixed)
  assert.equal(fixture.seen.length, 2)
})
