import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { emptyPreserveTerms, parsePreserveTerms } from "../src/documents/terms.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("language screening ignores complete configured terms and explicit identifiers across source formats", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const settings = {
    ...fixture.settings,
    skipSameLanguage: true,
    preserveTerms: parsePreserveTerms(["Widget", "Studio Edition", "HTTP(S)", { pattern: "Engine[0-9]+" }])
  }
  for (const term of [
    "wIdGeT",
    "Studio Edition",
    "HTTP(S)",
    "Engine42",
    "sourceId",
    "SourceReader",
    "HTTPClient",
    "source_id",
    "SOURCE_ID",
    "_source",
    "$source",
    "client.read",
    "client::Reader"
  ]) {
    const text = "这是 " + term + " 的使用说明，请阅读完整内容。"
    const markdown = inputOf(parseMarkdown(text))
    const yaml = inputOf(parseYaml("label: " + JSON.stringify(text)))
    const units = [
      ...markdown.units,
      yaml.units[1],
      { ...markdown.units[0], id: "comment", format: "text" as const, kind: "comment" as const },
      { ...markdown.units[0], id: "decoded", text: JSON.stringify(text), content: text, format: "text" as const, kind: "string" as const }
    ].map((unit, index) => ({ ...unit, id: String(index) }))
    const result = await requestTranslation(fixture.service, settings, { units }, new AbortController().signal, fixture.gate)
    assert.deepEqual(
      result.map((item) => item.text),
      units.map((unit) => unit.text),
      term
    )
  }
  assert.equal(fixture.seen.length, 0, "Screened technical names still caused HTTP translation.")
})

test("screening leaves foreign prose, partial term matches and standalone identifiers translatable", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const settings = { ...fixture.settings, skipSameLanguage: true, preserveTerms: parsePreserveTerms(["Widget", "Studio Edition", { pattern: "Engine[0-9]+" }]) }
  const sources = [
    "这是 Widgetry 的使用说明，请阅读完整内容。",
    "这是 Otherengine42 的使用说明，请阅读完整内容。",
    "这是 Studio Editions 的使用说明，请阅读完整内容。",
    "这是明确的中文说明，Widget should read the complete document.",
    "这是明确的中文说明，sourceId should read the complete document.",
    "这是 Worker 的使用说明，请阅读完整内容。",
    "这是 well-known 的使用说明，请阅读完整内容。",
    "你好 sourceId",
    "sourceId",
    "SourceReader"
  ]
  for (const source of sources) {
    await requestTranslation(fixture.service, settings, inputOf(parseMarkdown(source)), new AbortController().signal, fixture.gate)
  }
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    sources
  )
})

test("term changes and disabling same-language skipping reconsider the same source without changing request protection", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Widget", "组件").replace("sourceId", "来源标识")).join("\n%%\n"))
  const input = inputOf(parseMarkdown("这是 Widget 的使用说明，请阅读完整内容。"))
  const settings = { ...fixture.settings, skipSameLanguage: true, preserveTerms: parsePreserveTerms(["Widget"]) }
  const skipped = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(skipped[0].text, input.units[0].text)
  assert.equal(fixture.seen.length, 0)
  const translated = await requestTranslation(fixture.service, { ...settings, preserveTerms: emptyPreserveTerms }, input, new AbortController().signal, fixture.gate)
  assert.equal(translated[0].text, input.units[0].text.replace("Widget", "组件"))
  const identifier = inputOf(parseMarkdown("这是 sourceId 的使用说明，请阅读完整内容。"))
  const disabled = await requestTranslation(fixture.service, { ...settings, skipSameLanguage: false }, identifier, new AbortController().signal, fixture.gate)
  assert.equal(disabled[0].text, identifier.units[0].text.replace("sourceId", "来源标识"))
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    [input.units[0].text, identifier.units[0].text]
  )
})

test("screening keeps longest phrases, exact whitespace and independent regex flags", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const settings = {
    ...fixture.settings,
    skipSameLanguage: true,
    preserveTerms: parsePreserveTerms([
      "Studio",
      "Studio Edition",
      "Studio Edition Server",
      "SourceReader Edition",
      "Copper  Edition",
      "Silver\tEdition",
      { pattern: "(Q)\\1" },
      { pattern: "Copper" },
      { pattern: "Bronze", flags: "i" }
    ])
  }
  for (const term of ["studio edition server", "SourceReader Edition", "Copper  Edition", "Silver\tEdition", "QQ", "bRoNzE"]) {
    const input = inputOf(parseMarkdown("这是 " + term + " 的使用说明，请阅读完整内容。"))
    const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
    assert.equal(result[0].text, input.units[0].text)
  }
  assert.equal(fixture.seen.length, 0, "A matched phrase or regex caused unnecessary HTTP.")
  const requested = ["Studio Editions", "Studio, Edition", "Studio\tEdition", "Copper Edition", "Silver Edition", "copper", "Qq"].map(
    (term) => "这是 " + term + " 的使用说明，请阅读完整内容。"
  )
  for (const source of requested) await requestTranslation(fixture.service, settings, inputOf(parseMarkdown(source)), new AbortController().signal, fixture.gate)
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    requested
  )
})
