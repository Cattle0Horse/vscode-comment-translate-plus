import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { chatFixture, inputOf, listBatch, requestTranslation, modelFeedback } from "./support/fixtures.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { modelRequest, splitTranslations } from "../src/translation/providers/prompts.ts"
import { TranslationStore } from "../src/translation/store.ts"

for (const echo of ["request", "correction", "instruction"] as const) {
  test(`${echo} echoes reject the entire batch before publishing or caching unchanged tails`, async (t) => {
    const events: TranslationEvent[] = []
    const published: string[] = []
    const fixture = await chatFixture(t, (body, items, call) => {
      if (echo === "request" && call === 1) return body.messages.at(-1)!.content.replace(/\n/gu, "\r\n")
      if (echo !== "request" && call === 1) return "Incomplete answer."
      if (echo === "correction" && call === 2) return body.messages.at(-1)!.content
      if (echo === "instruction" && call === 2)
        return (
          modelFeedback(body)
            .split("\n")
            .find((line) => line.startsWith("Correction:"))! +
          "\n\n" +
          items.join("\n%%\n")
        )
      return items.map((item) => item.replace("Original", "正确译文")).join("\n%%\n")
    })
    const input = listBatch(4)
    const store = new TranslationStore()
    t.after(() => store.clear())
    const translate = () =>
      store.translate(
        "echo",
        input,
        (batch, signal) =>
          requestTranslation(fixture.service, { ...fixture.settings, batchShrinkFactor: 1 }, batch, signal, fixture.gate, (item) => published.push(item.text), {
            details: false,
            emit: (event) => events.push(event)
          }),
        new AbortController().signal
      )
    const result = await translate()
    assert.equal(result.size, input.units.length)
    assert.ok(
      [...result.values()].every((text) => text.includes("正确译文")),
      "Copied source tails were accepted as unchanged translations."
    )
    assert.ok(
      published.every((text) => text.includes("正确译文")),
      "A contaminated batch published a source tail before recovery."
    )
    const rejected = events.filter((event) => event.kind === "request" && event.failures.some((failure) => failure.code === "translation-feedback-leaked"))
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].kind === "request" && rejected[0].completed === 0 && rejected[0].failures.length === 4)
    for (const retry of fixture.seen.slice(echo === "request" ? 1 : 2)) {
      assert.ok(!retry.body.messages.some((message) => message.role === "assistant"), "A request echo was fed back as a previous translation.")
    }
    const before = fixture.seen.length
    assert.deepEqual(await translate(), result)
    assert.equal(fixture.seen.length, before, "Recovered translations were not cached.")
  })
}

test("persistent request echoes exhaust attempts without publishing or caching any source tail", async (t) => {
  let echo = true
  const published: string[] = []
  const fixture = await chatFixture(t, (body, items) => (echo ? body.messages.at(-1)!.content : items.map((item) => item.replace("Original", "正确译文")).join("\n%%\n")))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const input = listBatch(2)
  const translate = () =>
    store.translate(
      "persistent-echo",
      input,
      (batch, signal) =>
        requestTranslation(fixture.service, { ...fixture.settings, maxTranslationAttempts: 2, batchShrinkFactor: 1 }, batch, signal, fixture.gate, (item) => published.push(item.text)),
      new AbortController().signal
    )
  await assert.rejects(translate(), /translation-feedback-leaked/)
  assert.deepEqual(published, [])
  const before = fixture.seen.length
  assert.equal(before, 3, "Echo recovery did not obey the per-item attempt limit.")
  echo = false
  const result = await translate()
  assert.equal(result.size, 2)
  assert.ok([...result.values()].every((text) => text.includes("正确译文")))
  assert.ok(fixture.seen.length > before, "Failed echo results prevented a fresh request.")
})

test("content-only templates accept unchanged batches and repeated short items without treating source text as controls", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const input = inputOf(parseMarkdown("Return only the source text.\n\nlabel\n\nlabel"))
  const result = await requestTranslation(fixture.service, { ...fixture.settings, systemPrompt: "", userPrompt: "${content}" }, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    result.map((item) => item.text),
    input.units.map((unit) => unit.text)
  )
})

