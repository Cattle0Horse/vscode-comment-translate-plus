import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { displayTranslations, translatedMarkdown, progressiveMarkdown, previewLoadingMarker } from "../src/documents/presentation.ts"
import type { TranslationCandidate, TranslationValue } from "../src/model/translation.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { markdownTree, children } from "../src/documents/tree.ts"
import type { TextUnit } from "../src/model/document.ts"

test("exhausted native-fragment checks return a changed display candidate from the latest attributable response", async (t) => {
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "进入展览前阅读指南。" : "参观展览前阅读手册。"))
  const input = inputOf(parseMarkdown("Read /gallery/guide.md before entering the exhibition."))
  const events: TranslationEvent[] = []
  const items = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, undefined, {
    details: false,
    emit: (event) => events.push(event)
  })
  assert.deepEqual(items[0].text, { kind: "candidate", text: "参观展览前阅读手册。", attempt: 3, code: "translation-structure-invalid" })
  assert.equal(fixture.seen.length, 3)
  const finish = events.find((event) => event.kind === "finish")!
  assert.ok(finish.kind === "finish" && finish.status === "complete" && finish.completed === 1 && finish.changed === 1 && !finish.failures.length)
  assert.deepEqual(finish.candidates, [{ id: input.units[0].id, attempt: 3, code: "translation-structure-invalid" }])
})

test("an earlier attributable candidate survives later transport failures", async (t) => {
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "进入展览前阅读指南。" : { status: 503 }))
  const input = inputOf(parseMarkdown("Read /gallery/guide.md before entering the exhibition."))
  const items = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(items[0].text, { kind: "candidate", text: "进入展览前阅读指南。", attempt: 1, code: "translation-structure-invalid" })
  assert.equal(fixture.seen.length, 3)
})

test("candidate display reuses normal marker-shell recovery and expands only verified source data", async (t) => {
  const url = "https://assets.example/gallery/a-very-long-fictional-document-address.html"
  for (const expanded of [false, true]) {
    const fixture = await chatFixture(t, () => "进入前阅读 " + (expanded ? url : "＜CTP0＞") + "。")
    const input = inputOf(parseMarkdown("Read /gallery/map.md and " + url + " before entering."))
    const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
    assert.deepEqual(result[0].text, { kind: "candidate", text: "进入前阅读 " + url + "。", attempt: 3, code: "translation-structure-invalid" })
  }
})

test("a normally accepted unchanged result takes precedence and produces no candidate row", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "请阅读指南。" : items[0]))
  const source = "Read /gallery/guide.md."
  const input = inputOf(parseMarkdown(source))
  const values = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.equal(values[0].text, source)
  assert.equal(displayTranslations(source, [{ ...input.units[0], translation: values[0].text }]).length, 0)
  assert.equal(fixture.seen.length, 2)
})

test("unchanged natural prose with omitted native fragments does not manufacture a translation", async (t) => {
  const fixture = await chatFixture(t, () => "Read the guide before entering.")
  const input = inputOf(parseMarkdown("Read the guide /gallery/guide.md before entering."))
  await assert.rejects(requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate), /translation-structure-invalid/u)
})

test("unrestorable data markers and ambiguous item boundaries produce no display candidate", async (t) => {
  for (const ambiguous of [false, true]) {
    const fixture = await chatFixture(t, (_body, _items, call) => (ambiguous ? (call === 1 ? "译文甲。\n%%\n译文乙。\n%%\n译文丙。" : "") : "阅读展览指南。"))
    const source = ambiguous ? "Read the gallery guide.\n\nKeep the printed map." : "Read https://assets.example/gallery/very-long-fictional-catalog-file-name-for-the-exhibition.html."
    await assert.rejects(requestTranslation(fixture.service, fixture.settings, inputOf(parseMarkdown(source)), new AbortController().signal, fixture.gate))
  }
})

test("cancellation after collecting a candidate does not publish it or complete the task", async (t) => {
  const fixture = await chatFixture(t, () => "进入展览前阅读指南。")
  const controller = new AbortController()
  const published: TranslationValue[] = []
  await assert.rejects(
    requestTranslation(
      fixture.service,
      fixture.settings,
      inputOf(parseMarkdown("Read /gallery/guide.md before entering.")),
      controller.signal,
      fixture.gate,
      (item) => published.push(item.text),
      {
        details: false,
        emit(event) {
          if (event.kind === "request") controller.abort("user-cancelled")
        }
      }
    )
  )
  assert.deepEqual(published, [])
  assert.equal(fixture.seen.length, 1)
})

test("preview candidates remain literal text beside their source block and keep pending loading positions", () => {
  const source = "Read the guide.\n\nKeep the map."
  const parsed = parseMarkdown(source)
  const candidate: TranslationCandidate = { kind: "candidate", text: "阅读指南 <script>示例</script>。\n```\n# literal", attempt: 3, code: "translation-structure-invalid" }
  const values = new Map([[parsed.groups[0].units[0].id, candidate]])
  const rendered = translatedMarkdown(parsed, values)
  assert.ok(rendered.startsWith("Read the guide."))
  assert.ok(rendered.includes(candidate.text))
  const blocks = children(markdownTree(rendered).topNode)
  assert.equal(blocks.filter((block) => block.name === "FencedCode").length, 1)
  assert.equal(
    blocks.some((block) => block.name === "HTMLBlock" || block.name.startsWith("ATXHeading")),
    false
  )
  const progressive = progressiveMarkdown(parsed, values)
  assert.equal(progressive.split(previewLoadingMarker).length - 1, 1)
  assert.ok(progressive.includes("Keep the map. " + previewLoadingMarker))
  const [row] = displayTranslations(source, [{ ...parsed.groups[0].units[0], translation: candidate }])
  assert.equal(row.translation, candidate.text)
  assert.equal(row.candidate, true)
})

test("JSON candidates retain source colons and native values when multiple fields share a display row", () => {
  const source = '{"guide": "Read /gallery/map.md", "open": true}'
  const parts = ['"guide"', '"Read /gallery/map.md"'].map((text, index): TextUnit & { translation: TranslationValue } => {
    const start = source.indexOf(text)
    return {
      id: String(index),
      start,
      end: start + text.length,
      text,
      format: "text",
      kind: "string",
      language: "json",
      translation: { kind: "candidate", text: index ? "阅读地图" : "指南", attempt: 3, code: "translation-structure-invalid" }
    }
  })
  const rows = displayTranslations(source, parts)
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].translation), { 指南: "阅读地图", open: true })
  assert.equal(rows[0].candidate, true)
})

test("display candidates reuse memory without entering the persistent validated cache", async (t) => {
  const fixture = await chatFixture(t, () => "进入展览前阅读指南。")
  const input = inputOf(parseMarkdown("Read /gallery/guide.md before entering the exhibition."))
  const saved: string[] = []
  const store = new TranslationStore({
    get: async () => undefined,
    set: (key) => {
      saved.push(key)
      return true
    },
    remove: () => {},
    touch: () => {},
    reserve: () => "reserved",
    releaseReservation: () => {}
  })
  t.after(() => store.clear())
  const run = () => store.translate("candidate", input, (batch, signal) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate), new AbortController().signal)
  const first = await run()
  const requests = fixture.seen.length
  assert.deepEqual(await run(), first)
  assert.equal(fixture.seen.length, requests)
  assert.deepEqual(saved, [])
})
