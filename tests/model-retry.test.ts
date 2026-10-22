import assert from "node:assert/strict"
import { test } from "node:test"
import type { TranslationEvent } from "../src/model/events.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { modelFeedback, chatFixture, listBatch, requestTranslation, inputOf, dropLastProtection, modelContext } from "./support/fixtures.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { parseYaml } from "../src/documents/yaml.ts"

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

test("reference contamination is rejected with concrete added-code diagnostics and source-only recovery", async (t) => {
  const source =
    "- Use `get_artifact` or `read` to verify unsupported detailed claims. Before substantial delivery, check question coverage, key facts, constraints, and resources; repair affected content and disclose unresolved gaps or unperformed checks. Skip rereading when metadata/summary suffices or merely presenting a simple image."
  const reference =
    '- For final audio from `run_command`, save it under `/memory`, resolve its URL with `get_public_url`, then `report_artifacts` with `source="command"` and highlight the audio artifact.'
  const output =
    '使用 <CTP0> 或 <CTP1> 来验证那些不受支持的详细信息。在正式交付之前，需检查问题的覆盖范围、关键事实、约束条件及资源情况；修复受影响的内容，并揭示未解决的缺陷或未进行的检查。当元数据/摘要已经足够时，或者只需要展示简单的图像时，则无需重新阅读。对于来自 `run_command` 的最终音频文件，将其保存在 `/memory` 目录下，使用 `get_public_url` 获取其 URL，然后以 `source="command"` 形式调用 `report_artifacts`，同时突出显示该音频文件。'
  const translation =
    "使用 <CTP0> 或 <CTP1> 验证未经支持的具体论断。交付前检查覆盖范围、关键事实、约束及资源，修复问题并披露未完成的检查。元数据或摘要足够时，或仅展示简单图片时，无需重读。"
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
      assert.ok(published.every((text) => !text.includes("run_command")))
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
    assert.ok(modelContext(fixture.seen[0].body).includes("run_command"), "The replay omitted the neighbouring reference that contaminated the logged output.")
    assert.deepEqual(
      fixture.seen[1].body.messages.slice(0, fixture.seen[0].body.messages.length),
      fixture.seen[0].body.messages,
      "Recovery changed the user's original template or reference identity."
    )
    const hint = modelFeedback(fixture.seen[1].body)
    const feedbackLines = hint.split("\n")
    assert.equal(feedbackLines.length, 3, "Recovery must separate its heading, English reason and corrective instruction.")
    assert.ok(
      feedbackLines.slice(1).every((line) => line.length > 0 && !/\p{Script=Han}/u.test(line)),
      "Model feedback included a localized log reason."
    )
    assert.match(hint, /(?:do not|without|exclude|omit)[^.\n]*reference/i, "Recovery did not explicitly exclude reference content.")
    assert.match(hint, /(?:do not|without|exclude|omit)[^.\n]*(?:add|new)[^.\n]*code/i, "Recovery did not address the added code spans.")
    assert.ok(!hint.includes("run_command") && !hint.includes("translation-structure-invalid"), "Raw source fragments or diagnostic codes leaked into recovery instructions.")
    const failure = events.find((event) => event.kind === "request" && event.failures.length)
    assert.ok(failure?.kind === "request" && failure.failures[0].difference.reason.includes("新增"))
    assert.equal(failure.failures[0].difference.actual, "`/memory`")
    assert.equal(failure.failures[0].difference.modelReason, hint.split("\n")[1], "Model feedback and structured diagnostics disagree about the failure reason.")
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
    const input = inputOf(parseMarkdown("Keep `sourceId` unchanged."))
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
    assert.equal(hint.split("\n").length, 3, "A validator combined its reason and corrective instruction.")
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
