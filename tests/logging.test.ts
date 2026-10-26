import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { validateTranslations } from "../src/translation/results.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { isTargetLanguage } from "../src/documents/languageDetection.ts"
import { TranslationLog } from "../src/host/logging.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { requestTranslation, inputOf, modelContext, modelInput, chatFixture, logContext } from "./support/fixtures.ts"

test("task diagnostics distinguish changed, unchanged and language-skipped results and report actual request measurement", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Original", "译文")).join("\n%%\n"))
  const input = inputOf(parseMarkdown("Original paragraph.\n\nAcmeSDK keeps its name.\n\n这是一段已经写好的完整中文说明，请保留原文内容，不需要再次翻译。"))
  const events: TranslationEvent[] = []
  await requestTranslation(fixture.service, { ...fixture.settings, skipSameLanguage: true }, input, new AbortController().signal, fixture.gate, undefined, {
    details: true,
    emit: (event) => events.push(event)
  })
  const finish = events.find((event) => event.kind === "finish")!
  assert.ok(finish.kind === "finish" && finish.completed === 3 && finish.changed === 1 && finish.unchanged === 1 && finish.skipped === 1)
  const request = events.find((event) => event.kind === "request")!
  const actualContext = modelContext(fixture.seen[0].body)
  assert.ok(request.kind === "request" && request.ids.length === 2 && request.contextCharacters === actualContext.length && request.batchReason)
  assert.ok(actualContext.includes("这是一段已经写好的完整中文说明"), "A skipped neighbour was removed from reference context.")
  assert.equal(
    request.inputCharacters,
    fixture.seen[0].body.messages.reduce((sum, message) => sum + message.content.length, 0)
  )
})

test("repeated diagnostic leakage exhausts attempts without publishing or caching a result", async (t) => {
  let damaged = true
  const fixture = await chatFixture(t, (_body, items, call) => (damaged ? (call === 1 ? "" : "Item 1: translation-item-invalid 诊断被错误翻译。") : items[0].replace("Repair", "修复")))
  const input = inputOf(parseMarkdown("Repair the current rule."))
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
  await assert.rejects(translate(), /translation-feedback-leaked/)
  assert.equal(fixture.seen.length, fixture.settings.maxTranslationAttempts)
  assert.deepEqual(published, [], "Rejected diagnostics appeared as a completed translation.")
  damaged = false
  assert.equal((await translate()).get(input.units[0].id), "修复 the current rule.")
  assert.equal(fixture.seen.length, fixture.settings.maxTranslationAttempts + 1, "A rejected diagnostic was cached.")
})

test("offline language detection skips only sufficiently clear target-language prose and respects protected syntax", () => {
  const unit = (text: string) => ({ id: "language", text, start: 0, end: text.length, format: "markdown" as const })
  const label = "这是已经写好的中文说明，不需要再次请求翻译服务。"
  assert.equal(isTargetLanguage(unit("[" + label + "](" + label + ")"), "zh-CN"), true, "Removing a protected destination also removed the identical natural-language link label.")
  const chinese = "这是已经写好的中文说明，不需要再次请求翻译服务。"
  assert.equal(isTargetLanguage(unit(chinese), "zh-CN"), true)
  assert.equal(isTargetLanguage(unit(chinese), "zh-TW"), true)
  assert.equal(isTargetLanguage(unit("Read the original document."), "en-US"), true)
  assert.equal(isTargetLanguage(unit("Bonjour, ceci est un texte écrit en français pour tester la détection."), "fr-FR"), true)
  assert.equal(isTargetLanguage(unit("これは日本語で書かれた文章です。変更せずにそのまま保持してください。"), "ja"), true)
  for (const text of [
    "你好",
    "API",
    "sourceIdentifierLongerThanTwentyLetters",
    "这是中文。 Read the original document.",
    "这是已经写好的中文说明。これは日本語の説明です。",
    chinese.repeat(200)
  ])
    assert.equal(isTargetLanguage(unit(text), "zh-CN"), false, text.slice(0, 40))
  assert.equal(isTargetLanguage(unit("This paragraph is already written in English. Bonjour, ceci est un texte écrit en français pour tester la détection."), "en"), false)
  assert.equal(isTargetLanguage(unit(chinese), "unsupported"), false)
  assert.equal(
    isTargetLanguage(unit(chinese + " `Read the original document.` [指南](https://example.com/English)"), "zh-CN"),
    false,
    "A short trailing phrase cannot be classified independently."
  )
  assert.equal(
    isTargetLanguage(unit(chinese + " `Read the original document.` [阅读完整使用指南](https://example.com/English)"), "zh-CN"),
    true,
    "Clear simplified Chinese in the link label should not depend on model vocabulary coverage."
  )
  assert.equal(isTargetLanguage(unit(chinese + " `Read the original document.` [阅读这份使用指南，了解完整的功能说明。](https://example.com/English)"), "zh-CN"), true)
  const literal = "`" + chinese + " ${sourceIdentifier}\\n`"
  assert.equal(isTargetLanguage({ ...unit(literal), format: "text", kind: "string", protected: [{ start: literal.indexOf("${"), end: literal.length }] }, "zh-CN"), true)
})

