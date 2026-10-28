import assert from "node:assert/strict"
import { test } from "node:test"
import type { TranslationEvent } from "../src/model/events.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { modelFeedback, chatFixture, listBatch, requestTranslation, inputOf, dropLastProtection, modelContext } from "./support/fixtures.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { parseYaml } from "../src/documents/yaml.ts"

test("style recovery identifies the affected formatted source spans instead of bare delimiters", async (t) => {
  for (const scenario of [
    { source: "Remove ~~obsolete~~ text.", broken: "移除过时的文本。", fixed: "移除~~过时~~的文本。", spans: ["~~obsolete~~"] },
    { source: "Keep ~~first~~ and ~~second~~.", broken: "保留~~第一项~~和第二项。", fixed: "保留~~第一项~~和~~第二项~~。", spans: [], ambiguous: ["~~first~~", "~~second~~"] },
    { source: "Keep **very ~~important~~** text.", broken: "保留**非常重要**的文本。", fixed: "保留**非常~~重要~~**的文本。", spans: ["~~important~~"] }
  ]) {
    const events: TranslationEvent[] = []
    const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? scenario.broken : scenario.fixed))
    const result = await requestTranslation(fixture.service, fixture.settings, inputOf(parseMarkdown(scenario.source)), new AbortController().signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => events.push(event)
    })
    assert.equal(result[0].text, scenario.fixed)
    assert.equal(fixture.seen.length, 2)
    const feedback = modelFeedback(fixture.seen[1].body)
    for (const span of scenario.spans) assert.ok(feedback.includes(JSON.stringify(span)), "Recovery omitted the source span whose formatting needs repair.")
    for (const span of scenario.ambiguous ?? []) assert.ok(!feedback.includes(span), "Recovery guessed a damaged span from repeated delimiters.")
    const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
    for (const span of scenario.spans) assert.ok(failure.difference.expected?.includes(span), "Human diagnostics omitted the source span.")
  }
})

test("native fragment count failures carry observed counts into recovery and cache only the repaired output", async (t) => {
  const text = "Read {name} then {name}."
  const unit = {
    id: "native-count",
    start: 0,
    end: text.length,
    text,
    format: "text" as const,
    kind: "string" as const,
    protected: [...text.matchAll(/\{name\}/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  }
  for (const actual of [1, 3]) {
    const events: TranslationEvent[] = []
    const fixed = "阅读 {name}，然后阅读 {name}。"
    const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "阅读 " + "{name}".repeat(actual) + "。" : fixed))
    const store = new TranslationStore()
    t.after(() => store.clear())
    const run = () =>
      store.translate(
        "native-count",
        { units: [unit] },
        (input, signal, completed) =>
          requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
        new AbortController().signal
      )
    assert.equal((await run()).get(unit.id), fixed)
    const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
    assert.equal(failure.code, "translation-structure-invalid")
    assert.equal(failure.difference.expected, "2 次：{name}")
    assert.equal(failure.difference.actual, actual + " 次")
    const feedback = modelFeedback(fixture.seen[1].body)
    assert.ok(feedback.includes(failure.difference.modelReason!))
    assert.match(feedback, new RegExp(actual + " times; expected 2"))
    assert.ok(feedback.includes(JSON.stringify("{name}")), "Recovery omitted the native fragment whose occurrence count differs.")
    assert.equal((await run()).get(unit.id), fixed)
    assert.equal(fixture.seen.length, 2, "The validated recovery was not cached.")
  }
})

test("technical recovery rejects a longer path substituted for a native path before caching the repair", async (t) => {
  const source = "Read /gallery and /gallery/catalog."
  const broken = "阅读 /gallery 和 /gallery/catalog/catalog。"
  const fixed = "阅读 /gallery 和 /gallery/catalog。"
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? broken : fixed))
  const input = inputOf(parseMarkdown(source))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const run = () =>
    store.translate(
      "native-paths",
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal
    )
  assert.equal((await run()).get(input.units[0].id), fixed)
  const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
  assert.equal(failure.difference.expected, "1 次：/gallery/catalog")
  assert.equal(failure.difference.actual, "0 次")
  assert.ok(modelFeedback(fixture.seen[1].body).includes(failure.difference.modelReason!))
  assert.equal((await run()).get(input.units[0].id), fixed)
  assert.equal(fixture.seen.length, 2)
})

