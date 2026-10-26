import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { parseMarkdown, parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { translatedMarkdown, translationDisplayText, displayTranslations } from "../src/documents/presentation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationService } from "../src/translation/engine.ts"
import { defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames, renderPrompt, modelRequest, splitTranslations } from "../src/translation/providers/prompts.ts"
import { getProvider } from "../src/translation/providers/index.ts"
import { TranslationLog } from "../src/host/logging.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { sourceReferences } from "../src/documents/references.ts"
import {
  modelFeedback,
  referenceText,
  limits,
  requestTranslation,
  inputOf,
  modelContext,
  unitReferences,
  batch,
  modelInput,
  dropLastProtection,
  chatFixture,
  listBatch,
  logContext
} from "./support/fixtures.ts"

test("quoted headings remain local and identical headings or list parents do not combine unrelated HTTP contexts", async (t) => {
  const quote = inputOf(parseMarkdown("# Manual\n\n> ## Electrical switch\n>\n> Close it.\n\nOutside target."))
  const inside = quote.units.find((unit) => unit.text.includes("Close it."))!
  const outside = quote.units.at(-1)!
  assert.ok(referenceText([{ ...inside, reference: unitReferences(inside, 2000) }]).includes("> ## Electrical switch"))
  assert.equal(referenceText([{ ...outside, reference: unitReferences(outside, 2000) }]), "# Manual", "A heading escaped its quote container.")
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  for (const source of ["## State\n\nFirst target.\n\n## State\n\nSecond target.", "- First parent.\n  - First target.\n- Second parent.\n  - Second target."]) {
    const input = { units: inputOf(parseMarkdown(source)).units.filter((unit) => unit.text.includes("target.")) }
    const before = fixture.seen.length
    await requestTranslation(fixture.service, { ...fixture.settings, batchBySemanticScope: true }, input, new AbortController().signal, fixture.gate)
    assert.deepEqual(
      fixture.seen.slice(before).map(({ items }) => items.length),
      [1, 1]
    )
    await requestTranslation(fixture.service, { ...fixture.settings, batchBySemanticScope: false }, input, new AbortController().signal, fixture.gate)
    assert.equal(fixture.seen.at(-1)!.items.length, 2, "Explicitly disabling semantic batching was ignored.")
  }
})

test("local reference plans are independent of batch neighbors and their absolute source positions", async (t) => {
  const store = new TranslationStore()
  const source = "## Charge\n\nApply an electrical charge to the capacitor.\n\nKeep it."
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const input = inputOf(parseMarkdown(source))
  const prepared = prepareInput(fixture.settings, input)
  const target = input.units.at(-1)!
  const alone = prepareInput(fixture.settings, { units: [target] })
  assert.equal(referenceText(alone.units), referenceText([prepared.units.at(-1)!]))
  let calls = 0
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) => {
    calls++
    return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  }
  await store.translate("reference-plan", alone, action, new AbortController().signal)
  const moved = prepareInput(fixture.settings, { units: [inputOf(parseMarkdown("\n\n" + source)).units.at(-1)!] })
  await store.translate("reference-plan", moved, action, new AbortController().signal)
  assert.equal(calls, 1, "Moving the same source invalidated the unchanged local reference plan.")
  const changed = prepareInput(fixture.settings, { units: [inputOf(parseMarkdown(source.replace("electrical", "magnetic"))).units.at(-1)!] })
  await store.translate("reference-plan", changed, action, new AbortController().signal)
  assert.equal(calls, 2, "Changing the explanatory paragraph reused a translation with different meaning.")
})

test("global request gate constrains starts across callers with a sliding window", async () => {
  const gate = new RequestGate(2, 2)
  const started: number[] = []
  let active = 0
  let peak = 0
  const signals = [new AbortController(), new AbortController()]
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      gate.run(
        async () => {
          started.push(performance.now())
          active++
          peak = Math.max(peak, active)
          await delay(20)
          active--
        },
        signals[index % 2].signal
      )
    )
  )
  assert.ok(peak <= 2)
  for (let index = 2; index < started.length; index++) assert.ok(started[index] - started[index - 2] >= 1000)
})

test("queued cancellation consumes no request and changing rate retains already used window slots", async () => {
  const gate = new RequestGate(1, 1)
  const signal = new AbortController()
  const starts: number[] = []
  await gate.run(async () => {
    starts.push(performance.now())
  }, signal.signal)
  const waiting = new AbortController()
  const cancelled = gate.run(async () => {
    throw Error("must not start")
  }, waiting.signal)
  waiting.abort()
  await assert.rejects(cancelled)
  gate.configure(1, 2)
  await gate.run(async () => {
    starts.push(performance.now())
  }, signal.signal)
  assert.ok(starts[1] - starts[0] >= 1000)
})

