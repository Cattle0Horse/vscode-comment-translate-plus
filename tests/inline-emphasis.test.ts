import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("translations that omit inline emphasis complete on the first attempt and share cached preview results", async (t) => {
  const cases = [
    {
      source:
        "The village library keeps its **illustrated** travel guides on the upper shelf. Each volume includes a map, a short history of the region, and suggested walking routes for visitors.",
      output: "乡村图书馆将带插图的旅行指南放在上层书架。每卷都包含地图、当地简史以及供游客参考的步行路线。"
    },
    {
      source: "- A shelf label `catalog.txt` is **recommended**: include a short `title`, an `author`, and a `year` before listing the available books.",
      output: "建议提供书架标签 `catalog.txt`：先填写简短的 `title`、`author` 和 `year`，再列出可借阅的图书。"
    },
    { source: "Read *carefully* now.", output: "现在仔细阅读。" },
    { source: "Read _carefully_ now.", output: "现在仔细阅读。" }
  ]
  for (const { source, output } of cases) {
    const fixture = await chatFixture(t, () => output)
    const document = parseMarkdown(source)
    const input = inputOf(document)
    const store = new TranslationStore()
    t.after(() => store.clear())
    const events: TranslationEvent[] = []
    const run = () =>
      store.translate(
        "optional-bold",
        input,
        (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, undefined, { details: false, emit: (event) => events.push(event) }),
        new AbortController().signal
      )
    const result = await run()
    const expected = (source.startsWith("- ") ? "- " : "") + output
    assert.equal(result.get(input.units[0].id), expected)
    assert.equal(translatedMarkdown(document, result), expected)
    assert.ok(events.some((event) => event.kind === "finish" && event.status === "complete" && event.failures.length === 0))
    assert.ok(events.every((event) => event.kind !== "request" || event.failures.length === 0))
    assert.deepEqual(await run(), result)
    assert.equal(fixture.seen.length, 1, "Omitted bold triggered recovery or bypassed the shared cache.")
    assert.equal(document.source, source)
  }
})

test("inline emphasis is model-owned across nested markup, lists, headings and tables", () => {
  for (const [source, output] of [
    ["Read carefully.", "**仔细**阅读。"],
    ["Read **carefully** now.", "**现在**仔细阅读。"],
    ["Read __carefully__ now.", "现在仔细阅读。"],
    ["Read *carefully* now.", "现在仔细阅读。"],
    ["Read _carefully_ now.", "现在仔细阅读。"],
    ["Read carefully.", "*仔细*阅读。"],
    ["Read ***very carefully*** now.", "现在非常仔细地阅读。"],
    ["Read **very *carefully***.", "非常*仔细*地阅读。"],
    ["Read [**guide**](https://example.com).", "阅读**[指南](https://example.com)**。"],
    ["Read [*guide*](https://example.com).", "阅读*[指南](https://example.com)*。"],
    ["# Read **carefully** now.", "# 现在仔细阅读。"],
    ["- Read **carefully** now.", "- 现在仔细阅读。"],
    ["| Read **carefully** now. |\n| --- |", "| 现在仔细阅读。 |\n| --- |"]
  ]) {
    const document = parseMarkdown(source)
    const unit = inputOf(document).units[0]
    const translated = inputOf(parseMarkdown(output)).units[0].text
    assert.equal(validateTranslation(unit, translated), undefined, source)
    assert.equal(translatedMarkdown(document, new Map([[unit.id, translated]])), output)
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.restore(prepareTranslation({ ...unit, text: translated }, 32).text), translated)
  }
})

test("optional emphasis cannot hide damaged links, block structure or other required inline syntax", () => {
  for (const [source, output] of [
    ["Read **[guide](https://example.com)**.", "阅读[指南](https://other.example)。"],
    ["Read **~~obsolete~~** text.", "阅读过时的文本。"],
    ["Read **carefully**.", "## 仔细阅读。"],
    ["Read **carefully**.", "仔细阅读。\n\n额外段落。"],
    ["| **Read carefully.** |\n| --- |", "仔细阅读。 | 新列"]
  ]) {
    const document = parseMarkdown(source)
    const unit = inputOf(document).units[0]
    assert.ok(validateTranslation(unit, output), source)
    assert.throws(() => translatedMarkdown(document, new Map([[unit.id, output]])), /translation-structure-invalid/)
  }
})

test("a comparison exposed by omitted emphasis remains a blockquote error until valid recovery is cached", async (t) => {
  const body = "**> 2,400 pages**: Archive shelf — sort by year, then by shelf number."
  const broken = "> 2,400页以上：档案书架——先按年份排序，再按书架编号排序。"
  for (const prefix of ["", "4. "]) {
    for (const fixed of ["**> 2,400 页**：档案书架——先按年份排序，再按书架编号排序。", "超过 2,400 页：档案书架——先按年份排序，再按书架编号排序。"]) {
      const document = parseMarkdown(prefix + body)
      const input = inputOf(document)
      const unit = input.units[0]
      const invalid = prefix + broken
      assert.equal(validateTranslation(unit, invalid)?.difference?.actual, ">")
      assert.throws(() => translatedMarkdown(document, new Map([[unit.id, invalid]])), /translation-structure-invalid/)
      const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? broken : fixed))
      const store = new TranslationStore()
      t.after(() => store.clear())
      const published: string[] = []
      const run = () =>
        store.translate(
          "inline-comparison",
          input,
          (request, signal, completed) =>
            requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, (item) => {
              published.push(item.text)
              completed?.(item)
            }),
          new AbortController().signal
        )
      const result = await run()
      assert.equal(result.get(unit.id), prefix + fixed)
      assert.equal(translatedMarkdown(document, result), prefix + fixed)
      assert.deepEqual(published, [prefix + fixed], "An invalid comparison was published before recovery.")
      assert.deepEqual(await run(), result)
      assert.equal(fixture.seen.length, 2, "The recovered comparison was retried or not cached.")
      assert.equal(document.source, prefix + body)
    }
  }
})

test("comparisons in table cells and locally restored emphasis do not become blockquotes", () => {
  for (const [source, output, expected] of [
    ["**> 2,400 pages**", "> 2,400 页", "**> 2,400 页**"],
    ["| **> 2,400 pages**: Archive shelf. |\n| --- |", "> 2,400 页：档案书架。", "| > 2,400 页：档案书架。 |\n| --- |"]
  ]) {
    const document = parseMarkdown(source)
    const unit = inputOf(document).units[0]
    const restored = prepareTranslation(unit, 32).restore(output)
    assert.equal(validateTranslation(unit, restored), undefined)
    assert.equal(translatedMarkdown(document, new Map([[unit.id, restored]])), expected)
  }
})