test("all source items are sent as one line and restore their original breaks while context keeps its format", async (t) => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = "Read first." + newline + "  Continue reading."
    const docstring = '"""' + source + '"""'
    const units = [
      inputOf(parseMarkdown(newline === "\r" ? source.replaceAll("\r", "\n") : source)).units[0],
      inputOf(parseYaml("message: " + JSON.stringify(source))).units[1],
      { id: "comment", start: 0, end: source.length, text: source, format: "text" as const, kind: "comment" as const },
      {
        id: "string",
        start: 0,
        end: docstring.length,
        text: docstring,
        format: "text" as const,
        kind: "string" as const,
        protected: [
          { start: 0, end: 3 },
          { start: docstring.length - 3, end: docstring.length }
        ]
      }
    ]
    const context = "Context first." + newline + "  Context second."
    for (const unit of units) {
      const fixture = await chatFixture(t, (_body, items) => items[0])
      const result = await requestTranslation(
        fixture.service,
        { ...fixture.settings, targetLanguage: "en" },
        { units: [{ ...unit, reference: [{ kind: "Section", text: context }] }] },
        new AbortController().signal,
        fixture.gate
      )
      assert.equal(result[0].text, unit.text)
      assert.ok(
        fixture.seen.every((request) => request.items.every((item) => !/[\r\n]/u.test(item))),
        "A source line break was sent as model prose."
      )
      assert.ok(modelContext(fixture.seen[0].body).includes(context), "Context line endings or indentation changed.")
    }
  }
})

test("line-break validation preserves multiline source, boundary whitespace and source-owned explanatory prose", async (t) => {
  for (const newline of ["\n", "\r\n"]) {
    for (const yaml of [false, true]) {
      const source = "The translation of this part is:" + newline + "Read the original document."
      const unit = yaml ? inputOf(parseYaml("message: " + JSON.stringify(source))).units[1] : inputOf(parseMarkdown(source)).units[0]
      const output = "这部分的翻译是： 阅读原始文档。"
      const fixture = await chatFixture(t, (_body, items) =>
        items[0].replace("The translation of this part is:", "这部分的翻译是：").replace("Read the original document.", "阅读原始文档。")
      )
      const result = await requestTranslation(fixture.service, fixture.settings, { units: [unit] }, new AbortController().signal, fixture.gate)
      assert.equal(result[0].text, yaml ? JSON.stringify(output) : output)
      assert.equal(fixture.seen.length, 1)
    }
    const fixture = await chatFixture(t, () => newline + "阅读原始文档。" + newline)
    const input = inputOf(parseMarkdown("Read the original document."))
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.ok(result[0].text.trim() === "阅读原始文档。")
    assert.equal(fixture.seen.length, 1, "Boundary whitespace was mistaken for an internal line break.")
  }
})