test("plain-text HTTP adapter sends context without JSON output constraints and bounds invalid response retries", async (t) => {
  let mode = "echo"
  let calls = 0
  const seen: { messages: { role: string; content: string }[] }[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, undefined, "Empty API keys must omit Authorization.")
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    seen.push(body)
    calls++
    assert.equal(body.model, "local-test")
    assert.equal(body.response_format, undefined)
    assert.ok(modelContext(body).includes("`code`") && /(?:First|Second) item with/.test(modelInput(body)), "Protected source context or the actual translation input was omitted.")
    if (mode === "json") {
      response.end("{")
      return
    }
    response.end(JSON.stringify({ choices: [{ finish_reason: mode === "truncated" ? "length" : "stop", message: { content: mode === "invalid" ? 42 : modelInput(body) } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const settings = {
    ...limits,
    provider: "openai",
    systemPrompt: defaultSystemPrompt,
    userPrompt: defaultUserPrompt,
    languageNames: defaultLanguageNames,
    apiKey: "",
    preserveTerms: emptyPreserveTerms,
    skipSameLanguage: false,
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    model: "local-test",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN"
  }
  const service = new TranslationService()
  const text = await requestTranslation(service, settings, batch, new AbortController().signal, new RequestGate(100, 2))
  assert.equal(validateTranslations(batch, text).size, 2)
  for (mode of ["truncated", "invalid", "json"]) {
    const before = calls
    await assert.rejects(requestTranslation(service, settings, batch, new AbortController().signal, new RequestGate(100, 2)), mode === "json" ? /service-response-invalid/ : /incomplete/)
    assert.ok(calls - before <= batch.units.length * 3, "A unit exceeded the retry budget.")
    const retried = seen.slice(before)
    if (mode === "truncated") {
      for (const request of retried.filter((request) => request.messages.filter((message) => message.role === "user").length > 1)) {
        const hint = modelFeedback(request)
        assert.ok(
          hint.includes("complete translation") && !/continue|previous (?:output|translation)|service-response-incomplete/.test(hint),
          "Truncated-generation recovery relied on missing history or sent an internal error code."
        )
        if (!hint.includes("Current request:")) assert.ok(!/Item \d|separator/.test(hint), "A single-item truncation recovery retained batch instructions.")
      }
    } else
      assert.ok(
        retried.every((request) => request.messages.filter((message) => message.role === "user").length === 1),
        "An outer response failure added a model correction."
      )
  }
})

test("default request scopes keep paragraph, table and fenced-string references independent for tables-links", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n\n%%\n\n"))
  const source = await readFile("fixtures/development/tables-links.md", "utf8")
  const parsed = await parseMarkdownWithCode(source, async (text, language) => {
    const literal = "'Do not translate this fenced example.'"
    const start = text.indexOf(literal)
    const end = start + literal.length
    const unit = {
      id: "logged-string",
      start,
      end,
      text: literal,
      format: "text" as const,
      kind: "string" as const,
      protected: [
        { start: 0, end: 1 },
        { start: literal.length - 1, end: literal.length }
      ]
    }
    return { source: text, errors: [], groups: [{ start, end, units: [{ ...unit, reference: sourceReferences(text, unit, language) }] }] }
  })
  const manifest = JSON.parse(await readFile("package.json", "utf8"))
  const settings = {
    ...fixture.settings,
    batchBySemanticScope: manifest.contributes.configuration.properties["commentTranslatePlus.batchBySemanticScope"].default,
    maxConcurrentRequests: 1
  }
  const input = inputOf(parsed)
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    [...validateTranslations(input, result).values()],
    input.units.map((unit) => unit.text)
  )
  const paragraph = fixture.seen.find(({ items }) => items.some((item) => item.includes("ead ")))!
  const paragraphContext = modelContext(paragraph.body)
  assert.ok(
    paragraph.items.length === 2 &&
      paragraph.items[0] === "Links and tables" &&
      paragraph.items[1].includes("`sourceId`") &&
      paragraphContext === "" &&
      !paragraphContext.includes("| Field |"),
    "Paragraph context includes a different semantic scope or hides its original protected content: " + JSON.stringify(paragraph)
  )
  const code = fixture.seen.find(({ items }) => items.includes("Do not translate this fenced example."))!
  assert.ok(
    code.items.length === 1 && modelContext(code.body).includes("# Links and tables") && !modelContext(code.body).includes("| Field |"),
    "A single fenced string lost its parent title or inherited unrelated table context."
  )
  for (const request of fixture.seen.filter(({ items }) => items.includes("Source") || items.includes("Target"))) {
    const context = modelContext(request.body)
    assert.ok(
      context.includes("| Field | Description |") && context.includes("sourceId") && !context.includes("const untouched"),
      "A table lost its section introduction or inherited unrelated fenced code."
    )
  }
})

test("redundant outer separators are tolerated without guessing ambiguous or explicitly empty items", () => {
  assert.deepEqual(splitTranslations("%%\n译文 A\n%%\n译文 B\n%%\n", "%%", 2), ["译文 A", "译文 B"])
  assert.deepEqual(splitTranslations("\n%%\n译文\n%%\n", "%%", 1), ["译文"])
  assert.deepEqual(splitTranslations("%%\n译文 B", "%%", 2), ["", "译文 B"])
  assert.deepEqual(splitTranslations("译文 A\n%%\n", "%%", 2), ["译文 A", ""])
  assert.throws(() => splitTranslations("%%\n只有一项\n%%", "%%", 2), /items-mismatch/)
  assert.throws(() => splitTranslations("A\n%%\nB\n%%\nC", "%%", 2), /items-mismatch/)
})

test("actual HTTP references merge table rows and YAML fields and retries retain only the failed row", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => items.map((item) => (call === 1 && item.includes("Keep") ? item + "\n\nExtra paragraph." : item)).join("\n%%\n"))
  const settings = { ...fixture.settings, initialItemsPerRequest: 20, adaptiveBatching: false }
  const table = "| Signal | Action |\n| --- | --- |\n| Event | Keep `sourceId`. |\n| Market | Read the catalog. |"
  const input = inputOf(parseMarkdown(table))
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, result).size, input.units.length)
  const contexts = fixture.seen.map(({ body }) => modelContext(body))
  assert.deepEqual(contexts, [table, "| Signal | Action |\n| --- | --- |\n| Event | Keep `sourceId`. |"])
  assert.equal(fixture.seen[1].items.length, 1, "The retry translated already validated table neighbours again.")
  const yaml = inputOf(parseMarkdown("---\nmetadata:\n  availability: active\n  default_enabled: true\n  read_only: false\n---"))
  const selected = { units: yaml.units.filter((unit) => ["availability", "active", "default_enabled", "read_only"].includes(unit.content!)) }
  await requestTranslation(fixture.service, settings, selected, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen[2].items.length, 4)
  assert.equal(modelContext(fixture.seen[2].body), "metadata:\n  availability: active\n  default_enabled: true\n  read_only: false")
})