test("log severity filters details without losing warnings or errors, and redacts literal and JSON-escaped credentials", () => {
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  const secret = 'key"with\\escapes'
  log.write("info", "Source " + secret + "\n" + JSON.stringify({ prompt: "Prompt " + secret, translation: "Result " + secret }), [secret])
  assert.equal(entries.length, 1)
  assert.ok(entries[0].includes("Source") && entries[0].includes("prompt") && entries[0].includes("translation") && entries[0].includes("[REDACTED]"))
  assert.ok(!entries[0].includes(secret) && !entries[0].includes(JSON.stringify(secret).slice(1, -1)))
  entries.length = 0
  log.configure("warning")
  log.write("info", "Detailed source")
  log.write("warning", "Retry u1, next batch size 1")
  log.write("error", "Final failure u1")
  assert.equal(entries.length, 2)
  assert.ok(entries.every((entry) => !entry.includes("Detailed source")))
  entries.length = 0
  log.configure("error")
  log.write("info", "Request")
  log.write("warning", "Retry")
  log.write("error", "Final failure")
  assert.equal(entries.length, 1)
  assert.throws(() => log.configure("debug"), /log-level-invalid/)
  assert.throws(() => log.configure("info", "true"), /log-details-invalid/)
})

test("YAML diagnostics retain model responses and raw references without repeating source and translation pairs", async (t) => {
  let mode = "translate"
  const fixture = await chatFixture(t, (body) => (mode === "fail" ? "" : mode === "unchanged" ? modelInput(body) : modelInput(body).replace("Read", "阅读")))
  const entries: string[] = []
  const events: TranslationEvent[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  for (const scalar of [">-\n  Read first.\n  Keep second.", "|-\n  Read first.\n  Keep second.", "|2-\n    Read first.\n    Keep second.", '"Read first.  Keep >- and | literally."']) {
    const parsed = parseMarkdown("---\n'quoted key': " + scalar + "\n---")
    const value = inputOf(parsed).units[1]
    const input = { units: [value] }
    const settings = { ...fixture.settings, maxTranslationAttempts: 1 }
    for (mode of ["translate", "unchanged", "fail"]) {
      entries.length = 0
      events.length = 0
      const pending = requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate, undefined, {
        details: true,
        emit: (event) => {
          events.push(event)
          log.record(event, logContext)
        }
      })
      if (mode === "fail") await assert.rejects(pending, /translation-item-invalid/)
      else {
        const result = validateTranslations(input, await pending).get(value.id)!
        assert.equal(result, mode === "unchanged" ? value.text : JSON.stringify(value.content!.replace(/[\t ]*(?:\r\n|[\r\n])[\t \r\n]*/gu, " ").replace("Read", "阅读")))
      }
      assert.ok(!/[\r\n]/u.test(modelInput(fixture.seen.at(-1)!.body)))
      assert.equal(prepareTranslation(value, emptyPreserveTerms, 32).restore(modelInput(fixture.seen.at(-1)!.body)), value.text)
      assert.ok(modelContext(fixture.seen.at(-1)!.body).includes(scalar), "Reference lost the original YAML syntax.")
      const request = events.find((event) => event.kind === "request")!
      assert.equal(request.kind, "request")
      if (request.kind !== "request") throw Error("Missing request event")
      const text = entries.join("\n")
      const response = JSON.parse(request.modelResponse!).choices[0].message.content
      assert.ok(text.includes("--- assistant（finish_reason=stop） ---\n" + (response || "（空文本）")), "Detailed diagnostics omitted the model response.")
      assert.ok(!text.includes("--- 原文与译文 ---"), "Detailed diagnostics repeated source and translation pairs.")
      assert.equal(request.completed, mode === "fail" ? 0 : 1)
      if (mode === "fail") {
        assert.equal(request.failures[0].source, value.content)
        const finish = events.find((event) => event.kind === "finish")!
        assert.ok(finish.kind === "finish" && finish.failures[0].source === value.content)
        assert.equal(request.failures[0].start, value.start)
      }
    }
  }
})

