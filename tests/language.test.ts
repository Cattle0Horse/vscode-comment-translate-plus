import { ModelRetry } from "../src/model/diagnostics.ts"
import { emptyPreserveTerms, parsePreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { TranslationFailure } from "../src/model/diagnostics.ts"
import { defaultSystemPrompt, renderPrompt } from "../src/translation/providers/prompts.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { requestTranslation, inputOf, modelInput, dropLastProtection, chatFixture, listBatch, defaultPreserveTerms } from "./support/fixtures.ts"

test("full prompt replacement omits an empty system message and expands language aliases exactly once", async (t) => {
  const original = "Original ${targetLang} and $& text."
  const fixture = await chatFixture(t, (body) => {
    assert.deepEqual(body.messages, [{ role: "user", content: "自定义中文名称 | en | zh-CN | 1\nCONTENT=Original ${targetLang} and $& text." }])
    assert.equal(body.response_format, undefined)
    return body.messages[0].content.split("\nCONTENT=")[1]
  })
  const input = inputOf(parseMarkdown(original))
  const settings = {
    ...fixture.settings,
    systemPrompt: "",
    userPrompt: "${targetLang} | ${sourceLangCode} | ${targetLangCode} | ${itemCount}\nCONTENT=${content}",
    languageNames: { "zh-CN": "自定义中文名称" }
  }
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, result).get(input.units[0].id), original)
  const request = {
    settings: { ...settings, targetLanguage: "zh-TW", languageNames: { "zh-TW": "Traditional Chinese" } },
    context: "",
    items: [{ id: "one", text: original, format: "text" as const }]
  }
  assert.equal(renderPrompt("${targetLang}/${content}/${unknown}", request, "%%"), "Traditional Chinese/" + original + "/${unknown}")
})

test("URLs and code identifiers stay protected inside prose, and technical handling does not depend on the language detection switch", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read", "阅读")).join("\n%%\n"))
  for (const unit of [
    { id: "comment", start: 0, end: 0, text: "Read https://example.com/a and sourceId.", format: "text" as const, kind: "comment" as const },
    { id: "string", start: 0, end: 0, text: "Read https://example.com/a and source_id.", format: "text" as const, kind: "string" as const }
  ]) {
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, unit.text)
    assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), unit.text.replace("Read", "阅读"))
    assert.throws(() => prepared.restore(prepared.text.replace("https://example.com/a", "changed")), /translation-structure-invalid/)
  }
  const template = "Read ${targetLang} and ${source.id}."
  const prepared = prepareTranslation({ id: "template", start: 0, end: template.length, text: template, format: "text", kind: "string" }, emptyPreserveTerms, 32)
  assert.equal(prepared.text, template)
  assert.equal(prepared.restore("阅读 ${targetLang} 和 ${source.id}。"), "阅读 ${targetLang} 和 ${source.id}。")
  assert.equal(prepared.restore("阅读 ${目标语言} 和 ${来源.标识}。"), "阅读 ${目标语言} 和 ${来源.标识}。")
  const reordered = prepared.restore("先阅读 ${source.id}，再阅读 ${targetLang}。")
  assert.equal(reordered, "先阅读 ${source.id}，再阅读 ${targetLang}。")
  assert.equal(validateTranslation({ id: "template", start: 0, end: template.length, text: template, format: "text", kind: "string" }, reordered), undefined)
  const input: TranslationInput = { units: [{ id: "technical", start: 0, end: 3, text: "GET", format: "text", kind: "string" }] }
  const output = await requestTranslation(fixture.service, { ...fixture.settings, skipSameLanguage: false }, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, output).get("technical"), "GET")
  assert.equal(fixture.seen.length, 0)
  for (const source of ["Read https://example.com/a?x=1&y=two.", "Read (https://example.com/a).", "Read https://example.com/a_(b)."]) {
    const unit = inputOf(parseMarkdown(source)).units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), source.replace("Read", "阅读"))
  }
})

test("copy-only data completes locally while ordinary names remain translatable", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read", "阅读").replace("sourceId", "来源标识")).join("\n%%\n"))
  for (const value of ["https://example.com/a", "./src/config.ts", "HTTP/2", "0x1234", "ops@example.com", "v1.2.3"]) {
    for (const unit of [{ id: "plain", start: 0, end: value.length, text: value, format: "text" as const }, inputOf(parseYaml("label: " + JSON.stringify(value))).units[1]]) {
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.equal(prepared.hasMarkers, false)
      assert.equal(prepared.needsTranslation, false)
      assert.equal(prepared.restore(prepared.text), unit.text)
    }
  }
  const input = inputOf(parseMarkdown("Read sourceId and source_id."))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, "阅读 来源标识 and source_id.")
  assert.equal(fixture.seen[0].items[0], input.units[0].text)
  assert.equal(prepareTranslation(input.units[0], emptyPreserveTerms, 32).hasMarkers, false)
})