test("actual HTTP budgets use merged code windows and retry only the failed unit's window", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => items.map((item) => (call === 1 && item.includes("Keep") ? item + "\n\nExtra paragraph." : item)).join("\n%%\n"))
  const source = await readFile("fixtures/development/comments.rs", "utf8")
  const units = ["Read the original document.", "/* Keep `sourceId` unchanged. */", '"Read the original document."'].map((text, index) => {
    const start = source.indexOf(text)
    const unit = { id: "t" + index, text, start, end: start + text.length, format: "text" as const, kind: "comment" as const }
    return { ...unit, reference: sourceReferences(source, unit, "rust") }
  })
  const events: TranslationEvent[] = []
  const result = await requestTranslation(
    fixture.service,
    {
      ...fixture.settings,
      sourceLanguage: "auto",
      // Pin prompts so this regression measures merged references independently of default wording.
      systemPrompt: "Keep every <CTP...> marker unchanged. Separate translations with ${separator} on its own line.",
      userPrompt: "<context>\n${context}\n</context>\n\nTranslate the following text into ${targetLang}:\n\n${content}",
      maxContextCharacters: 160,
      maxRequestCharacters: 850
    },
    { units },
    new AbortController().signal,
    fixture.gate,
    undefined,
    { details: true, emit: (event) => events.push(event) }
  )
  assert.equal(validateTranslations({ units }, result).size, 3)
  assert.deepEqual(
    fixture.seen.map(({ items }) => items.length),
    [3, 1],
    "Duplicate windows split a valid batch or retries resubmitted accepted units."
  )
  const contexts = fixture.seen.map(({ body }) => modelContext(body))
  assert.deepEqual(contexts, [source.trimEnd(), referenceText([units[1]])])
  const requests = events.filter((event) => event.kind === "request")
  assert.equal(requests[0].contextCharacters, 154)
  for (const [index, event] of requests.entries()) {
    assert.equal(
      event.inputCharacters,
      fixture.seen[index].body.messages.reduce((size, message) => size + message.content.length, 0)
    )
    assert.ok(event.contextCharacters <= 160 && event.inputCharacters <= 850)
  }
})

test("actual request budgets include complete system/user templates and split before the hard limit", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const input = inputOf(parseMarkdown("Original A.\n\nOriginal B."))
  const settings = { ...fixture.settings, systemPrompt: "S".repeat(240), userPrompt: "${content}", maxRequestCharacters: 256 }
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, result).size, 2)
  assert.equal(fixture.seen.length, 2)
  assert.ok(fixture.seen.every(({ body, items }) => items.length === 1 && body.messages.reduce((sum, message) => sum + message.content.length, 0) <= 256))
  const before = fixture.seen.length
  await assert.rejects(requestTranslation(fixture.service, { ...settings, systemPrompt: "S".repeat(300) }, input, new AbortController().signal, fixture.gate), /service-request-too-large/)
  assert.equal(fixture.seen.length, before, "An oversized template was sent despite the final-message hard limit.")
})

test("request references are complete bounded blocks, zero disables them, and meaningful titles remain distinct from source", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const unit = inputOf(parseMarkdown("# Project Guide\n\nOriginal paragraph.")).units[1]
  const input = { units: [{ ...unit, reference: [...(unit.reference ?? []), { kind: "Oversized", text: "X".repeat(2000) }] }] }
  const events: TranslationEvent[] = []
  await requestTranslation(fixture.service, { ...fixture.settings, maxContextCharacters: 80 }, input, new AbortController().signal, fixture.gate, undefined, {
    details: true,
    emit: (event) => events.push(event)
  })
  const text = fixture.seen[0].body.messages.map((message) => message.content).join("\n")
  assert.ok(text.includes("Project Guide") && !text.includes("X".repeat(100)))
  const request = events.find((event) => event.kind === "request")!
  assert.ok(request.kind === "request" && request.contextCharacters > 0 && request.contextCharacters <= 80)
  assert.equal(
    request.inputCharacters,
    fixture.seen[0].body.messages.reduce((sum, message) => sum + message.content.length, 0)
  )
  await requestTranslation(fixture.service, { ...fixture.settings, maxContextCharacters: 0 }, input, new AbortController().signal, fixture.gate)
  assert.ok(!fixture.seen[1].body.messages.some((message) => message.content.includes("Project Guide") || message.content.includes("Reference only")))
})