test("log redaction precedes references and failure excerpts, while malformed model responses stay inspectable", () => {
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  const secret = 'credential"\\'.repeat(30)
  const context = { ...logContext, apiKey: secret }
  const failure = {
    id: "one",
    start: 2,
    source: "prefix " + secret + " tail",
    attempts: 3,
    code: "translation-marker-mismatch",
    difference: { reason: "Invalid marker", expected: secret + " expected", actual: secret + " actual" }
  }
  const request: TranslationEvent = {
    sourceCharacters: 0,
    contextCharacters: 0,
    inputCharacters: 0,
    referenceKinds: [],
    batchReason: "fixture",
    kind: "request",
    taskId: "T1",
    requestId: "T1/R1",
    ids: ["one"],
    attempt: 3,
    elapsedMs: 1,
    httpRequests: 1,
    cancelled: false,
    detailsIncluded: true,
    completed: 0,
    failures: [failure],
    modelRequest: { model: "fixture", stream: false, messages: [{ role: "system", content: "System " + secret }] },
    modelResponse: "<malformed>" + secret
  }
  log.record(request, context)
  log.record(
    {
      changed: 0,
      unchanged: 0,
      kind: "finish",
      taskId: "T1",
      status: "failed",
      total: 1,
      completed: 0,
      skipped: 0,
      httpRequests: 3,
      elapsedMs: 3,
      failures: [failure]
    },
    context
  )
  const text = entries.join("\n")
  assert.ok(!text.includes("--- 原文与译文 ---"), "A failed item was repeated as a source/translation pair.")
  assert.ok(text.includes("<malformed>[REDACTED]") && text.includes("sample.md:1:3") && text.includes("[REDACTED] expected"))
  assert.ok(!text.includes(secret.slice(0, 120)) && !text.includes(JSON.stringify(secret).slice(1, 121)), "An excerpt leaked the beginning of a credential before redaction.")
  const otherSecret = "different-credential"
  log.record({ ...request, modelRequest: { model: "fixture", stream: false, messages: [{ role: "system", content: "System " + otherSecret }] } }, { ...context, apiKey: otherSecret })
  assert.equal((entries.join("\n").match(/--- system S\d+ ---/g) ?? []).length, 1, "Deduplication used raw secrets instead of the redacted visible prompt.")
  entries.length = 0
  log.record({ ...request, ids: ["one", "two"], completed: 1 }, context)
  assert.ok(!entries[0].includes("--- 原文与译文 ---"), "A partial failure repeated source and translation pairs.")
  assert.ok(entries[0].includes("Invalid marker") && entries[0].includes("sample.md:1:3"), "Suppressing failed pairs removed the failure diagnostics.")
})
