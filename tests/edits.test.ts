import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { unchangedUnitRanges } from "../src/documents/edits.ts"
import type { SourceEdit } from "../src/documents/edits.ts"
import type { TextUnit } from "../src/model/document.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { PreparedInput } from "../src/model/translation.ts"
import { chatFixture, embeddedMarkdown, inputOf, waitFor } from "./support/fixtures.ts"

test("completed units survive neighbouring edits across Markdown, YAML, tables and embedded documents", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  for (const newline of ["\n", "\r\n"]) {
    const cases = [
      { source: ["# Manual", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join(newline), target: "First", replacement: "Updated first", parse: parseMarkdown },
      { source: ["# Manual", "", "First paragraph.", "", "Second paragraph."].join(newline), target: "Manual", replacement: "Updated manual", parse: parseMarkdown },
      { source: ["title: Read the guide", "details: Keep the context", "enabled: true"].join(newline), target: "Read", replacement: "Review", parse: parseYaml },
      { source: ["| Name | Detail |", "| --- | --- |", "| Read | Keep |", "| Other | More |"].join(newline), target: "Read", replacement: "Review", parse: parseMarkdown },
      { source: ["> ```yaml", "> title: Read the guide", "> details: Keep the context", "> ```"].join(newline), target: "Read", replacement: "Review", parse: embeddedMarkdown }
    ]
    for (const scenario of cases) {
      const store = new TranslationStore()
      const before = prepareInput(fixture.settings, inputOf(await scenario.parse(scenario.source)))
      const edit = { rangeOffset: scenario.source.indexOf(scenario.target), rangeLength: scenario.target.length, text: scenario.replacement }
      const source = scenario.source.slice(0, edit.rangeOffset) + edit.text + scenario.source.slice(edit.rangeOffset + edit.rangeLength)
      const after = prepareInput(fixture.settings, inputOf(await scenario.parse(source)))
      const calls: PreparedInput[] = []
      const action: Parameters<TranslationStore["translate"]>[2] = async (input) => {
        calls.push(input)
        return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
      }
      await store.translate("edit", before, action, new AbortController().signal)
      store.retainUnchanged("edit", before, after, [[edit]])
      const result = await store.translate("edit", after, action, new AbortController().signal)
      assert.equal(result.size, after.units.length)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].units.length, 1, scenario.source)
      assert.ok(calls[1].units[0].text.includes(scenario.replacement))
    }
  }
})

test("range mapping handles simultaneous edits, consecutive versions, boundaries, duplicates and deletion without guessing", () => {
  const units: TextUnit[] = [0, 10, 20, 30].map((start) => ({ id: "u" + start, start, end: start + 5, text: "Same.", format: "text" }))
  const batches: SourceEdit[][] = [
    [
      { rangeOffset: 0, rangeLength: 0, text: "++" },
      { rangeOffset: 11, rangeLength: 1, text: "long" },
      { rangeOffset: 25, rangeLength: 0, text: "!" }
    ],
    [{ rangeOffset: 26, rangeLength: 0, text: "inside" }]
  ]
  const mapped = unchangedUnitRanges(units, batches)
  assert.deepEqual(
    [...mapped].map(([range, unit]) => [range, unit.id]),
    [
      ["2:7", "u0"],
      ["42:47", "u30"]
    ]
  )
  assert.deepEqual(
    [...unchangedUnitRanges(units, [[{ rangeOffset: 5, rangeLength: 5, text: "" }]])].map(([range, unit]) => [range, unit.id]),
    [
      ["0:5", "u0"],
      ["5:10", "u10"],
      ["15:20", "u20"],
      ["25:30", "u30"]
    ]
  )
  assert.equal(unchangedUnitRanges(units, [[{ rangeOffset: 0, rangeLength: 40, text: "" }]]).size, 0)
})

test("edit reuse rejects changed syntax roles and settings and never promotes pending or forced-invalidated results", async () => {
  const store = new TranslationStore()
  const unit: PreparedInput["units"][number] = { id: "old", start: 0, end: 5, text: "Read.", format: "text", reference: [{ kind: "Section", text: "Old context" }] }
  const before = { units: [unit] }
  const after = { units: [{ ...unit, id: "new", reference: [{ kind: "Section", text: "New context" }] }] }
  let calls = 0
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) => {
    calls++
    return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  }
  await store.translate("identity", before, action, new AbortController().signal)
  const changedRole = { units: [{ ...after.units[0], kind: "comment" as const }] }
  store.retainUnchanged("identity", before, changedRole, [])
  await store.translate("identity", changedRole, action, new AbortController().signal)
  assert.equal(calls, 2)
  store.retainUnchanged("different-settings", before, after, [])
  await store.translate("different-settings", after, action, new AbortController().signal)
  assert.equal(calls, 3)
  store.invalidate("identity", [before])
  store.retainUnchanged("identity", before, after, [])
  await store.translate("identity", after, action, new AbortController().signal)
  assert.equal(calls, 4)

  store.clear()
  let finish!: () => void
  const controller = new AbortController()
  const pending = store.translate(
    "identity",
    before,
    (input) =>
      new Promise((resolve) => {
        finish = () => resolve(input.units.map((unit) => ({ id: unit.id, text: unit.text })))
      }),
    controller.signal
  )
  const cancelled = assert.rejects(pending)
  await waitFor(() => !!finish)
  store.retainUnchanged("identity", before, after, [])
  controller.abort("document-changed")
  finish()
  await cancelled
  await store.translate("identity", after, action, new AbortController().signal)
  assert.equal(calls, 5)
})
