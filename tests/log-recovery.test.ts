import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { TranslationEvent } from "../src/model/events.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, listBatch, requestTranslation, modelFeedback } from "./support/fixtures.ts"

test("Sources recovery appends correction instructions after the unchanged template prefix and caches the accepted heading", async (t) => {
  for (const custom of [false, true]) {
    const fixture = await chatFixture(t, (_body, _items, call) => {
      if (call === 1) return "用于理解的上下文：\n<context>\n## 博物馆游客指南\n</context>"
      return "来源"
    })
    const settings = { ...fixture.settings, ...(custom ? { systemPrompt: "", userPrompt: "${content}" } : {}) }
    const unit = inputOf(parseMarkdown("## Sources")).units[0]
    const input = prepareInput(settings, { units: [{ ...unit, reference: [{ kind: "Section", text: "# Museum Visitor Guide\n\nDescribe the imaginary map gallery." }] }] })
    const store = new TranslationStore()
    const run = () =>
      store.translate("appended-correction", input, (input, signal, completed) => fixture.service.request(settings, input, signal, fixture.gate, completed), new AbortController().signal)
    const result = await run()
    assert.equal(result.get(unit.id), "## 来源")
    assert.equal(fixture.seen.length, 2)
    const prefix = fixture.seen[0].body.messages
    assert.deepEqual(fixture.seen[1].body.messages.slice(0, prefix.length), prefix, "Retry notes disrupted the existing template message prefix.")
    assert.deepEqual(fixture.seen[1].body.messages.at(-2), { role: "assistant", content: "用于理解的上下文：\n<context>\n## 博物馆游客指南\n</context>" })
    const correction = fixture.seen[1].body.messages.at(-1)!
    assert.equal(correction.role, "user")
    assert.ok(correction.content.endsWith("Simplified Chinese:\n\nSources"), "Retry omitted the target language or current source heading.")
    assert.ok(!correction.content.includes("Museum Visitor"), "Retry source included reference content.")
    assert.deepEqual(await run(), result)
    assert.equal(fixture.seen.length, 2, "The correct heading did not enter the shared cache.")
    store.clear()
  }
})

test("synthetic visitor notes recover a single style-boundary line break before validation and cache on the first request", async (t) => {
  const summary =
    "**Reading room closes at dusk.** Return borrowed maps to /examples/catalog/{section}.md before leaving the building. The printed guide describes the map gallery and the courtyard garden."
  const cases = [
    {
      source: summary,
      output: "** 阅览室于黄昏关闭。  \n** 离开前请将借阅的地图归还到 /examples/catalog/{section}.md。纸质指南介绍地图画廊与庭院花园。"
    },
    {
      source: summary,
      output: "** 阅览室在黄昏关闭。  \n** 请在离开前将借阅的地图归还到 /examples/catalog/{section}.md。纸质指南介绍地图画廊与庭院花园。"
    },
    {
      source: summary,
      output: "** 阅览室的关闭时间为黄昏。  \n** 请在离馆前将借阅的地图归还到 /examples/catalog/{section}.md。纸质指南介绍地图画廊与庭院花园。"
    },
    {
      source: "5. **Write a shelf label** in `/examples/catalog/{section}.md` describing the available books (see below)",
      output: "** 编写书架标签  \n** 在 `/examples/catalog/{section}.md` 中介绍可借阅的图书（详见下文）"
    }
  ]
  for (const { source, output } of cases) {
    for (const newline of ["\n", "\r\n"]) {
      const fixture = await chatFixture(t, () => output.replaceAll("\n", newline))
      const input = prepareInput(fixture.settings, inputOf(parseMarkdown(source)))
      const unit = input.units[0]
      const store = new TranslationStore()
      const run = () =>
        store.translate(
          "logged-style",
          input,
          (input, signal, completed) => fixture.service.request(fixture.settings, input, signal, fixture.gate, completed),
          new AbortController().signal
        )
      const result = await run()
      const translation = result.get(unit.id)!
      assert.equal(validateTranslation(unit, translation), undefined)
      assert.ok(translation.includes("**阅览室") || translation.includes("5. **编写"))
      assert.ok(!translation.includes("\n"))
      assert.deepEqual(await run(), result)
      assert.equal(fixture.seen.length, 1, "A recoverable boundary consumed retries or failed to cache.")
      store.clear()
    }
  }
})

test("style-boundary recovery preserves prose whitespace and rejects paragraph breaks or invalid markers", () => {
  const unit = inputOf(parseMarkdown("**Read *the original* document** and keep `sourceId`.")).units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  const output = "**阅读  仔细 *原始* 文档** 并保留 `sourceId`."
  const wrapped = output.replace("**阅读", "** \r\n 阅读").replace("文档**", "文档 \r\n **")
  const restored = prepared.restore(wrapped)
  assert.equal(validateTranslation(unit, restored), undefined)
  assert.ok(restored.includes("阅读  仔细 *原始* 文档"))
  assert.throws(() => prepared.restore(output.replace("文档**", "文档\n\n**")), /structure-invalid/)
  assert.equal(validateTranslation(unit, prepared.restore(wrapped.replace("`sourceId`", ""))), undefined)
  assert.throws(() => prepared.restore(output + "<CTP999>"), /marker-mismatch/)
  assert.throws(
    () => prepared.restore(wrapped + "<CTP999>"),
    (error) => error instanceof ModelRetry && /internal line break/.test(error.feedback.reason)
  )
})