test("reference accounting follows actual template expansion, including repeated variables and templates that omit references", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const unit = {
    ...inputOf(parseMarkdown("Original ${context} paragraph.")).units[0],
    reference: [
      { kind: "Long", text: "L".repeat(100) },
      { kind: "Title", text: "Small" }
    ]
  }
  const settings = {
    ...fixture.settings,
    maxContextCharacters: 120,
    systemPrompt: "Rules: ${context}",
    userPrompt: "Target language: ${targetLang}.\n\n${context}\n\nSource items:\n${content}"
  }
  const events: TranslationEvent[] = []
  const translate = (systemPrompt = settings.systemPrompt, userPrompt = settings.userPrompt) =>
    requestTranslation(fixture.service, { ...settings, systemPrompt, userPrompt }, { units: [unit] }, new AbortController().signal, fixture.gate, undefined, {
      details: true,
      emit: (event) => events.push(event)
    })
  await translate()
  const first = events.find((event) => event.kind === "request")!
  assert.ok(first.kind === "request" && first.contextCharacters > 0 && first.contextCharacters <= 120)
  const context = "Small"
  assert.equal(first.contextCharacters, context.length * 2)
  assert.ok(
    fixture.seen[0].body.messages.every((message) => !message.content.includes("L".repeat(100))),
    "A large block was partly sent or incorrectly counted once."
  )
  assert.equal(
    (
      fixture.seen[0].body.messages
        .map((message) => message.content)
        .join("\n")
        .match(/Small/g) ?? []
    ).length,
    2
  )
  events.length = 0
  const restored = await translate("Rules only.", "Target language: ${targetLang}.\n\nSource items:\n${content}")
  assert.deepEqual(
    prepareInput({ ...settings, systemPrompt: "Rules only.", userPrompt: "${content}" }, { units: [unit] }).units[0].reference,
    [],
    "Unsent references remained in cache identity."
  )
  const second = events.find((event) => event.kind === "request")!
  assert.ok(second.kind === "request" && second.contextCharacters === 0 && second.referenceKinds.length === 0)
  assert.equal(modelInput(fixture.seen[1].body), "Original ${context} paragraph.")
  assert.equal(validateTranslations({ units: [unit] }, restored).get(unit.id), unit.text, "A protected source placeholder was interpreted as another template variable.")
  assert.equal(renderPrompt("${content}", { settings, context: "Other reference", items: [{ id: unit.id, text: unit.text, format: "text" }] }, "%%"), unit.text)
})

test("retry references contain only the failed unit while validated neighboring output is retained", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) =>
    call === 1 ? items[0].replace("Original", "译文") + "\n%%\n" : items.map((item) => item.replace("Original", "译文")).join("\n%%\n")
  )
  const input = {
    units: inputOf(parseMarkdown("Original A.\n\nOriginal B.")).units.map((unit, index) => ({ ...unit, reference: [{ kind: "Project", text: index ? "Project Beta" : "Project Alpha" }] }))
  }
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, result).size, 2)
  assert.equal(fixture.seen.length, 2)
  const retry = fixture.seen[1].body.messages.map((message) => message.content).join("\n")
  assert.ok(retry.includes("Project Beta") && !retry.includes("Project Alpha") && !retry.includes("Original A."))
  assert.equal(fixture.seen[1].items.length, 1)
})

test("a recovered request preserves concrete expected/actual diagnostics even with details disabled", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "" : items[0].replace("Original", "译文")))
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  await requestTranslation(fixture.service, fixture.settings, listBatch(1), new AbortController().signal, fixture.gate, undefined, {
    details: false,
    emit: (event) => log.record(event, logContext)
  })
  const warning = entries.find((entry) => entry.includes("[WARNING]"))!
  assert.ok(warning.includes("sample.md:1:") && warning.includes("期望：非空译文") && warning.includes("返回：空文本"))
  assert.ok(entries.some((entry) => entry.includes("任务完成") && entry.includes("有变化 1 项")))
  assert.ok(!entries.some((entry) => entry.includes("[ERROR]") || entry.includes("--- system")))
})

test("missing delimiters reject ambiguous results, shrink the batch and learn sizes from actual outcomes", async (t) => {
  const published: string[] = []
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 1) return items.filter((_, index) => index !== 1).join("\n\n%%\n\n")
    if (call === 2) assert.deepEqual(published, [], "An ambiguous response leaked into accepted results.")
    return items.join("\n\n%%\n\n")
  })
  const input = listBatch(4)
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.id))
  assert.deepEqual(
    [...validateTranslations(input, result).values()],
    input.units.map((unit) => unit.text)
  )
  assert.equal(fixture.seen[0].items.length, 4)
  assert.ok(fixture.seen.slice(1).every((call) => call.items.length <= 2))
  assert.equal(new Set(published).size, 4)
  for (const retry of fixture.seen.slice(1)) {
    const feedback = modelFeedback(retry.body)
    assert.ok(feedback.includes("one translation per source item") && !feedback.includes("translation-items-mismatch"))
    assert.ok(!feedback.includes("4 项（3 个分隔符）") && feedback.includes("separator"), "The model received stale batch counts instead of current alignment guidance.")
    assert.ok(feedback.includes("Item 1:") && feedback.includes("Item 2:") && !feedback.includes("Item 3:"), "Feedback retained the old batch numbering.")
    assert.ok(retry.body.messages[0].content.includes("2 items"), "The retry retained the old batch's output requirements.")
  }
  const second = fixture.seen.length
  await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.ok(fixture.seen[second].items.length <= 2)
  for (let pass = 0; pass < 6; pass++) await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.ok(
    fixture.seen.slice(second).some((call) => call.items.length > 2),
    "Successful requests never recovered batch capacity."
  )
  const other = fixture.seen.length
  await requestTranslation(fixture.service, { ...fixture.settings, model: "different-model" }, input, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen[other].items.length, 4, "A model inherited another model's learned limits.")
})

