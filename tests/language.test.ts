import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { validTranslation, translationDifference } from "../src/documents/validation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { TranslationFailure } from "../src/model/diagnostics.ts"
import { defaultSystemPrompt, renderPrompt } from "../src/translation/providers/prompts.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { requestTranslation, inputOf, modelInput, dropLastProtection, chatFixture, listBatch, defaultPreserveTerms } from "./support/fixtures.ts"

test("full prompt replacement omits an empty system message and expands language aliases exactly once", async (t) => {
  const original = "Original ${targetLang} and $& text."
  const fixture = await chatFixture(t, (body) => {
    assert.deepEqual(body.messages, [{ role: "user", content: "自定义中文名称 | en | zh-CN | 1\nCONTENT=Original <CTP0> and $& text." }])
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
    const prepared = prepareTranslation(unit, [])
    assert.ok(!prepared.text.includes("https://") && !prepared.text.includes("source"))
    assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), unit.text.replace("Read", "阅读"))
    assert.throws(() => prepared.restore(prepared.text.replace("<CTP0>", "changed")), /translation-marker-mismatch/)
  }
  const template = "Read ${targetLang} and ${source.id}."
  const prepared = prepareTranslation({ id: "template", start: 0, end: template.length, text: template, format: "text", kind: "string" }, [])
  assert.equal(prepared.text, "Read <CTP0> and <CTP1>.")
  assert.equal(prepared.restore("阅读 <CTP0> 和 <CTP1>。"), "阅读 ${targetLang} 和 ${source.id}。")
  assert.throws(() => prepared.restore("阅读 <CTP0> 和 ${source.id}。"), /translation-marker-mismatch/)
  const reordered = prepared.restore("先阅读 <CTP1>，再阅读 <CTP0>。")
  assert.equal(reordered, "先阅读 ${source.id}，再阅读 ${targetLang}。")
  assert.equal(validTranslation({ id: "template", start: 0, end: template.length, text: template, format: "text", kind: "string" }, reordered), true)
  const input: TranslationInput = { units: [{ id: "technical", start: 0, end: 3, text: "GET", format: "text", kind: "string" }] }
  const output = await requestTranslation(fixture.service, { ...fixture.settings, skipSameLanguage: false }, input, new AbortController().signal, fixture.gate)
  assert.equal(validateTranslations(input, output).get("technical"), "GET")
  assert.equal(fixture.seen.length, 0)
  for (const source of ["Read https://example.com/a?x=1&y=two.", "Read (https://example.com/a).", "Read https://example.com/a_(b)."]) {
    const unit = inputOf(parseMarkdown(source)).units[0]
    const prepared = prepareTranslation(unit, [])
    assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), source.replace("Read", "阅读"))
  }
})

