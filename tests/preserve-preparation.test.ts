import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { parsePreserveTerms, emptyPreserveTerms } from "../src/documents/terms.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TextUnit } from "../src/model/document.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("preserved units complete without compiling unused reference prompts, while requested units still validate them", async (t) => {
  const fixture = await chatFixture(t, () => "控件")
  const input = { units: [inputOf(parseMarkdown("# Guide\n\nWidget")).units.at(-1)!] }
  const settings = { ...fixture.settings, preserveTerms: parsePreserveTerms(["Widget"]), systemPrompt: "{{#if unknown}}Unused{{/if}}" }
  const completed: string[] = []
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, (item) => completed.push(item.text))
  assert.deepEqual(
    result.map((item) => item.text),
    ["Widget"]
  )
  assert.deepEqual(completed, ["Widget"])
  assert.equal(fixture.seen.length, 0)
  await assert.rejects(
    requestTranslation(fixture.service, { ...settings, preserveTerms: emptyPreserveTerms }, input, new AbortController().signal, fixture.gate),
    /prompt-template-invalid/
  )
})

test("preserved bodies retain exact source syntax, share the result cache and are reconsidered when rules change", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map(() => "控件").join("\n%%\n"))
  const logical: TextUnit = { id: "logical", text: "Widget", start: 0, end: 6, format: "text" }
  const units: TextUnit[] = (
    [
      logical,
      ...inputOf(parseMarkdown("# **wIdGeT**")).units,
      ...inputOf(parseYaml('Widget: "WIDGET"')).units,
      { ...logical, id: "comment", text: "// Widget", end: 9, kind: "comment", commentPrefix: "//" },
      { ...logical, id: "decoded", text: '"Wid\\u0067et"', end: 13, content: "Widget", kind: "string" },
      { ...logical, id: "multiline", text: "Widget\r\nEdition", end: 15 },
      { ...logical, id: "container", text: "> Widget", end: 8, projection: { kind: "container", unit: logical, prefixes: ["> "] } }
    ] satisfies TextUnit[]
  ).map((unit, index) => ({ ...unit, id: "u" + index, end: unit.text.length }))
  const settings = { ...fixture.settings, preserveTerms: parsePreserveTerms(["Widget", { pattern: "Widget\\r\\nEdition" }]), skipSameLanguage: true }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const prepared = prepareInput(settings, { units })
  const run = () =>
    store.translate(
      serviceIdentity(settings),
      prepared,
      (input, signal, completed) => fixture.service.request(settings, input, signal, fixture.gate, completed),
      new AbortController().signal
    )
  const result = await run()
  assert.deepEqual(
    units.map((unit) => result.get(unit.id)),
    units.map((unit) => unit.text)
  )
  let reused = 0
  assert.deepEqual(
    await store.translate(
      serviceIdentity(settings),
      prepared,
      () => assert.fail("A preserved result was not cached."),
      new AbortController().signal,
      false,
      undefined,
      (event) => {
        if (event.kind === "cache") reused += event.count
      }
    ),
    result
  )
  assert.equal(reused, units.length)
  assert.equal(fixture.seen.length, 0)
  const disabled = { ...settings, preserveTerms: emptyPreserveTerms }
  const previous = prepared.units[0]
  const updated = prepareInput(disabled, { units: [previous] })
  const translated = await store.translate(
    serviceIdentity(disabled),
    updated,
    (input, signal, completed) => fixture.service.request(disabled, input, signal, fixture.gate, completed),
    new AbortController().signal
  )
  assert.equal(translated.get(previous.id), "控件")
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    ["Widget"]
  )
})

test("preservation keeps source validation, service validation and cancellation ahead of completion", async (t) => {
  const fixture = await chatFixture(t, () => "控件")
  const settings = { ...fixture.settings, preserveTerms: parsePreserveTerms(["Widget"]) }
  const invalid: TextUnit = { id: "invalid", text: '"Widget', content: "Widget", start: 0, end: 7, format: "text", kind: "string" }
  const completed: string[] = []
  await assert.rejects(
    requestTranslation(fixture.service, settings, { units: [invalid] }, new AbortController().signal, fixture.gate, (item) => completed.push(item.text)),
    /translation-structure-invalid/
  )
  const valid = inputOf(parseMarkdown("Widget"))
  await assert.rejects(requestTranslation(fixture.service, { ...settings, model: "" }, valid, new AbortController().signal, fixture.gate), /service-settings-incomplete/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(requestTranslation(fixture.service, settings, valid, cancelled.signal, fixture.gate))
  assert.deepEqual(completed, [])
  assert.equal(fixture.seen.length, 0)
})