test("retry guidance appends after intact source messages and allows source-owned diagnostic identifiers", async (t) => {
  for (const unit of [
    inputOf(parseMarkdown("Explain translation-item-invalid for the operator.")).units[0],
    inputOf(parseYaml('message: "Explain \\u0074ranslation-item-invalid for the operator."')).units[1]
  ]) {
    const fixture = await chatFixture(t, (body, _items, call) => (call === 1 ? "" : modelInput(body)))
    const input = { units: [unit] }
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.equal(validateTranslations(input, result).get(unit.id), unit.text)
    assert.deepEqual(fixture.seen[1].body.messages.slice(0, fixture.seen[0].body.messages.length), fixture.seen[0].body.messages, "Retry guidance changed the original template messages.")
    assert.equal(fixture.seen[1].body.messages.at(-1)!.role, "user")
    assert.ok(modelFeedback(fixture.seen[1].body).includes("non-empty translation"))
  }
})

test("request-layer feedback reaches custom and empty templates without modifying their original messages or interpreting diagnostic data", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "" : items[0]))
  const settings = { ...fixture.settings, systemPrompt: "", userPrompt: "${content}" }
  const input = inputOf(parseMarkdown("Original text."))
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(fixture.seen[0].body.messages, [{ role: "user", content: "Original text." }])
  const retry = fixture.seen[1].body.messages
  assert.equal(retry.length, 3)
  assert.deepEqual(retry[0], fixture.seen[0].body.messages[0])
  assert.deepEqual(retry[1], { role: "assistant", content: "" })
  assert.equal(retry[2].role, "user")
  assert.ok(retry[2].content.includes("non-empty translation") && !/Item \d|Current request:|translation-item-invalid/.test(retry[2].content))
  const feedback = 'reason: "${targetLang} {{#if context}} $&"'
  const request = {
    settings,
    context: "",
    retryFeedback: [{ index: 0, reason: "The response was invalid.", instruction: feedback }],
    items: [{ id: "one", text: "Original text.", format: "text" as const }]
  }
  const rendered = modelRequest({ ...request, settings: { ...settings, userPrompt: "" } })
  assert.equal(rendered.payload.messages.length, 2)
  assert.deepEqual(rendered.payload.messages[0], { role: "user", content: "" })
  assert.ok(
    rendered.payload.messages[1].content.includes(feedback) && rendered.payload.messages[1].content.endsWith("Simplified Chinese:\n\nOriginal text."),
    "Diagnostic data was reinterpreted as a template or source was omitted."
  )
  const provider = getProvider("openai")
  assert.equal(provider.prepare({ ...request, settings: { ...settings, userPrompt: "" } }).characters, rendered.payload.messages[1].content.length)
})

test("changing retry instructions retains the full original message prefix for default, custom and empty templates", () => {
  for (const templates of [
    { systemPrompt: defaultSystemPrompt, userPrompt: defaultUserPrompt },
    { systemPrompt: "System ${targetLang}.", userPrompt: "${context}\n${content}" },
    { systemPrompt: "", userPrompt: "" }
  ]) {
    const settings = {
      ...limits,
      ...templates,
      model: "fixture",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      languageNames: defaultLanguageNames,
      apiUrl: "http://fixture.invalid",
      apiKey: "",
      preserveTerms: emptyPreserveTerms
    }
    const request = { settings, context: "# Source reference", items: [{ id: "one", text: "Sources", format: "markdown" as const }] }
    const initial = modelRequest(request).payload.messages
    for (const retryFeedback of ["Provide a non-empty translation for this item.", "Keep the item's document structure."]) {
      const retry = modelRequest({ ...request, retryFeedback: [{ index: 0, reason: "The response was invalid.", instruction: retryFeedback }] }).payload.messages
      assert.deepEqual(retry.slice(0, -1), initial, "Changing corrections invalidated the original template prefix.")
      assert.equal(retry.at(-1)!.role, "user")
      const correction = retry.at(-1)!.content
      assert.ok(correction.includes(retryFeedback) && correction.endsWith("Simplified Chinese:\n\nSources"), "Retry omitted the current source or placed instructions after it.")
    }
  }
})

test("retry feedback triggers budget-based splitting and refuses an oversized complete single item before HTTP", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? items.map(() => "").join("\n%%\n") : items.join("\n%%\n")))
  const settings = {
    ...fixture.settings,
    systemPrompt: "",
    userPrompt: "${content}",
    maxRequestCharacters: 600,
    batchShrinkFactor: 1
  }
  const input = { units: Array.from({ length: 4 }, (_, index) => ({ id: String(index), start: index * 121, end: index * 121 + 120, text: "x".repeat(120), format: "text" as const })) }
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, result).size, 4)
  assert.deepEqual(
    fixture.seen.map(({ items }) => items.length),
    [4, 1, 1, 1, 1]
  )
  assert.ok(fixture.seen.every(({ body }) => body.messages.reduce((sum, message) => sum + message.content.length, 0) <= settings.maxRequestCharacters))
  assert.ok(
    fixture.seen.slice(1).every(({ items }) => items.every((item) => item.length === 120)),
    "A retry truncated source to fit its feedback."
  )

  const oversized = await chatFixture(t, () => "")
  const events: TranslationEvent[] = []
  await assert.rejects(
    requestTranslation(
      oversized.service,
      { ...settings, apiUrl: oversized.settings.apiUrl, maxRequestCharacters: 256 },
      { units: [{ id: "one", start: 0, end: 200, text: "x".repeat(200), format: "text" }] },
      new AbortController().signal,
      oversized.gate,
      undefined,
      { details: true, emit: (event) => events.push(event) }
    ),
    /service-request-too-large/
  )
  assert.equal(oversized.seen.length, 1, "An oversized retry reached the HTTP service.")
  const finish = events.find((event) => event.kind === "finish")!
  assert.ok(finish.kind === "finish" && finish.failures[0].attempts === 1, "A rejected local request consumed a model attempt.")
})

