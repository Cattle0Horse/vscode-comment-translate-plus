import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { unlikelyTargetLanguage } from "../src/documents/languageDetection.ts"
import { TranslationLog } from "../src/host/logging.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { modelFeedback, chatFixture, inputOf, requestTranslation, dropLastProtection, logContext } from "./support/fixtures.ts"

const source = "Prefer the shortest sufficient sequence. Style/concept exploration uses independent calls with any required original references, not chained variants."
const translation = "优先采用足够完成任务的最短步骤。风格或概念探索使用独立调用，并提供所需的原始参考，不要串联生成变体。"

test("post-translation language review retries only suspicious prose and caches the reviewed result", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? [items[0], "已翻译的正常邻项。"].join("\n%%\n") : translation))
  const settings = { ...fixture.settings, systemPrompt: "Translate into ${targetLang}.", userPrompt: "Translate to ${targetLang}:\n\n${content}" }
  const input = inputOf(parseMarkdown(source + "\n\nRead the next paragraph."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const translate = () =>
    store.translate(
      serviceIdentity(settings),
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  const result = await translate()
  assert.equal(result.get(input.units[0].id), translation, "An untranslated English paragraph was accepted without a language review.")
  assert.equal(result.get(input.units[1].id), "已翻译的正常邻项。")
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(fixture.seen[1].items, [source], "The review resubmitted a successful neighbour.")
  const originalMessages = fixture.seen[0].body.messages
  const reviewedMessages = fixture.seen[1].body.messages
  assert.equal(reviewedMessages[0].content, originalMessages[0].content, "The review changed the user's system template.")
  const hint = modelFeedback(fixture.seen[1].body)
  assert.ok(
    hint.includes(settings.targetLanguage) && !/Item \d|Current request:|translation-language-/.test(hint),
    "A single-item correction retained diagnostic labels or lost its target language."
  )
  assert.ok(!published.includes(source), "A provisional untranslated result reached the display or cache.")
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, 2, "The reviewed result was not cached.")
})

test("a language review allows unchanged results but rejects other-language rewrites within the attempt limit", async (t) => {
  for (const maximum of [1, 2, 3]) {
    for (const rephrase of [false, true]) {
      const fixture = await chatFixture(t, (_body, items) => (rephrase ? items[0].replace("Prefer", "Use") : items[0]))
      const settings = { ...fixture.settings, maxTranslationAttempts: maximum, adaptiveBatching: false }
      const input = inputOf(parseMarkdown(source))
      const events: TranslationEvent[] = []
      const entries: string[] = []
      const log = new TranslationLog((entry) => entries.push(entry))
      const translate = () =>
        requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, undefined, {
          details: false,
          emit: (event) => {
            events.push(event)
            log.record(event, logContext)
          }
        })
      if (rephrase) await assert.rejects(translate(), /translation-language-mismatch/)
      else assert.equal((await translate())[0].text, source)
      assert.equal(fixture.seen.length, rephrase ? maximum : maximum === 1 ? 1 : 2, "Language recovery exceeded its attempt limit or repeatedly retried unchanged text.")
      const finish = events.find((event) => event.kind === "finish")!
      assert.ok(finish.kind === "finish" && finish.status === (rephrase ? "failed" : "complete") && finish.failures.length === (rephrase ? 1 : 0))
      if (maximum > 1) {
        const feedback = modelFeedback(fixture.seen[1].body)
        assert.ok(feedback.includes(settings.targetLanguage) && !feedback.includes("score="), "The model review lost the requested target or received detector scores.")
        assert.ok(entries.some((entry) => entry.includes("[WARNING]")))
        assert.equal(
          entries.some((entry) => entry.includes("[ERROR]")),
          rephrase
        )
      }
    }
  }
})

test("the logged artifact handoff rewrites recover on the last attempt without publishing English or changing protected values", async (t) => {
  const original =
    "- Artifact/meta handoff: pass prior outputs via `__ARTIFACT_ID_PARAM__`; pass meta grouping as `__META_CONTEXT_KEY__=<meta_id>` and replacements as `__SUPERSEDES_CONTEXT_KEY__=<artifact_id>` in delegated context."
  const outputs = [
    "Artifact/meta handoff: Pass previous outputs through <CTP0>; pass meta data as <CTP1>, and any replacements as <CTP2> in the delegated context.",
    "Artifact/meta handoff: Pass previous outputs through <CTP0>; pass meta grouping as <CTP1> and replacements as <CTP2> in the delegated context.",
    "产物与元数据交接：通过 <CTP0> 传递先前输出；在委派上下文中，以 <CTP1> 传递元数据分组，以 <CTP2> 传递替换关系。"
  ]
  const fixture = await chatFixture(t, (_body, _items, call) => outputs[call - 1])
  const input = inputOf(parseMarkdown(original))
  const published: string[] = []
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.text))
  const expected =
    "- 产物与元数据交接：通过 `__ARTIFACT_ID_PARAM__` 传递先前输出；在委派上下文中，以 `__META_CONTEXT_KEY__=<meta_id>` 传递元数据分组，以 `__SUPERSEDES_CONTEXT_KEY__=<artifact_id>` 传递替换关系。"
  assert.equal(result[0].text, expected)
  assert.deepEqual(published, [expected], "An English rewrite escaped into the reading result before recovery.")
  assert.equal(fixture.seen.length, 3)
  for (const retry of fixture.seen.slice(1)) {
    assert.deepEqual(retry.body.messages.slice(0, fixture.seen[0].body.messages.length), fixture.seen[0].body.messages, "Recovery changed the original template messages.")
    const hint = modelFeedback(retry.body)
    assert.ok(hint.includes(fixture.settings.targetLanguage) && !/Item \d|Current request:|translation-language-|score/.test(hint))
  }
})