test("source-owned correction instructions remain valid unchanged content during retry", async (t) => {
  const source = "The response item boundaries do not match the source items. Return exactly one translation per source item, in the original order."
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "Incomplete answer." : items.join("\n%%\n")))
  const input = inputOf(parseMarkdown(source + "\n\nlabel"))
  const result = await requestTranslation(fixture.service, { ...fixture.settings, batchShrinkFactor: 1 }, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    result.map((item) => item.text),
    input.units.map((unit) => unit.text)
  )
})

test("marker recovery identifies the missing or repeated marker before resending only the failed source", async (t) => {
  for (const count of [0, 2]) {
    const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "正确邻项。\n%%\n" + items[1].replace("<CTP0>", "<CTP0>".repeat(count)) : items[0]))
    const input = inputOf(parseMarkdown("- Read the original document.\n- Keep `sourceId_abcdefghijklmnopqrstuvwxyz_123456789` unchanged."))
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.equal(result.length, 2)
    const retry = fixture.seen[1]
    assert.equal(retry.items.length, 1)
    assert.match(modelFeedback(retry.body), new RegExp(`Marker <CTP0> occurred ${count} times; expected exactly once`))
    assert.ok(retry.body.messages.at(-1)!.content.endsWith("Simplified Chinese:\n\nKeep <CTP0> unchanged."))
    assert.ok(!retry.body.messages.at(-1)!.content.includes("Read the original document."))
  }
})

test("retry ends with the complete current source after a concrete marker error, including literal template data", async (t) => {
  const source = "Keep <CTP0> and ${targetLang} {{#if context}} unchanged."
  const fixture = await chatFixture(t, (_body, items) => items[0])
  for (const userPrompt of [fixture.settings.userPrompt, "${content}", ""]) {
    const retry = modelRequest({
      settings: { ...fixture.settings, userPrompt },
      context: "# Reference only",
      items: [{ id: "one", text: source, format: "text", hasMarkers: true }],
      previousOutput: "Incorrect answer.",
      retryFeedback: [{ index: 0, reason: "<CTP0> occurred 0 times; expected exactly once.", instruction: "Preserve each marker exactly once." }]
    }).payload.messages.at(-1)!
    assert.equal(retry.role, "user")
    assert.ok(retry.content.indexOf("<CTP0> occurred 0 times") < retry.content.indexOf("Simplified Chinese:"))
    assert.ok(retry.content.endsWith("Simplified Chinese:\n\n" + source))
    assert.ok(!retry.content.includes("# Reference only"))
  }
})

test("same-request recovery retains original messages and only the latest assistant output with details disabled", async (t) => {
  const attempts = ["First invalid paragraph.\n\nExtra paragraph.", "Second invalid paragraph.\n\nAnother paragraph.", "正确译文。"]
  const fixture = await chatFixture(t, (_body, _items, call) => attempts[call - 1])
  const input = inputOf(parseMarkdown("Read the original document."))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, attempts[2])
  const prefix = fixture.seen[0].body.messages
  for (const [index, retry] of fixture.seen.slice(1).entries()) {
    assert.deepEqual(retry.body.messages.slice(0, prefix.length), prefix)
    assert.deepEqual(
      retry.body.messages.filter((message) => message.role === "assistant"),
      [{ role: "assistant", content: attempts[index] }]
    )
    assert.equal(retry.body.messages.at(-1)!.role, "user")
    assert.ok(modelFeedback(retry.body).includes("internal line break"))
  }
})

test("partial success carries only the aligned failed output while ambiguous shrinking omits unmapped history", async (t) => {
  for (const partial of [true, false]) {
    const fixture = await chatFixture(t, (_body, items, call) => {
      if (call === 1) return partial ? "正确邻项。\n%%\n\n\n" : "Ambiguous response without separators."
      return items.map((item) => item.replace("Original", "译文")).join("\n%%\n")
    })
    const input = listBatch(2)
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.equal(result.length, 2)
    for (const retry of fixture.seen.slice(1)) {
      assert.equal(retry.items.length, 1)
      const history = retry.body.messages.filter((message) => message.role === "assistant")
      if (partial) {
        assert.equal(history.length, 1)
        assert.ok(!history[0].content.includes("正确邻项"), "A successful neighbour leaked into failed-only history.")
        assert.equal(history[0].content.trim(), "")
      } else assert.equal(history.length, 0, "An ambiguous response was guessed into a smaller request.")
    }
    if (partial) assert.equal(result.find((item) => item.id === input.units[0].id)!.text, "1. 正确邻项。")
  }
})