test("model retry guidance excludes human diagnostic snippets, credentials and source templates", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? dropLastProtection(items[0]) : items[0]))
  const secret = "fixture-private-credential"
  const input = inputOf(parseMarkdown("Keep `" + secret + " ${targetLang} " + "x".repeat(2000) + "` unchanged."))
  const events: TranslationEvent[] = []
  await requestTranslation(fixture.service, { ...fixture.settings, apiKey: secret }, input, new AbortController().signal, fixture.gate, undefined, {
    details: false,
    emit: (event) => events.push(event)
  })
  const retry = modelFeedback(fixture.seen[1].body)
  assert.ok(retry.includes("<CTP...>") && retry.includes("exactly once"))
  assert.ok(!retry.includes(secret) && !retry.includes("${targetLang}") && !retry.includes("x".repeat(257)) && !retry.includes("expected:"))
  const failed = events.find((event) => event.kind === "request" && event.failures.length)
  assert.ok(failed?.kind === "request" && failed.failures[0].difference.expected?.includes("x".repeat(257)), "Human diagnostics lost the original concrete difference.")
})

test("request policy controls fixed targets, semantic boundaries and hard caps without inheriting learned capacity", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n\n%%\n\n"))
  const input = listBatch(6)
  const send = async (changes: Partial<typeof fixture.settings>, batch = input) => {
    const start = fixture.seen.length
    await requestTranslation(fixture.service, { ...fixture.settings, maxConcurrentRequests: 1, ...changes }, batch, new AbortController().signal, fixture.gate)
    return fixture.seen.slice(start).map((request) => request.items.length)
  }
  assert.deepEqual(await send({ adaptiveBatching: false, initialItemsPerRequest: 2, batchGrowthSuccesses: 1 }), [2, 2, 2])
  assert.deepEqual(await send({ initialItemsPerRequest: 2, batchGrowthSuccesses: 1, batchGrowthItems: 2 }), [2, 4])
  assert.deepEqual(await send({ initialItemsPerRequest: 3 }), [3, 3], "A changed policy reused the preceding policy's learned capacity.")
  assert.deepEqual(await send({ initialItemsPerRequest: 10, maxItemsPerRequest: 2 }), [2, 2, 2])
  const scoped = { units: input.units.slice(0, 2).map((unit, index) => ({ ...unit, scope: String(index) })) }
  assert.deepEqual(await send({ batchBySemanticScope: true }, scoped), [1, 1])
  assert.deepEqual(await send({ batchBySemanticScope: false }, scoped), [2])
})

test("configured full-capacity success threshold and growth step affect subsequent HTTP batches", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n\n%%\n\n"))
  await requestTranslation(
    fixture.service,
    { ...fixture.settings, initialItemsPerRequest: 2, batchGrowthSuccesses: 2, batchGrowthItems: 2, maxConcurrentRequests: 1 },
    listBatch(10),
    new AbortController().signal,
    fixture.gate
  )
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [2, 2, 4, 2]
  )
})

test("configured shrink factor and attempt budget retain verified neighbours and bound failed-unit requests", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "" : items.join("\n\n%%\n\n")))
  await requestTranslation(
    fixture.service,
    { ...fixture.settings, initialItemsPerRequest: 8, batchShrinkFactor: 0.25, maxTranslationAttempts: 4, maxConcurrentRequests: 1 },
    listBatch(8),
    new AbortController().signal,
    fixture.gate
  )
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [8, 2, 2, 2, 2]
  )
  const broken = await chatFixture(t, (_body, items) => items.map((item) => (item.includes("Keep") ? item + "\n\nExtra paragraph." : item)).join("\n\n%%\n\n"))
  const input = inputOf(parseMarkdown("1. Keep `code` unchanged.\n2. Original neighbour."))
  for (const maximum of [1, 2, 4]) {
    const start = broken.seen.length
    const accepted: string[] = []
    const events: TranslationEvent[] = []
    await assert.rejects(
      requestTranslation(broken.service, { ...broken.settings, maxTranslationAttempts: maximum }, input, new AbortController().signal, broken.gate, (item) => accepted.push(item.id), {
        details: true,
        emit: (event) => events.push(event)
      })
    )
    const requests = broken.seen.slice(start)
    assert.equal(requests.filter((request) => request.items.some((item) => item.includes("Keep"))).length, maximum)
    assert.equal(requests.filter((request) => request.items.some((item) => item.includes("neighbour"))).length, 1)
    assert.deepEqual(accepted, [input.units[1].id])
    const outcome = events.find((event) => event.kind === "finish")!
    assert.equal(outcome.kind === "finish" && outcome.failures[0].attempts, maximum)
    assert.equal(requests.at(-1)!.items.length, maximum === 1 ? 2 : 1)
  }
})