test("default short names only preserve complete bodies and clearing the defaults restores HTTP translation", async (t) => {
  const source = "Read HTTP, HTTPS, HTTP(S), http(s), HTTP/HTTPS, HTTP/2, TCP/IP, DNS, JSON, json, uv.lock, UTF-8, API, GraphQL, CPU, I/O and https://example.com/a now."
  for (const kind of [undefined, "comment", "string"] as const) {
    const unit = { id: "protocol", start: 0, end: source.length, text: source, format: "text" as const, kind }
    const prepared = prepareTranslation(unit, defaultPreserveTerms, 32)
    assert.equal(prepared.needsTranslation, true)
    assert.equal(prepared.text, source)
    const translated = prepared.restore(prepared.text.replace("API", "接口").replace("json", "数据格式"))
    assert.equal(validateTranslation(unit, translated), undefined, "Former built-in short names still constrain validation.")
    assert.equal(translated, source.replace("API", "接口").replace("json", "数据格式"))
    assert.throws(() => prepared.restore(prepared.text.replace("HTTP/2", "")), /translation-structure-invalid/)
  }
  for (const text of ["API!", "API JSON", "api", "JSONify", "myuv.lock", "uv.locker", "wecom"]) {
    const prepared = prepareTranslation({ id: "word", start: 0, end: text.length, text, format: "text" }, defaultPreserveTerms, 32)
    assert.equal(prepared.text, text)
    assert.equal(prepared.needsTranslation, true, text)
  }
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => (item === "API" ? "接口" : "格式")).join("\n%%\n"))
  const input = inputOf(parseMarkdown("API\n\njson"))
  for (const preserveTerms of [emptyPreserveTerms, parsePreserveTerms(["Widget"])]) {
    const result = await requestTranslation(fixture.service, { ...fixture.settings, preserveTerms, skipSameLanguage: false }, input, new AbortController().signal, fixture.gate)
    assert.deepEqual([...validateTranslations(input, result).values()], ["接口", "格式"])
  }
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    ["API", "json", "API", "json"]
  )
})

test("empty source language equals auto, optional source declaration disappears, and the target code is required before HTTP", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const input = listBatch(1)
  const systemPrompt = "target=${targetLangCode}{{#if sourceLangCode}}\nsource=${sourceLangCode}{{/if}}"
  for (const sourceLanguage of ["", "auto", "  "]) {
    await requestTranslation(fixture.service, { ...fixture.settings, sourceLanguage, systemPrompt }, input, new AbortController().signal, fixture.gate)
    const system = fixture.seen.at(-1)!.body.messages[0].content
    assert.equal(system, "target=zh-CN", "Language normalization did not reach the custom template.")
  }
  assert.equal(serviceIdentity({ ...fixture.settings, sourceLanguage: "" }), serviceIdentity({ ...fixture.settings, sourceLanguage: "auto" }))
  const request = { settings: { ...fixture.settings, sourceLanguage: "" }, context: "", items: [{ id: "one", text: "Original", format: "text" as const }] }
  assert.equal(renderPrompt("${sourceLangCode}/${targetLangCode}", request, "%%"), "/zh-CN")
  for (const targetLanguage of ["", "  ", "auto"]) {
    await assert.rejects(requestTranslation(fixture.service, { ...fixture.settings, targetLanguage }, input, new AbortController().signal, fixture.gate), /service-settings-incomplete/)
    assert.throws(() => renderPrompt(defaultSystemPrompt, { ...request, settings: { ...request.settings, targetLanguage } }, "%%"), /service-settings-incomplete/)
  }
  assert.equal(fixture.seen.length, 3, "An unresolved target language reached the HTTP service.")
})

test("partial failure reports a missing link target, keeps 18 successful or skipped units, and emits one terminal summary", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((text) => (text.includes("code-only-no-request") ? dropLastProtection(text) : text)).join("\n\n%%\n\n"))
  const paragraphs = Array.from({ length: 19 }, (_, index) =>
    index === 0
      ? "这是已经写好的中文说明，不需要再次请求翻译服务。"
      : index === 11
        ? "- Read [code-only-no-request](./examples/development/code-only.md)."
        : "Original paragraph number " + index + "."
  )
  const input = inputOf(parseMarkdown(paragraphs.join("\n\n")))
  const events: TranslationEvent[] = []
  await assert.rejects(
    requestTranslation(fixture.service, { ...fixture.settings, skipSameLanguage: true }, input, new AbortController().signal, fixture.gate, undefined, {
      details: false,
      emit: (event) => events.push(event)
    }),
    (error) => error instanceof TranslationFailure && error.reported
  )
  const terminal = events.filter((event) => event.kind === "finish")
  assert.equal(terminal.length, 1)
  const outcome = terminal[0]
  assert.equal(outcome.status, "partial")
  assert.equal(outcome.total, 19)
  assert.equal(outcome.completed, 18)
  assert.equal(outcome.skipped, 1)
  assert.equal(outcome.failures.length, 1)
  assert.equal(outcome.failures[0].source, paragraphs[11])
  assert.equal(outcome.failures[0].start, input.units[11].start)
  assert.equal(outcome.failures[0].attempts, 3)
  assert.equal(outcome.failures[0].difference.expected, "./examples/development/code-only.md")
  assert.equal(outcome.failures[0].difference.actual, "对应标记缺失或被改写")
  assert.equal(events.filter((event) => event.kind === "request").length, fixture.seen.length)
  assert.equal(outcome.httpRequests, fixture.seen.length)
  assert.ok(events.filter((event) => event.kind === "request").every((event) => event.modelRequest === undefined && event.modelResponse === undefined))
  const oversized = "X".repeat(200001)
  assert.ok(validateTranslation(input.units[1], oversized) instanceof ModelRetry)
  assert.ok((validateTranslation(input.units[1], oversized)!.difference!.actual?.length ?? 0) < 100, "Oversized output was expanded into its failure explanation.")
})