test("technical identifiers complete locally across prose, Markdown and YAML values regardless of target language", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read", "阅读")).join("\n%%\n"))
  const values = [
    ...defaultPreserveTerms.filter((term): term is string => typeof term === "string"),
    "HTTP",
    "HTTPS",
    "HTTP(S)",
    "http",
    "https",
    "http(s)",
    "HtTp",
    "sourceId",
    "source_id",
    "API_KEY",
    "HTTP/1.1",
    "HTTP/2",
    "HTTP/3",
    "${targetLang}",
    "process.env.PORT",
    "./src/config.ts",
    "/usr/local/bin/tool",
    "C:\\tools\\config.json",
    "ops+test@example.com",
    "v1.2.3-beta.1+build.7",
    "0x1A2B",
    "0123456789abcdef0123456789abcdef",
    "HTTPS://example.com/a"
  ]
  for (const targetLanguage of ["zh-CN", "en-US", "ja"]) {
    const units = values.flatMap((value, index) => [
      { id: "text" + index, start: 0, end: value.length, text: value, format: "text" as const },
      ...inputOf(parseMarkdown(value)).units.map((unit) => ({ ...unit, id: "md" + index })),
      { id: "yaml" + index, start: 0, end: JSON.stringify(value).length, text: JSON.stringify(value), content: value, format: "yaml" as const }
    ])
    const input = { units }
    const result = validateTranslations(
      input,
      await requestTranslation(fixture.service, { ...fixture.settings, targetLanguage, skipSameLanguage: false }, input, new AbortController().signal, fixture.gate)
    )
    assert.deepEqual(
      [...result.values()],
      units.map((unit) => unit.text)
    )
  }
  assert.equal(fixture.seen.length, 0, "A format or target language bypassed technical identifier classification.")
  const list = "sourceId, source_id; ${targetLang}."
  const listed = { id: "list", start: 0, end: list.length, text: list, format: "text" as const }
  assert.equal(prepareTranslation(listed, []).needsTranslation, false, "Separators around fully protected identifiers triggered HTTP.")
  const mixed = "Read sourceId and source_id at ./src/config.ts with v1.2.3."
  const input = inputOf(parseMarkdown(mixed))
  const result = validateTranslations(input, await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate))
  assert.equal(result.get(input.units[0].id), mixed.replace("Read", "阅读"))
  assert.ok(fixture.seen[0].items[0].includes("Read") && !fixture.seen[0].items[0].includes("sourceId") && !fixture.seen[0].items[0].includes("./src"))
  const yaml = inputOf(parseYaml("setting_name: sourceId\nother_label: source_id\nAPI: HTTP(S)\nDNS: HTTPS\n"))
  const beforeYaml = fixture.seen.length
  await requestTranslation(fixture.service, fixture.settings, yaml, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    fixture.seen.slice(beforeYaml).flatMap((request) => request.items),
    ["setting_name", "other_label"],
    "YAML identifier values or protected keys violated the key/value reading contract."
  )
  for (const value of ["all", "wecom", "ai-collection", "and/or", "Read the original document."])
    assert.equal(prepareTranslation({ id: "ordinary", start: 0, end: value.length, text: value, format: "text" }, []).needsTranslation, true, value)
})

test("default short names only preserve complete bodies and clearing the defaults restores HTTP translation", async (t) => {
  const source = "Read HTTP, HTTPS, HTTP(S), http(s), HTTP/HTTPS, HTTP/2, TCP/IP, DNS, JSON, json, uv.lock, UTF-8, API, GraphQL, CPU, I/O and https://example.com/a now."
  for (const kind of [undefined, "comment", "string"] as const) {
    const unit = { id: "protocol", start: 0, end: source.length, text: source, format: "text" as const, kind }
    const prepared = prepareTranslation(unit, defaultPreserveTerms)
    assert.equal(prepared.needsTranslation, true)
    assert.equal(prepared.text, source.replace("HTTP/2", "<CTP0>").replace("https://example.com/a", "<CTP1>"))
    const translated = prepared.restore(prepared.text.replace("API", "接口").replace("json", "数据格式"))
    assert.equal(validTranslation(unit, translated), true, "Former built-in short names still constrain validation.")
    assert.equal(translated, source.replace("API", "接口").replace("json", "数据格式"))
    assert.throws(() => prepared.restore(prepared.text.replace("<CTP0>", "")), /translation-marker-mismatch/)
  }
  for (const text of ["API!", "API JSON", "api", "JSONify", "myuv.lock", "uv.locker", "wecom"]) {
    const prepared = prepareTranslation({ id: "word", start: 0, end: text.length, text, format: "text" }, defaultPreserveTerms)
    assert.equal(prepared.text, text)
    assert.equal(prepared.needsTranslation, true, text)
  }
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => (item === "API" ? "接口" : "格式")).join("\n%%\n"))
  const input = inputOf(parseMarkdown("API\n\njson"))
  for (const preserveTerms of [[], ["Widget"]]) {
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
  assert.equal(validTranslation(input.units[1], oversized), false)
  assert.ok((translationDifference(input.units[1], oversized).actual?.length ?? 0) < 100, "Oversized output was expanded into its failure explanation.")
})