test("repeated new internal line breaks exhaust existing attempts and never enter the result cache", async (t) => {
  const fixture = await chatFixture(t, () => "这部分的翻译是：\n阅读原始文档。")
  const settings = { ...fixture.settings, maxTranslationAttempts: 2 }
  const input = prepareInput(settings, inputOf(parseMarkdown("Read the original document.")))
  const store = new TranslationStore()
  const published: string[] = []
  const run = () =>
    store.translate(
      "line-break-exhaustion",
      input,
      (input, signal, completed) => fixture.service.request(settings, input, signal, fixture.gate, completed),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  await assert.rejects(run(), /translation-structure-invalid/)
  assert.equal(fixture.seen.length, 2)
  await assert.rejects(run(), /translation-structure-invalid/)
  assert.equal(fixture.seen.length, 4, "An invalid result was cached or the per-item attempt limit changed.")
  assert.deepEqual(published, [])
  store.clear()
})

test("added internal line breaks in single-line source retry without publishing or caching the explanation", async (t) => {
  for (const newline of ["\n", "\r\n"]) {
    for (const format of ["markdown", "yaml", "comment"] as const) {
      const source = "Read the original document."
      const unit =
        format === "yaml"
          ? inputOf(parseYaml('message: "' + source + '"')).units[1]
          : format === "markdown"
            ? inputOf(parseMarkdown(source)).units[0]
            : { id: "comment", start: 0, end: source.length, text: source, format: "text" as const, kind: "comment" as const }
      const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "这部分的翻译是：" + newline + "阅读原始文档。" : "阅读原始文档。"))
      const settings = { ...fixture.settings, maxTranslationAttempts: 2 }
      const input = prepareInput(settings, { units: [unit] })
      const store = new TranslationStore()
      const published: string[] = []
      const events: TranslationEvent[] = []
      const run = () =>
        store.translate(
          "line-break",
          input,
          (input, signal, completed) => fixture.service.request(settings, input, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
          new AbortController().signal,
          false,
          (item) => published.push(item.text)
        )
      const result = await run()
      assert.equal(fixture.seen.length, 2, "An explanation separated by a newline was accepted.")
      assert.ok(published.every((text) => !text.includes("这部分的翻译是")))
      assert.ok(events.some((event) => event.kind === "request" && event.failures.some((failure) => failure.difference.reason.includes("内部换行"))))
      assert.deepEqual(await run(), result)
      assert.equal(fixture.seen.length, 2, "The validated recovery was not cached.")
      store.clear()
    }
  }
})

test("context continuation after an internal line break is rejected, regenerated and cached without the continuation", async (t) => {
  const source =
    "- Use `open_sample` or `read` to view the museum catalog. The north gallery contains maps and travel diaries, while the courtyard displays handmade pottery. Printed labels describe the year and place of each object, and visitors may borrow a magnifying glass from the front desk."
  const reference =
    "- The sample pottery list is available through `sample_task`; its shelf map is stored in `/examples`, and `sample_link` opens the illustrated index for the courtyard collection."
  const output =
    "使用 `open_sample` 或 `read` 查看博物馆目录。北侧画廊收藏地图与旅行日记，庭院则陈列手工陶器。纸质标签介绍每件展品的年代与产地，游客还可在服务台借用放大镜。\n\n通过 `sample_task` 查看示例陶器清单；书架地图保存在 `/examples` 中，`sample_link` 可打开庭院藏品的插图索引。"
  const translation = "使用 `open_sample` 或 `read` 查看博物馆目录。北侧画廊收藏地图与旅行日记，庭院陈列手工陶器。纸质标签介绍展品年代与产地，游客可在服务台借用放大镜。"
  for (const recover of [true, false]) {
    const events: TranslationEvent[] = []
    const published: string[] = []
    const fixture = await chatFixture(t, (_body, _items, call) => (recover && call > 1 ? translation : output))
    const target = inputOf(parseMarkdown(source + "\n" + reference)).units[0]
    const prepared = prepareInput(fixture.settings, { units: [target] })
    const store = new TranslationStore()
    const action: Parameters<TranslationStore["translate"]>[2] = (input, signal, completed, interests) =>
      fixture.service.request(fixture.settings, input, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }, interests)
    const run = () => store.translate("reference-contamination", prepared, action, new AbortController().signal, false, (item) => published.push(item.text))
    if (recover) {
      const result = await run()
      assert.equal(result.size, 1)
      assert.equal(fixture.seen.length, 2)
      assert.ok(published.every((text) => !text.includes("sample_task")))
      const before = fixture.seen.length
      assert.deepEqual(await run(), result)
      assert.equal(fixture.seen.length, before, "The validated recovery was not cached.")
    } else {
      await assert.rejects(run(), /translation-structure-invalid/)
      assert.deepEqual(published, [], "A contaminated result was published before recovery.")
      assert.equal(fixture.seen.length, 3)
      await assert.rejects(run(), /translation-structure-invalid/)
      assert.equal(fixture.seen.length, 6, "A contaminated result entered the translation cache.")
    }
    assert.ok(modelContext(fixture.seen[0].body).includes("sample_task"), "The replay omitted the neighbouring reference that contaminated the synthetic output.")
    assert.deepEqual(
      fixture.seen[1].body.messages.slice(0, fixture.seen[0].body.messages.length),
      fixture.seen[0].body.messages,
      "Recovery changed the user's original template or reference identity."
    )
    const hint = modelFeedback(fixture.seen[1].body)
    const feedbackLines = hint.split("\n")
    assert.equal(feedbackLines.length, 2, "Recovery must keep its prefixed reason and correction on two lines.")
    assert.ok(feedbackLines[0].startsWith("Previous response errors: ") && feedbackLines[1].startsWith("Correction: "))
    assert.ok(
      feedbackLines.every((line) => line.length > 0 && !/\p{Script=Han}/u.test(line)),
      "Model feedback included a localized log reason."
    )
    assert.match(hint, /(?:do not|without|exclude|omit)[^.\n]*reference/i, "Recovery did not explicitly exclude reference content.")
    assert.match(hint, /preceding or following blocks/i)
    assert.ok(!hint.includes("sample_task") && !hint.includes("translation-structure-invalid"), "Raw source fragments or diagnostic codes leaked into recovery instructions.")
    const failure = events.find((event) => event.kind === "request" && event.failures.length)
    assert.ok(failure?.kind === "request" && failure.failures[0].difference.reason.includes("内部换行"))
    assert.equal(failure.failures[0].difference.actual, "包含内部换行")
    assert.equal(
      failure.failures[0].difference.modelReason,
      feedbackLines[0].slice("Previous response errors: ".length),
      "Model feedback and structured diagnostics disagree about the failure reason."
    )
    store.clear()
  }
})

