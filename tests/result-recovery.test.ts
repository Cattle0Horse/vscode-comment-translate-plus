import { validatedText } from "./support/assertions.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelRetry } from "../src/model/diagnostics.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, modelContext, requestTranslation } from "./support/fixtures.ts"

test("Python interpolation recovery never completes a changed expression or chooses an ambiguous prefix", () => {
  for (const source of ["Read {probe.label} now.", "Read {len(rows)} now.", "Read {probe.label} and {probe.labels} now."]) {
    const unit = { id: "interpolation", text: source, start: 0, end: source.length, format: "text" as const, kind: "string" as const, language: "python" }
    const prepared = prepareTranslation(unit, 32)
    for (const broken of ["读取 {probe.label>。", "读取 {probe.label >。", "读取 {probe.label extra}。", "读取 {probe.label_extra}。", "读取 {probe.la}。", "读取 {len(rows_extra}。"])
      assert.throws(() => prepared.restore(broken), ModelRetry, broken)
  }
  const source = "Read {len(rows)} now."
  const prepared = prepareTranslation({ id: "closing", text: source, start: 0, end: source.length, format: "text", kind: "string", language: "python" }, 32)
  assert.equal(prepared.restore("读取 {len(rows}。"), "读取 {len(rows)}。")
  assert.equal(prepared.restore("读取 {len(rows)。"), "读取 {len(rows)}。")
  const ambiguous = "Read {len(rows)} and {len(rows))} now."
  const ambiguousPrepared = prepareTranslation({ id: "ambiguous", start: 0, format: "text", kind: "string", language: "python", text: ambiguous, end: ambiguous.length }, 32)
  assert.throws(() => ambiguousPrepared.restore("读取 {len(rows} 和 {len(rows))}。"), ModelRetry)
})

test("unsolicited context envelopes retry without stripping evidence and only validated translations are published and cached", async (t) => {
  const translations = ["阅读目录。", "打开画廊。"]
  const source = ["Read the catalog.", "Open the gallery."]
  const reference = [{ kind: "Neighbour", text: "The fictional garden opens at dawn." }]
  const input = { units: source.map((text, index) => ({ id: "t" + index, text, start: index * 100, end: index * 100 + text.length, format: "markdown" as const, reference })) }
  const body = translations.join("\n%%\n")
  for (const output of [
    body + "</context>",
    body + "\n</context>\n",
    "<context>虚构花园在黎明开放。\n%%\n附加参考。</context>\n" + body,
    body + "\n<context>虚构花园在黎明开放。</context>"
  ]) {
    const fixture = await chatFixture(t, (request, items, call) => {
      assert.ok(modelContext(request))
      return call === 1 ? output : items.map((item) => translations[source.indexOf(item)]).join("\n%%\n")
    })
    const store = new TranslationStore()
    t.after(() => store.clear())
    const published: string[] = []
    const events: TranslationEvent[] = []
    const run = () =>
      store.translate(
        "context-recovery",
        input,
        (batch, signal, complete) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, complete, { details: true, emit: (event) => events.push(event) }),
        new AbortController().signal,
        false,
        (item) => published.push(validatedText(item.text))
      )
    assert.deepEqual([...(await run()).values()], translations)
    assert.deepEqual(published, translations)
    const requestsBeforeCache = fixture.seen.length
    assert.deepEqual([...(await run()).values()], translations)
    assert.equal(fixture.seen.length, requestsBeforeCache)
    const request = events.find((event) => event.kind === "request")!
    assert.equal(JSON.parse(request.modelResponse!).choices[0].message.content, output)
    assert.deepEqual(
      fixture.seen
        .slice(1)
        .flatMap((retry) => retry.items)
        .sort(),
      request.failures.map((failure) => source[Number(failure.id.slice(1))]).sort()
    )
  }
})

test("context validation preserves source tags and rejects unsolicited envelopes and damaged translations", async (t) => {
  const fixed = "阅读目录。"
  const scenarios = [
    { source: "Read the catalog.", output: "阅读<context>附加参考。</context>目录。" },
    { source: "Read the catalog.", output: fixed + "</context></context>" },
    { source: "Read the catalog.", output: fixed + "<context><context>附加参考。</context></context>" },
    { source: "Read the catalog.", output: fixed + "<context><CONTEXT>附加参考。</CONTEXT></context>" },
    { source: "Read the catalog.", output: fixed + "</context>附加说明。" },
    { source: "Read the catalog.", output: "<context>只有参考。</context>" },
    { source: "Read the catalog.", output: "参考内容：\n<context>附加参考。</context>" },
    { source: "Read the catalog.", output: fixed + "</context>", includeContext: false },
    { source: "Read the catalog.", output: fixed + "</context>", userPrompt: "Translate the following text into ${targetLang}:\n\n${text}" },
    { source: "Read [catalog](https://example.com/catalog).", output: "阅读[目录](https://example.com/wrong)。</context>", fixed: "阅读[目录](https://example.com/catalog)。" },
    { source: "Read the catalog.", output: "阅读目录。\n额外说明。</context>" }
  ]
  for (const scenario of scenarios) {
    const fixture = await chatFixture(t, (_request, _items, call) => (call === 1 ? scenario.output : (scenario.fixed ?? fixed)))
    const input = {
      units: [
        { id: "t0", text: scenario.source, start: 0, end: scenario.source.length, format: "markdown" as const, reference: [{ kind: "Neighbour", text: "A fictional garden reference." }] }
      ]
    }
    const settings = { ...fixture.settings, includeContext: scenario.includeContext ?? true, userPrompt: scenario.userPrompt ?? fixture.settings.userPrompt }
    const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
    assert.equal(result[0].text, scenario.fixed ?? fixed)
    assert.equal(fixture.seen.length, 2, scenario.output)
  }
  for (const text of ["Read <context>the catalog</context>.", "Read the catalog </context>", "Read `<context>` and `</context>`."]) {
    const output = text.replace("Read", "阅读")
    const fixture = await chatFixture(t, () => output)
    const input = { units: [{ id: "t0", text, start: 0, end: text.length, format: "markdown" as const, reference: [{ kind: "Neighbour", text: "A fictional garden reference." }] }] }
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.equal(result[0].text, output.trimEnd())
    assert.equal(fixture.seen.length, 1)
  }
  const text = "Read `the literal <context> tag printed on a fictional catalog label` now."
  const fixture = await chatFixture(t, (_request, items, call) => items[0].replace("Read ", "阅读 ").replace(" now.", "。") + (call === 1 ? "</context>" : ""))
  const input = { units: [{ id: "t0", text, start: 0, end: text.length, format: "markdown" as const, reference: [{ kind: "Neighbour", text: "A fictional garden reference." }] }] }
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, text.replace("Read ", "阅读 ").replace(" now.", "。"))
  assert.equal(fixture.seen.length, 2, "Masked source tags must not be mistaken for response controls.")
})