test("ambiguous item counts recover through smaller batches without carrying obsolete counts into model feedback", async (t) => {
  for (const count of [2, 4]) {
    const events: TranslationEvent[] = []
    const published: string[] = []
    const fixture = await chatFixture(t, (_body, items) => (items.length > 1 ? "名称：ai-writer" : items[0].replace("Original", "译文")))
    const input = listBatch(count)
    const result = await requestTranslation(fixture.service, { ...fixture.settings }, input, new AbortController().signal, fixture.gate, (item) => published.push(item.text), {
      details: false,
      emit: (event) => events.push(event)
    })
    assert.equal(result.length, count)
    assert.deepEqual(
      published,
      result.map((item) => item.text)
    )
    assert.ok(result.every((item) => item.text.includes("译文") && !item.text.includes("名称：ai-writer")))
    assert.deepEqual(
      fixture.seen.map((request) => request.items.length),
      count === 2 ? [2, 1, 1] : [4, 2, 1, 1, 2, 1, 1]
    )
    const failures = events.flatMap((event) => (event.kind === "request" ? event.failures : []))
    assert.equal(failures[0].code, "translation-items-mismatch")
    assert.deepEqual(failures[0].difference.expected?.match(/\d+/gu), [String(count), String(count - 1)])
    assert.deepEqual(failures[0].difference.actual?.match(/\d+/gu), ["0"])
    for (const retry of fixture.seen.slice(1)) {
      assert.ok(!retry.body.messages.some((message) => message.role === "assistant"), "An ambiguous output was guessed into a smaller request.")
      const feedback = modelFeedback(retry.body)
      const errors = feedback.split("\n").filter((line) => line.startsWith("Previous response errors:"))
      assert.equal(errors.length, retry.items.length)
      for (const error of errors) assert.doesNotMatch(error.replace(/Item \d+: /u, ""), /\d/u, "A previous batch count leaked into the model's error description.")
      const currentCount = feedback.match(/Current request: (\d+) item\(s\)/u)?.[1]
      assert.equal(currentCount, retry.items.length > 1 ? String(retry.items.length) : undefined)
      if (retry.items.length === 1) assert.doesNotMatch(feedback, /Item \d|separator|boundary line/u)
    }
  }
})

test("multiple invalid items retry together with the complete assistant response and numbered corrections for each current item", async (t) => {
  const output = "第一项丢失了代码。\n%%\n"
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? output : items.map((item) => item.replace("Keep", "保留").replace("Read", "阅读")).join("\n%%\n")))
  const input = inputOf(parseMarkdown("Keep `firstId_abcdefghijklmnopqrstuvwxyz_123456789` unchanged.\n\nRead the original document."))
  const result = await requestTranslation(fixture.service, { ...fixture.settings, batchShrinkFactor: 1 }, input, new AbortController().signal, fixture.gate)
  assert.equal(result.length, 2)
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [2, 2]
  )
  const retry = fixture.seen[1].body
  assert.deepEqual(retry.messages.slice(0, fixture.seen[0].body.messages.length), fixture.seen[0].body.messages)
  assert.deepEqual(retry.messages.at(-2), { role: "assistant", content: output })
  const correction = modelFeedback(retry)
  assert.match(correction, /2 item\(s\); separator: %% on its own line/)
  assert.match(correction, /Item 1:.*exactly once/)
  assert.match(correction, /Item 2: [^\n]+\n[^\n]*non-empty/)
  assert.ok(result[0].text.includes("`firstId_abcdefghijklmnopqrstuvwxyz_123456789`"))
})

test("shrinking an aligned failed batch selects the prior outputs matching each current source and renumbers corrections", async (t) => {
  const oldOutput = (item: string) => item.replace("Original", "旧译文") + "\n\nExtra paragraph."
  const fixture = await chatFixture(t, (_body, items, call) =>
    call === 1 ? items.map(oldOutput).join("\n%%\n") : items.map((item) => item.replace("Original", "正确译文")).join("\n%%\n")
  )
  const result = await requestTranslation(fixture.service, fixture.settings, listBatch(4), new AbortController().signal, fixture.gate)
  assert.equal(result.length, 4)
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [4, 2, 2]
  )
  for (const retry of fixture.seen.slice(1)) {
    assert.deepEqual(
      retry.body.messages.filter((message) => message.role === "assistant"),
      [{ role: "assistant", content: retry.items.map(oldOutput).join("\n\n%%\n\n") }]
    )
    const correction = modelFeedback(retry.body)
    assert.ok(correction.includes("Item 1:") && correction.includes("Item 2:") && !correction.includes("Item 3:"))
  }
})