test("exhausted other-language rewrites remain uncached while successful neighbours survive a manual retry", async (t) => {
  let repaired = false
  const fixture = await chatFixture(t, (_body, items) =>
    items.map((item) => (item === "Read the next paragraph." ? "阅读下一段。" : repaired ? translation : item.replace("Prefer", "Use"))).join("\n%%\n")
  )
  const input = inputOf(parseMarkdown(source + "\n\nRead the next paragraph."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const translate = () =>
    store.translate(
      serviceIdentity(fixture.settings),
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed),
      new AbortController().signal,
      false,
      (item) => published.push(item.text)
    )
  await assert.rejects(translate(), /translation-language-mismatch/)
  assert.deepEqual(published, ["阅读下一段。"])
  assert.equal(fixture.seen.length, fixture.settings.maxTranslationAttempts)
  repaired = true
  const result = await translate()
  assert.equal(result.get(input.units[0].id), translation)
  assert.equal(result.get(input.units[1].id), "阅读下一段。")
  assert.deepEqual(fixture.seen.at(-1)!.items, [source], "Manual retry resubmitted a successful neighbour or reused the rejected rewrite.")
  const calls = fixture.seen.length
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, calls, "The repaired result was not cached.")
})

test("post-translation evidence excludes short, mixed and protected content and unsupported targets", async (t) => {
  assert.equal(unlikelyTargetLanguage(source, "zh-CN")?.language, "en")
  const quality =
    '<CTP0> applies only to GPT Image 2.5 and defaults to <CTP1>; omit it unless the user explicitly requests a different tier. Pass <CTP2> or <CTP3> for a cheaper / draft / quick result. NEVER pass <CTP4> or <CTP5> unless the user explicitly requests that tier (or an equivalent phrase such as "highest quality" / "max quality"); terms like "beautiful", "detailed", "professional", "high resolution", or "4K" describe the prompt or <CTP6>, not <CTP7>. Credits per image at 1K/2K/4K: <CTP8> 4/4/4, <CTP9> 4/8/12, <CTP10> 12/28/32, <CTP11> 24/52/60, <CTP12> 56/112/128; source images do not affect the price. Nano Banana ignores <CTP13>.'
  assert.equal(unlikelyTargetLanguage(quality, "zh-CN")?.language, "en", "The logged English rewrite escaped review because its technical prose had a low uncalibrated match score.")
  for (const [text, target] of [
    ["Acme SDK", "zh-CN"],
    [source + " 中文说明", "zh-CN"],
    ["<CTP0>", "zh-CN"],
    [source, "en-US"],
    [source, "unsupported"],
    [source.repeat(30), "zh-CN"]
  ])
    assert.equal(unlikelyTargetLanguage(text, target), undefined)
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const input = inputOf(parseMarkdown("Short label.\n\n这是完整的中文说明，请按原文内容保留。\n\n`" + source + "`"))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    result.map((item) => item.text),
    input.units.map((unit) => unit.text)
  )
  assert.equal(fixture.seen.length, 1, "Short labels or protected English triggered a language review.")
})

test("an over-budget language hint accepts only unchanged results and never releases an other-language rewrite", async (t) => {
  for (const rephrase of [false, true]) {
    const fixture = await chatFixture(t, (_body, items) => (rephrase ? items[0].replace("Prefer", "Use") : items[0]))
    const settings = { ...fixture.settings, systemPrompt: "", userPrompt: "${content}", maxRequestCharacters: 256, maxContextCharacters: 0 }
    const input = inputOf(parseMarkdown(source))
    const published: string[] = []
    const translate = () => requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.text))
    if (rephrase) {
      await assert.rejects(translate(), /service-request-too-large/)
      assert.deepEqual(published, [])
    } else assert.equal((await translate())[0].text, source)
    assert.equal(fixture.seen.length, 1)
  }
})

test("language reviews still reject broken markers and recover within the original total attempt limit", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 2 ? dropLastProtection(items[0]) : items[0]))
  const input = inputOf(parseMarkdown(source + " Keep `sourceId` safe."))
  const published: string[] = []
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, (item) => published.push(item.text))
  assert.equal(result[0].text, input.units[0].text)
  assert.deepEqual(published, [input.units[0].text])
  assert.equal(fixture.seen.length, 3)
  assert.ok(modelFeedback(fixture.seen[2].body).includes("exactly once"))
})

test("cancelling a language review publishes no provisional result", async (t) => {
  const controller = new AbortController()
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 2) controller.abort("user-cancelled")
    return items[0]
  })
  const input = inputOf(parseMarkdown(source))
  const published: string[] = []
  await assert.rejects(requestTranslation(fixture.service, fixture.settings, input, controller.signal, fixture.gate, (item) => published.push(item.text)))
  assert.deepEqual(published, [])
  assert.equal(fixture.seen.length, 2)
})
