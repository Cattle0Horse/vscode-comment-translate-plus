import assert from "node:assert/strict"
import { test } from "node:test"
import type { TextUnit } from "../src/model/document.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, modelFeedback, requestTranslation } from "./support/fixtures.ts"

test("item bounds and internal line breaks precede marker and native syntax damage", () => {
  const source = "Read [Guide](./guide.md) and `sourceId_abcdefghijklmnopqrstuvwxyz_123456789`."
  const unit = inputOf(parseMarkdown(source)).units[0]
  const prepared = prepareTranslation(unit, 32)
  assert.throws(() => prepared.restore(" \r\n "), /translation-item-invalid/)
  assert.throws(
    () => prepared.restore("X".repeat(200001) + "\n<context>"),
    (error) => error instanceof ModelRetry && /200000/.test(error.feedback.reason)
  )
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const output of [
      "<context>" + newline + "参考译文" + newline + "</context>",
      prepared.text.replace(/<CTP\d+>/u, "") + newline + "说明",
      prepared.text + "<CTP99>" + newline + "说明",
      prepared.text + "<CTPbroken>" + newline + "说明",
      prepared.text.replace("./guide.md", "./wrong.md") + newline + "说明"
    ])
      assert.throws(
        () => prepared.restore(output),
        (error) => error instanceof ModelRetry && /internal line break/.test(error.feedback.reason)
      )
  }
})

test("marker syntax precedes marker counts while complete native string fragments may reorder", () => {
  const source = "Read `sourceId_abcdefghijklmnopqrstuvwxyz_123456789`."
  const prepared = prepareTranslation(inputOf(parseMarkdown(source)).units[0], 32)
  for (const output of ["阅读 <CTP99>。", "阅读 <CTPbroken>。"]) {
    assert.throws(
      () => prepared.restore(output),
      (error) => error instanceof ModelRetry && /Unknown marker|malformed marker/.test(error.feedback.reason)
    )
  }
  const text = "Read {first} and {second}."
  const unit: TextUnit = {
    id: "python",
    start: 0,
    end: text.length,
    text,
    language: "python",
    kind: "string",
    format: "text",
    protected: [...text.matchAll(/\{\w+\}/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  }
  const string = prepareTranslation(unit, 32)
  assert.throws(
    () => string.restore("阅读 {second}。"),
    (error) => error instanceof ModelRetry && /native source fragment/.test(error.feedback.reason)
  )
  const escapes = "Read \\t then \\a."
  const escaped = prepareTranslation(
    { ...unit, text: escapes, end: escapes.length, protected: [...escapes.matchAll(/\\[ta]/gu)].map((match) => ({ start: match.index, end: match.index + 2 })) },
    32
  )
  assert.equal(escaped.restore("阅读 \\a 然后 \\t。"), "阅读 \\a 然后 \\t。")
  for (const invalid of ["阅读 \\a。", "阅读 \\a 和 \\a。", "阅读 \\a 然后 \\b。"]) assert.throws(() => escaped.restore(invalid), /structure-invalid/u)
  assert.throws(
    () => string.restore("阅读 {second}\n说明。"),
    (error) => error instanceof ModelRetry && /internal line break/.test(error.feedback.reason)
  )
})

test("specific protected data damage precedes incidental brackets and follows a stable priority", () => {
  for (const source of ["Read [Guide](./guide.md) and <span>details</span>.", "Read <span>details</span> and [Guide](./guide.md)."])
    for (const format of ["markdown", "text"] as const) {
      const unit: TextUnit = { id: "fragments", start: 0, end: source.length, text: source, format }
      const failure = validateTranslation(unit, "阅读指南和详情。")
      assert.ok(failure instanceof ModelRetry && /link targets/.test(failure.feedback.reason))
      assert.equal(failure.difference?.expected, "./guide.md")
    }
})

test("synthetic context-only output retries the source with line-break feedback and caches only the repaired item", async (t) => {
  const source = "Printed maps are available at the desk. See the [Visitor Guide](../guide.md#reading-room)."
  const reference = "# Museum Catalog\n\nThis fictional collection includes maps and pottery.\n\n## Reading Room"
  const wrong = "<context>\n# 博物馆目录\n\n这个虚构的馆藏包括地图与陶器。\n\n## 阅览室\n</context>"
  const fixed = "服务台备有纸质地图。请参阅[游客指南](../guide.md#reading-room)。"
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "正确邻项。\n%%\n" + wrong : fixed))
  const parsed = inputOf(parseMarkdown("Read the neighbouring rule.\n\n" + source))
  const input = { units: [parsed.units[0], { ...parsed.units[1], reference: [{ kind: "Section", text: reference }] }] }
  const events: TranslationEvent[] = []
  const published: string[] = []
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate(
      "validation-order",
      input,
      (input, signal, completed) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  const result = await run()
  assert.equal(result.get(input.units[1].id), fixed)
  assert.deepEqual(published, ["正确邻项。", fixed])
  assert.deepEqual(
    fixture.seen.map(({ items }) => items.length),
    [2, 1]
  )
  assert.match(modelFeedback(fixture.seen[1].body), /internal line break/)
  assert.match(modelFeedback(fixture.seen[1].body), /Exclude the reference\/context/)
  const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
  assert.equal(failure.code, "translation-structure-invalid")
  assert.equal(failure.difference.actual, "包含内部换行")
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})

test("line-break feedback precedes diagnostic leakage, which still rejects structurally valid single-line output", async (t) => {
  const replies = ["", "translation-item-invalid\n参考译文。", "translation-structure-invalid 诊断被错误翻译。", "阅读当前规则。"]
  const fixture = await chatFixture(t, (_body, _items, call) => replies[call - 1])
  const settings = { ...fixture.settings, maxTranslationAttempts: replies.length }
  const input = inputOf(parseMarkdown("Read the current rule."))
  const events: TranslationEvent[] = []
  const published: string[] = []
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.text), {
    details: false,
    emit: (event) => events.push(event)
  })
  assert.equal(result[0].text, replies.at(-1))
  assert.deepEqual(published, [replies.at(-1)])
  const failures = events.flatMap((event) => (event.kind === "request" ? event.failures : []))
  assert.deepEqual(
    failures.map((failure) => failure.code),
    ["translation-item-invalid", "translation-structure-invalid", "translation-feedback-leaked"]
  )
  assert.match(modelFeedback(fixture.seen[2].body), /internal line break/)
  assert.match(modelFeedback(fixture.seen[3].body), /Exclude diagnostic text/)
})