test("single-item validation recovery omits batch metadata and keeps original messages intact", async (t) => {
  for (const scenario of [
    { code: "translation-item-invalid", damage: (_text: string) => "" },
    { code: "translation-items-mismatch", damage: (text: string) => text + "\n%%\n" + text },
    { code: "translation-marker-mismatch", damage: dropLastProtection },
    { code: "translation-structure-invalid", damage: (text: string) => text + "\n\nExtra paragraph." }
  ]) {
    const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? scenario.damage(items[0]) : items[0]))
    const input = inputOf(parseMarkdown("Keep `sourceId_abcdefghijklmnopqrstuvwxyz_123456789` unchanged."))
    const events: TranslationEvent[] = []
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => events.push(event)
    })
    assert.equal(result[0].text, input.units[0].text)
    assert.equal(fixture.seen.length, 2)
    assert.ok(
      events.some((event) => event.kind === "request" && event.failures.some((failure) => failure.code === scenario.code)),
      "The regression did not trigger its intended validator."
    )
    assert.deepEqual(fixture.seen[1].body.messages.slice(0, fixture.seen[0].body.messages.length), fixture.seen[0].body.messages)
    const hint = modelFeedback(fixture.seen[1].body)
    assert.equal(hint.split("\n").length, 2, "A validator combined its reason and corrective instruction.")
    assert.ok(!/\p{Script=Han}/u.test(hint), "A validator sent a localized log reason to the model.")
    assert.ok(!/Item \d|Current request:|separator|\b(?:translation|service)-[a-z-]+/.test(hint), "Single-item recovery retained batch metadata or diagnostic codes: " + scenario.code)
  }
})

test("an ordinary failure is not model-retryable merely because its message matches an error code", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items[0])
  const events: TranslationEvent[] = []
  fixture.gate.run = async () => {
    throw Error("translation-item-invalid")
  }
  await assert.rejects(
    requestTranslation(fixture.service, fixture.settings, listBatch(1), new AbortController().signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => events.push(event)
    }),
    /translation-item-invalid/
  )
  assert.equal(events.filter((event) => event.kind === "request").length, 1, "The engine retried an ordinary infrastructure failure based on its message string.")
  assert.equal(fixture.seen.length, 0)
})

