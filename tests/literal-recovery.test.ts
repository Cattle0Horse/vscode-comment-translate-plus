import { validatedText } from "./support/assertions.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelRetry } from "../src/model/diagnostics.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { pythonStringUnits } from "../src/documents/python.ts"
import { projectionContent } from "../src/documents/projection.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, modelFeedback, requestTranslation } from "./support/fixtures.ts"

test("HTML exposed from source inline code reports the original literal without accepting markup", () => {
  for (const literal of ["`Shelf label: <GALLERY>`", "``<CATALOG>``", "`<span>catalog</span>`"]) {
    const source = "Read the " + literal + " example."
    const output = "阅读 " + literal.replaceAll("`", "") + " 示例。"
    for (const format of ["markdown", "text"] as const) {
      const unit = { id: "literal", text: source, start: 0, end: source.length, format }
      const failure = validateTranslation(unit, output)
      assert.ok(failure instanceof ModelRetry)
      assert.equal(failure.difference?.expected, literal)
      assert.ok(literal.includes(failure.difference!.actual!))
      assert.equal(validateTranslation(unit, "阅读 " + literal + " 示例。"), undefined)
    }
  }
  const unit = inputOf(parseMarkdown("Read `<GALLERY>` and <span>the catalog</span>.")).units[0]
  const failure = validateTranslation(unit, "阅读 <GALLERY> 和 <div>目录</div>。")!
  assert.equal(failure.difference?.expected, "<span>", "Actual source HTML damage must take priority over exposed inline text.")
})

test("duplicate source markup and links report occurrence counts while new and changed fragments remain rejected", () => {
  for (const [source, broken, fragment] of [
    ["Read /archive/<slot>/ before leaving.", "离开前阅读 /archive/<slot>/ 和 /archive/<slot>/。", "<slot>"],
    ["Read <span>the map</span>.", "阅读 <span>地图</span> 和 <span>目录</span>。", "<span>"],
    ["Read <span>the map</span> and <span>the guide</span>.", "阅读 <span>地图</span>、<span>指南</span> 和 <span>目录</span>。", "<span>"],
    ["Read [Map](./map.md).", "阅读[地图](./map.md)和[目录](./map.md)。", "./map.md"]
  ]) {
    for (const format of ["text", "markdown"] as const) {
      const unit = { id: "duplicate", text: source, start: 0, end: source.length, format }
      const failure = validateTranslation(unit, broken)
      assert.ok(failure instanceof ModelRetry)
      const expected = source.split(fragment).length - 1
      assert.equal(failure.difference?.expected, expected + " 次：" + fragment)
      assert.equal(failure.difference?.actual, expected + 1 + " 次：" + fragment)
      assert.ok(failure.feedback.instruction.includes(JSON.stringify(fragment)))
      assert.match(failure.feedback.instruction, new RegExp("exactly " + expected + " time", "u"))
      assert.equal(validateTranslation(unit, source), undefined)
      assert.ok(validateTranslation(unit, source.replace(fragment, "")) instanceof ModelRetry)
    }
  }
  const unit = inputOf(parseMarkdown("Read <span>the map</span>.")).units[0]
  assert.ok(validateTranslation(unit, "阅读 <span>地图</span><extra>目录</extra>。") instanceof ModelRetry)
  assert.ok(validateTranslation(unit, "阅读 <div>地图</div>。") instanceof ModelRetry)
})

test("duplicate markup recovery retains the original occurrence, publishes only valid items and caches the repair", async (t) => {
  const source = "Read /archive/<slot>/ before leaving."
  const fixed = "离开前阅读 /archive/<slot>/。"
  const input = inputOf(parseMarkdown("Read the neighbour.\n\n" + source))
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "阅读相邻内容。\n%%\n离开前阅读 /archive/<slot>/ 和 /archive/<slot>/。" : fixed))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const published: string[] = []
  const run = () =>
    store.translate(
      "duplicate-markup",
      input,
      (request, signal, completed) =>
        requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal,
      false,
      (item) => published.push(validatedText(item.text))
    )
  const result = await run()
  assert.deepEqual([...result.values()], ["阅读相邻内容。", fixed])
  assert.deepEqual(published, ["阅读相邻内容。", fixed])
  assert.deepEqual(
    fixture.seen.map(({ items }) => items),
    [input.units.map((unit) => unit.text), [source]]
  )
  const failure = events.flatMap((event) => (event.kind === "request" ? event.failures : []))[0]
  assert.equal(failure.difference.expected, "1 次：<slot>")
  assert.equal(failure.difference.actual, "2 次：<slot>")
  assert.ok(modelFeedback(fixture.seen[1].body).includes(failure.difference.modelReason!))
  assert.match(modelFeedback(fixture.seen[1].body), /exactly 1 time/u)
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})