test("unit reference budget can exceed the old fixed limit, disables at zero and retains whole blocks within request budgets", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n\n%%\n\n"))
  const reference = "Reference " + "x".repeat(1200)
  const unit = { id: "one", start: 0, end: 14, text: "Original text.", format: "text" as const, reference: [{ kind: "Source", text: reference }] }
  for (const [limit, requestLimit, included] of [
    [1500, 2000, true],
    [1000, 2000, false],
    [0, 2000, false],
    [1500, 1000, false]
  ] as const) {
    await requestTranslation(
      fixture.service,
      { ...fixture.settings, maxUnitContextCharacters: limit, maxContextCharacters: requestLimit },
      { units: [unit] },
      new AbortController().signal,
      fixture.gate
    )
    assert.equal(
      fixture.seen.at(-1)!.body.messages.some((message) => message.content.includes(reference)),
      included
    )
  }
  const prepared = prepareInput({ ...fixture.settings, maxUnitContextCharacters: 1500 }, { units: [{ ...unit, reference: [...unit.reference, { kind: "Extra", text: "y".repeat(400) }] }] })
  assert.equal(referenceText(prepared.units), reference, "An overflowing reference block was truncated or displaced a higher-priority complete block.")
})

test("identical actual system messages are defined once across retries and tasks while changed prompts remain visible", async (t) => {
  const fixture = await chatFixture(t, (body, _items, call) => (call < 3 ? "" : modelInput(body).replace("Original", "译文")))
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  const settings = { ...fixture.settings, systemPrompt: "Stable system.", userPrompt: "${content}" }
  const input = inputOf(parseMarkdown("Original log text."))
  const translate = (systemPrompt = settings.systemPrompt) =>
    requestTranslation(fixture.service, { ...settings, systemPrompt }, input, new AbortController().signal, fixture.gate, undefined, {
      details: true,
      emit: (event) => log.record(event, logContext)
    })
  await translate()
  await translate()
  const text = entries.join("\n")
  const references = [...text.matchAll(/system=(S\d+)/g)].map((match) => match[1])
  assert.equal(references.length, 4)
  assert.equal(new Set(references).size, 1)
  assert.equal((text.match(/--- system S\d+ ---/g) ?? []).length, 1)
  assert.equal(text.split("译文 log text.").length - 1, 2, "An identical model output was printed again beside its restored translation.")
  assert.ok(!text.includes('"choices"'), "Successful responses still dumped the HTTP JSON envelope.")
  await translate("Stable system.\n")
  await translate()
  assert.equal((entries.join("\n").match(/--- system S\d+ ---/g) ?? []).length, 2, "Rendered prompt changes were hidden or previous definitions stopped being reusable.")
})

test("system references are renewed after eviction or explicit reset and oversized prompts are not retained", () => {
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  const request: TranslationEvent = {
    sourceCharacters: 0,
    contextCharacters: 0,
    inputCharacters: 0,
    referenceKinds: [],
    batchReason: "fixture",
    kind: "request",
    taskId: "T1",
    requestId: "T1/R1",
    ids: ["one"],
    attempt: 1,
    elapsedMs: 1,
    httpRequests: 1,
    cancelled: false,
    detailsIncluded: true,
    completed: 1,
    failures: []
  }
  const record = (content: string) => log.record({ ...request, modelRequest: { model: "fixture", stream: false, messages: [{ role: "system", content }] } }, logContext)
  for (let index = 0; index < 100; index++) record("system-" + index)
  record("system-0")
  assert.ok(entries.at(-1)!.includes("--- system "), "An evicted prompt produced a reference without a fresh definition.")
  log.resetReferences()
  record("system-0")
  assert.ok(entries.at(-1)!.includes("--- system "), "Resetting log definitions left a dangling reference.")
  record("large ".repeat(50000))
  record("large ".repeat(50000))
  assert.ok(entries.at(-1)!.includes("--- system "), "An oversized prompt remained retained for reuse.")
})

test("translation diagnostics expose actual prompts and raw responses, completion counts, bounded retry context and final failures", async (t) => {
  let breakResponse = false
  const fixture = await chatFixture(t, (body, items) => (breakResponse ? items.slice(0, -1).join("\n\n%%\n\n") : modelInput(body).replace("Original", "译文")))
  const entries: string[] = []
  const events: TranslationEvent[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  const secret = "synthetic-log-credential"
  log.configure("info", true)
  const settings = { ...fixture.settings, apiKey: secret, userPrompt: "${content}" }
  const trace = (event: TranslationEvent) => {
    events.push(event)
    log.record(event, {
      file: "sample.md",
      name: "test",
      model: settings.model,
      targetLanguage: settings.targetLanguage,
      apiKey: settings.apiKey,
      position: (offset) => "sample.md:1:" + (offset + 1)
    })
  }
  const input = inputOf(parseMarkdown("Original " + secret + " text with `sourceId`."))
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, undefined, { details: true, emit: trace })
  const actualRequest = events.find((event) => event.kind === "request")!
  assert.equal(actualRequest.kind, "request")
  if (actualRequest.kind !== "request") throw Error("Missing request trace")
  assert.deepEqual(actualRequest.modelRequest?.messages, fixture.seen[0].body.messages)
  assert.ok(actualRequest.modelResponse?.includes("choices"))
  assert.equal(actualRequest.completed, input.units.length)
  assert.ok(actualRequest.httpRequests === 1 && actualRequest.elapsedMs >= 0)
  assert.equal(events.filter((event) => event.kind === "request").length, fixture.seen.length)
  assert.equal(events.filter((event) => event.kind === "finish").length, 1)
  assert.equal(new Set(events.map((event) => event.taskId)).size, 1)
  assert.ok(entries.every((entry) => !entry.includes(secret) && !entry.includes("Bearer")))
  events.length = 0
  entries.length = 0
  breakResponse = true
  log.configure("warning")
  await assert.rejects(requestTranslation(fixture.service, settings, listBatch(3), new AbortController().signal, fixture.gate, undefined, { details: true, emit: trace }))
  assert.ok(events.some((event) => event.kind === "request" && event.failures.length > 0 && event.nextBatchSize === 1))
  assert.ok(events.some((event) => event.kind === "finish" && event.status === "failed" && event.failures.length === 3))
  assert.ok(entries.some((entry) => entry.includes("WARNING")) && entries.some((entry) => entry.includes("ERROR")))
  assert.ok(entries.every((entry) => !entry.includes("[INFO]")))
  const beforeCancellation = fixture.seen.length
  const cancelled = new AbortController()
  const cancelledEvents: TranslationEvent[] = []
  await assert.rejects(
    requestTranslation(fixture.service, settings, input, cancelled.signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => {
        cancelledEvents.push(event)
        if (event.kind === "start") cancelled.abort()
      }
    })
  )
  assert.ok(cancelledEvents.some((event) => event.kind === "finish" && event.status === "cancelled" && event.failures.length === input.units.length))
  assert.equal(fixture.seen.length, beforeCancellation, "Preparation cancellation reached the HTTP service.")
})