test("an explicit model retry carries its own feedback independently of its diagnostic code", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items[0])
  const secret = "fixture-model-retry-credential"
  const feedback = "Preserve ${targetLang} literally and omit " + secret + "."
  const original = fixture.gate.run.bind(fixture.gate)
  let raised = false
  fixture.gate.run = (work, signal) => {
    if (!raised) {
      raised = true
      return Promise.reject(
        new ModelRetry({ reason: "The response needs a validator review.", instruction: feedback }, { code: "validator-review", difference: { reason: "HUMAN_DIAGNOSTIC_ONLY" } })
      )
    }
    return original(work, signal)
  }
  const events: TranslationEvent[] = []
  const result = await requestTranslation(fixture.service, { ...fixture.settings, apiKey: secret }, listBatch(1), new AbortController().signal, fixture.gate, undefined, {
    details: false,
    emit: (event) => events.push(event)
  })
  assert.equal(result[0].text, "1. Original paragraph 1.")
  const note = modelFeedback(fixture.seen[0].body)
  assert.ok(note.endsWith(feedback.replace(secret, "[REDACTED]")), "The exception's instruction was replaced by a code-based hint or interpreted as a template.")
  assert.ok(!note.includes("HUMAN_DIAGNOSTIC_ONLY") && !note.includes(secret))
  const failed = events.find((event) => event.kind === "request" && event.failures.length)
  assert.ok(failed?.kind === "request" && failed.failures[0].difference.reason === "HUMAN_DIAGNOSTIC_ONLY")
})

test("a temporary connection failure retries the original batch without adding model feedback", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? { disconnect: true } : items.join("\n%%\n")))
  const input = listBatch(4)
  const result = await requestTranslation(fixture.service, { ...fixture.settings, maxTranslationAttempts: 2 }, input, new AbortController().signal, fixture.gate)
  assert.equal(result.length, 4)
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(fixture.seen[1].body, fixture.seen[0].body, "Network recovery changed the batch or appended a model correction.")
  assert.equal(fixture.seen[1].body.messages.filter((message) => message.role === "user").length, 1)
})

test("network recovery preserves the last model correction and completed neighbours within one shared attempt limit", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 1) return "译文 neighbour.\n%%\n"
    if (call === 2) return { disconnect: true }
    return items[0].replace("Original", "译文")
  })
  const input = listBatch(2)
  const published: string[] = []
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.id))
  assert.equal(result.length, 2)
  assert.equal(fixture.seen.length, 3)
  assert.deepEqual(fixture.seen[2].body, fixture.seen[1].body, "A transport failure erased or duplicated the existing model correction.")
  assert.equal(fixture.seen[2].items.length, 1)
  assert.equal(published.filter((id) => id === input.units[0].id).length, 1)
  assert.ok(!modelFeedback(fixture.seen[2].body).includes("service-network-failed"))
})

test("exhausted network retries report the latest transport error and HTTP authentication errors remain terminal", async (t) => {
  for (const status of [undefined, 401]) {
    const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "" : status ? { status } : { disconnect: true }))
    const events: TranslationEvent[] = []
    await assert.rejects(
      requestTranslation(fixture.service, fixture.settings, listBatch(1), new AbortController().signal, fixture.gate, undefined, {
        details: false,
        emit: (event) => events.push(event)
      }),
      status ? /service-http-401/ : /service-network-failed/
    )
    assert.equal(fixture.seen.length, status ? 2 : 3)
    const finish = events.find((event) => event.kind === "finish")!
    assert.ok(finish.kind === "finish" && finish.failures[0].code === (status ? "service-http-401" : "service-network-failed"))
  }
})

test("network recovery respects a one-attempt limit and explicit cancellation", async (t) => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController()
    const fixture = await chatFixture(t, () => {
      if (cancelled) controller.abort("user-cancelled")
      return { disconnect: true }
    })
    const events: TranslationEvent[] = []
    const published: string[] = []
    await assert.rejects(
      requestTranslation(
        fixture.service,
        { ...fixture.settings, maxTranslationAttempts: cancelled ? 3 : 1 },
        listBatch(1),
        controller.signal,
        fixture.gate,
        (item) => published.push(item.text),
        { details: false, emit: (event) => events.push(event) }
      )
    )
    assert.equal(fixture.seen.length, 1)
    assert.deepEqual(published, [])
    const finish = events.find((event) => event.kind === "finish")!
    assert.ok(finish.kind === "finish" && finish.status === (cancelled ? "cancelled" : "failed"))
  }
})