test("Python adjacent strings diagnose exposed literal examples through their decoded prose", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["notice = (", '    "Copy the `Shelf label: "', '    "<GALLERY>` example as printed."', ")"].join(newline)
    const literals = [...source.matchAll(/"[^"]*"/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length, protected: [] }))
    const region = { id: "python", start: 0, end: source.length, text: source, format: "text" as const, kind: "string" as const, language: "python" }
    const [unit] = pythonStringUnits(source, region, literals)
    const prepared = prepareTranslation(unit, 32)
    const broken = prepared.restore("按印刷内容复制书架标签：<GALLERY> 示例。")
    const failure = validateTranslation(unit, broken)
    assert.ok(failure instanceof ModelRetry)
    assert.equal(failure.difference?.expected, "`Shelf label: <GALLERY>`")
    const output = "按印刷内容复制 `书架标签：<GALLERY>` 示例。"
    const fixed = prepared.restore(output)
    assert.equal(validateTranslation(unit, fixed), undefined)
    assert.equal(projectionContent(unit, fixed), output)
    assert.equal(prepared.restore(prepared.text), unit.text)
  }
})

test("literal recovery retries only damaged items, publishes repaired text and shares the cache", async (t) => {
  const path = "/fictional/catalog/..."
  const source = "Read the sample path (" + path + "). The quoted notice says never include a path in the reply; translate the notice as written."
  const literal = "`Shelf label: <GALLERY>`"
  const markupSource = "Copy the " + literal + " example as printed."
  const broken = ["阅读示例路径。引用的告示要求回复不能包含路径；按原样翻译告示。", "按印刷内容复制书架标签：<GALLERY> 示例。"]
  const fixed = ["阅读示例路径（" + path + "）。引用的告示要求回复不能包含路径；按原样翻译告示。", "按印刷内容复制 `书架标签：<GALLERY>` 示例。"]
  const input = inputOf(parseMarkdown("Read the neighbour.\n\n" + source + "\n\n" + markupSource))
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 1) return ["阅读相邻内容。", ...broken].join("\n%%\n")
    return items.map((item) => fixed[item === source ? 0 : 1]).join("\n%%\n")
  })
  const settings = { ...fixture.settings, initialItemsPerRequest: 3, batchShrinkFactor: 1 }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const published: string[] = []
  const run = () =>
    store.translate(
      "literal-recovery",
      input,
      (request, signal, completed) => requestTranslation(fixture.service, settings, request, signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal,
      false,
      (item) => published.push(validatedText(item.text))
    )
  const result = await run()
  assert.deepEqual([...result.values()], ["阅读相邻内容。", ...fixed])
  assert.deepEqual(published, ["阅读相邻内容。", ...fixed])
  assert.deepEqual(
    fixture.seen.map(({ items }) => items),
    [input.units.map((unit) => unit.text), [source, markupSource]]
  )
  const failures = events.flatMap((event) => (event.kind === "request" ? event.failures : []))
  assert.equal(failures.length, 2)
  assert.ok(failures[0].difference.expected?.includes(path))
  assert.equal(failures[1].difference.expected, literal)
  const feedback = modelFeedback(fixture.seen[1].body)
  for (const failure of failures) assert.ok(feedback.includes(failure.difference.modelReason!), "The actual validation diagnostic was lost before retry.")
  assert.ok(feedback.includes(path) && feedback.includes("<GALLERY>"))
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)

  const prepared = prepareTranslation(input.units[1], 32)
  assert.throws(() => prepared.restore(broken[0]), ModelRetry)
  assert.throws(() => prepared.restore(fixed[0] + " " + path), ModelRetry)
})