test("a source-owned inline code marker may echo its exact backtick wrapper without changing code contents", async (t) => {
  const source = "- The `Example reading room: the northern exhibition hall` label identifies the gallery beside the courtyard garden."
  const output = "标签指出庭院花园旁的画廊为 `<CTP0>`。"
  const fixture = await chatFixture(t, () => output)
  const input = inputOf(parseMarkdown(source))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.ok(result[0].text.includes("`Example reading room: the northern exhibition hall`") && !result[0].text.includes("``"))
  assert.equal(fixture.seen.length, 1)
  const prepared = prepareTranslation(input.units[0], emptyPreserveTerms, 32)
  assert.throws(() => prepared.restore(output + " <CTP0>"), /marker-mismatch/)
  assert.equal(validateTranslation(input.units[0], prepared.restore(output + " `extra`")), undefined)
  const path = inputOf(parseMarkdown("Read /examples/catalog/entry.md.")).units[0]
  assert.equal(
    validateTranslation(path, prepareTranslation(path, emptyPreserveTerms, 32).restore("阅读 `/examples/catalog/entry.md`。")),
    undefined,
    "A new inline-code wrapper around a plain path was rejected."
  )
})

test("single-item model failures do not collapse learned capacity for later healthy batches", async (t) => {
  let broken = true
  const fixture = await chatFixture(t, (_body, items) => (broken ? "" : items.map((item) => item.replace("Original", "译文")).join("\n%%\n")))
  const settings = { ...fixture.settings, maxConcurrentRequests: 1 }
  await assert.rejects(requestTranslation(fixture.service, settings, listBatch(1), new AbortController().signal, fixture.gate), /translation-item-invalid/)
  assert.equal(fixture.seen.length, settings.maxTranslationAttempts)
  broken = false
  const before = fixture.seen.length
  const result = await requestTranslation(fixture.service, settings, listBatch(4), new AbortController().signal, fixture.gate)
  assert.equal(result.length, 4)
  assert.equal(fixture.seen.length - before, 1, "An unrelated single-item failure fragmented a healthy four-item request.")
})

test("synthetic booklet prose accepts added backticks on the first request and shares cached preview output", async (t) => {
  const source =
    "Arrange sample booklets by shelf number (`shelf01.md`), keeping the printed `catalogId`. The front cover mentions document/head/body, while the final page mentions body/html; the sample glossary explains these terms."
  const output = "按书架编号（`shelf01.md`）排列示例手册，保留纸质 `catalogId`。封面提到 `document/head/body`，末页提到 `body/html`；示例词汇表解释这些术语。"
  const fixture = await chatFixture(t, () => output)
  const input = inputOf(parseMarkdown(source))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate("logged-chapters", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  const result = await run()
  assert.equal(result.get(input.units[0].id), output)
  assert.equal(translatedMarkdown(parseMarkdown(source), result), output)
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 1)
})

test("synthetic HTML expansion receives a concrete correction and caches only the repaired booklet item", async (t) => {
  const source =
    "Arrange sample booklets by shelf number (`shelf01.md`), keeping the printed `catalogId`. The front cover mentions document/head/body, while the final page mentions body/html; the sample glossary explains these terms."
  const broken = "按书架编号（`shelf01.md`）排列示例手册，保留 `catalogId`。封面提到 document 的<head>和<body>部分，末页提到<body>和<html>部分；示例词汇表解释这些术语。"
  const fixed = "按书架编号（`shelf01.md`）排列示例手册，保留 `catalogId`。封面提到 document/head/body，末页提到 body/html；示例词汇表解释这些术语。"
  const fixture = await chatFixture(t, (body, _items, call) => {
    if (call === 1) return broken + "\n%%\n阅读相邻内容。"
    const correction = modelFeedback(body)
    return /Remove HTML/.test(correction) && /plain text without angle brackets/.test(correction) ? fixed : broken
  })
  const input = inputOf(parseMarkdown(source + "\n\nRead the neighbour."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const run = () =>
    store.translate(
      "logged-html",
      input,
      (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, undefined, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal
    )
  const result = await run()
  assert.equal(result.get(input.units[0].id), fixed)
  assert.equal(result.get(input.units[1].id), "阅读相邻内容。")
  assert.equal(fixture.seen[1].items.length, 1)
  const warning = events.find((event) => event.kind === "request" && event.failures.length)
  assert.ok(warning?.kind === "request")
  assert.match(warning.failures[0].difference.reason, /HTML/)
  assert.equal(warning.failures[0].difference.actual, "<head>")
  assert.equal(translatedMarkdown(parseMarkdown(source + "\n\nRead the neighbour."), result), fixed + "\n\n阅读相邻内容。")
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})