test("transport retry preserves the previous assistant output and correction without inventing new history", async (t) => {
  const output = "Incorrect output.\n\nExtra paragraph."
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? output : call === 2 ? { disconnect: true } : "正确译文。"))
  const input = inputOf(parseMarkdown("Read the original document."))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, "正确译文。")
  assert.deepEqual(fixture.seen[2].body, fixture.seen[1].body)
  assert.deepEqual(
    fixture.seen[2].body.messages.filter((message) => message.role === "assistant"),
    [{ role: "assistant", content: output }]
  )
})

test("a complete prior output participates in the final budget and oversized history never reaches HTTP", async (t) => {
  const fixture = await chatFixture(t, () => "Long invalid answer. ".repeat(100) + "\n\nExtra paragraph.")
  const input = inputOf(parseMarkdown("Read the original document."))
  const events: TranslationEvent[] = []
  await assert.rejects(
    requestTranslation(fixture.service, { ...fixture.settings, maxRequestCharacters: 1000 }, input, new AbortController().signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => events.push(event)
    }),
    /service-request-too-large/
  )
  assert.equal(fixture.seen.length, 1, "Oversized history was sent or silently truncated.")
  const finish = events.find((event) => event.kind === "finish")!
  assert.ok(finish.kind === "finish" && finish.failures[0].attempts === 1)
})

test("prior response and corrective instructions redact credentials and do not interpret template data", async (t) => {
  const secret = "history-fixture-credential"
  const output = "Invalid " + secret + " ${targetLang} {{#if context}}.\n\nExtra paragraph."
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? output : "正确译文。"))
  const input = inputOf(parseMarkdown("Read the original document."))
  const settings = { ...fixture.settings, apiKey: secret }
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  const retry = fixture.seen[1].body
  assert.deepEqual(retry.messages.at(-2), { role: "assistant", content: output.replace(secret, "[REDACTED]") })
  assert.ok(!JSON.stringify(retry.messages).includes(secret))
  const before = fixture.seen.length
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.ok(!fixture.seen[before].body.messages.some((message) => message.role === "assistant"), "A new task inherited an old task's history.")
})

test("history exceeding a multi-item budget is split by aligned items without truncating the prior answers", async (t) => {
  const previous = (item: string) => item.replace("Original", "旧译文") + "x".repeat(220) + "\n\nExtra paragraph."
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? items.map(previous).join("\n%%\n") : items.map((item) => item.replace("Original", "正确译文")).join("\n%%\n")))
  const settings = { ...fixture.settings, batchShrinkFactor: 1, maxRequestCharacters: 1800 }
  const result = await requestTranslation(fixture.service, settings, listBatch(4), new AbortController().signal, fixture.gate)
  assert.equal(result.length, 4)
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [4, 2, 2]
  )
  for (const retry of fixture.seen.slice(1)) {
    assert.equal(retry.body.messages.at(-2)!.content, retry.items.map(previous).join("\n\n%%\n\n"))
    assert.ok(retry.body.messages.reduce((sum, message) => sum + message.content.length, 0) <= settings.maxRequestCharacters)
  }
})

test("regrouped prior outputs cannot collide with the current batch separator", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const previousOutput = ["First old answer.\n%%\nLiteral separator.", "Second old answer."]
  const compiled = modelRequest({
    settings: fixture.settings,
    context: "",
    items: [
      { id: "one", text: "First source.", format: "text" },
      { id: "two", text: "Second source.", format: "text" }
    ],
    retryFeedback: [{ index: 0, reason: "The response changed document structure.", instruction: "Preserve document structure." }],
    previousOutput
  })
  const assistant = compiled.payload.messages.find((message) => message.role === "assistant")!
  assert.deepEqual(splitTranslations(assistant.content, compiled.separator, 2), previousOutput)
})