test("YAML parent-key requests include their collection as reference without translating children or duplicating field punctuation", async (t) => {
  const fixture = await chatFixture(t, () => "元数据：")
  const metadata = "metadata:\n  availability: active\n  default_enabled: true\n  read_only: false\n  required: false"
  const source = "---\n" + metadata + "\n---"
  const parsed = parseMarkdown(source)
  const unit = inputOf(parsed).units.find((item) => item.content === "metadata")!
  const input = { units: [unit] }
  const result = validateTranslations(input, await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate))
  assert.equal(modelContext(fixture.seen[0].body), metadata)
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    ["metadata"]
  )
  const [view] = displayTranslations(source, [{ ...unit, translation: result.get(unit.id)! }])
  assert.equal(translationDisplayText(view.translation, "yaml"), "元数据: ")
  assert.equal(translatedMarkdown(parsed, result), source.replace("metadata", '"元数据"'))
  assert.equal(parsed.source, source)
})

test("YAML key colon recovery preserves value punctuation, original key punctuation and scalar whitespace", () => {
  const units = inputOf(parseMarkdown('---\nlabel: label\n"colon:": "colon:"\n"fullwidth：": "fullwidth："\n---')).units
  for (const [index, returned, expected] of [
    [0, "标签:", "标签"],
    [0, "标签：", "标签"],
    [0, "label:", "label"],
    [0, "标签： \n", "标签 \n"],
    [0, "标签::", "标签::"],
    [0, "说明：标签!", "说明：标签!"],
    [1, "标签：", "标签："],
    [2, "字段：", "字段："],
    [4, "字段:", "字段:"]
  ] as const) {
    const unit = units[index]
    const translated = prepareTranslation(unit, emptyPreserveTerms, 32).restore(returned)
    assert.equal(translationDisplayText(translated, "yaml"), expected)
  }
})

test("folded YAML block values omit the header in requests, partial field displays and value hovers", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body).replace("description", "描述").replace("this is value", "这是值"))
  const source = "---\ndescription: >-\n  this is value\n---"
  const parsed = parseMarkdown(source)
  const batch = inputOf(parsed)
  const result = validateTranslations(batch, await requestTranslation(fixture.service, fixture.settings, batch, new AbortController().signal, fixture.gate))
  const [key, value] = batch.units
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    ["description", "this is value"]
  )
  const partial = displayTranslations(source, [{ ...key, translation: result.get(key.id)! }])
  assert.equal(translationDisplayText(partial[0].translation, "yaml"), "描述: this is value")
  const complete = displayTranslations(
    source,
    batch.units.map((unit) => ({ ...unit, translation: result.get(unit.id)! }))
  )
  assert.equal(translationDisplayText(complete[0].translation, "yaml"), "描述: 这是值")
  assert.equal(translationDisplayText(result.get(value.id)!, "yaml"), "这是值")
  assert.equal(translatedMarkdown(parsed, result), '---\n"描述": "这是值"\n---')
  assert.equal(parsed.source, source)
})

test("a cancelled queued request is not counted as an HTTP start", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const gate = new RequestGate(100, 1)
  let release = () => {}
  const held = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
    new AbortController().signal
  )
  const controller = new AbortController()
  const events: TranslationEvent[] = []
  const input = listBatch(1)
  const pending = requestTranslation(fixture.service, fixture.settings, input, controller.signal, gate, undefined, { details: true, emit: (event) => events.push(event) })
  setTimeout(() => controller.abort("user-cancelled"), 0)
  await assert.rejects(pending)
  release()
  await held
  assert.equal(fixture.seen.length, 0)
  assert.ok(events.some((event) => event.kind === "request" && event.cancelled && event.httpRequests === 0))
  assert.ok(events.some((event) => event.kind === "finish" && event.status === "cancelled" && event.httpRequests === 0))
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  for (const event of events) log.record(event, logContext)
  const text = entries.join("\n")
  assert.ok(!text.includes("--- 原文与译文 ---"), "Cancelling a queued unit printed a source/translation section.")
  assert.ok(text.includes("用户取消") && text.includes("HTTP 尚未开始"), "Cancellation lost its origin or was mistaken for model inference.")
})