test("incomplete code boundaries take priority over apparent HTML damage and recover without publishing or caching the broken item", async (t) => {
  const source = "Compare `<north field>`, `<south field>`, and `<west field>`."
  const broken = "比较 `<north field>`、`<south field>》和 `<west field>`。"
  const fixed = "比较 `<north field>`、`<south field>` 和 `<west field>`。"
  const neighbour = "阅读相邻内容。"
  const published: string[] = []
  const events: TranslationEvent[] = []
  const fixture = await chatFixture(t, (_body, _items, call) => {
    if (call === 1) return broken + "\n%%\n" + neighbour
    assert.deepEqual(published, [neighbour], "The incomplete code span was published or the valid neighbour was discarded.")
    return fixed
  })
  const input = inputOf(parseMarkdown(source + "\n\nRead the neighbour."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate(
      "code-boundary-recovery",
      input,
      (request, signal) =>
        requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, (item) => published.push(item.text), {
          details: false,
          emit: (event) => events.push(event)
        }),
      new AbortController().signal
    )
  const result = await run()
  assert.deepEqual([...result.values()], [fixed, neighbour])
  assert.deepEqual(published, [neighbour, fixed])
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(fixture.seen[1].items, [source])
  const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
  assert.equal(failure.difference.actual, "`")
  assert.ok(failure.difference.modelReason)
  assert.ok(modelFeedback(fixture.seen[1].body).includes(failure.difference.modelReason), "The retry did not carry the diagnosed cause into the model request.")
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2, "The validated recovery was not cached.")
})

test("known structural errors send the matching correction and recover only the rejected item", async (t) => {
  for (const scenario of [
    {
      source: "Read [guide](https://example.com).",
      broken: "阅读 [指南](https://other.example)。",
      fixed: "阅读 [指南](https://example.com)。",
      fragment: "https://example.com",
      correction: /source link target/
    },
    { source: "Read the original document.", broken: "## 阅读原始文档。", fixed: "阅读原始文档。", fragment: "##", correction: /Remove headings/ },
    { source: "Read the original document.", broken: "阅读 <span>原始文档</span>。", fixed: "阅读原始文档。", fragment: "<span>", correction: /Remove HTML/ },
    { source: "Read the original document.", broken: "阅读 ~~原始文档~~。", fixed: "阅读原始文档。", fragment: "~~原始文档~~", correction: /Remove strikethrough/ },
    { source: "Read the original document.", broken: "阅读 <https://example.com>。", fixed: "阅读原始文档。", fragment: "<https://example.com>", correction: /Remove link targets/ },
    { source: "Read the original document.", broken: "阅读 \\*原始文档。", fixed: "阅读原始文档。", fragment: "\\*", correction: /Remove Markdown escape/ },
    { source: "Read <span>the original document</span>.", broken: "阅读 <div>原始文档</div>。", fixed: "阅读 <span>原始文档</span>。", fragment: "<span>", correction: /source HTML tags/ }
  ]) {
    const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? scenario.broken + "\n%%\n正确邻项。" : scenario.fixed))
    const input = inputOf(parseMarkdown(scenario.source + "\n\nRead the neighbour."))
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.deepEqual(
      result.map((item) => item.text),
      [scenario.fixed, "正确邻项。"]
    )
    assert.equal(fixture.seen[1].items.length, 1)
    assert.match(modelFeedback(fixture.seen[1].body), scenario.correction)
    assert.ok(modelFeedback(fixture.seen[1].body).includes(JSON.stringify(scenario.fragment)), "Recovery omitted the observed damaged or added fragment.")
    assert.ok(!modelFeedback(fixture.seen[1].body).includes("Preserve source syntax, document structure"))
  }
})
