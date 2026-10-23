import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { TranslationEvent } from "../src/model/events.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, listBatch, requestTranslation, modelFeedback } from "./support/fixtures.ts"

test("Sources recovery appends correction instructions after the unchanged template prefix and caches the accepted heading", async (t) => {
  for (const custom of [false, true]) {
    const fixture = await chatFixture(t, (_body, _items, call) => {
      if (call === 1) return "用于理解的上下文：\n<context>\n## 编写搜索结果文档\n</context>"
      return "来源"
    })
    const settings = { ...fixture.settings, ...(custom ? { systemPrompt: "", userPrompt: "${content}" } : {}) }
    const unit = inputOf(parseMarkdown("## Sources")).units[0]
    const input = prepareInput(settings, { units: [{ ...unit, reference: [{ kind: "Section", text: "# Writing Search Results Document\n\nCompile an internal reference." }] }] })
    const store = new TranslationStore()
    const run = () =>
      store.translate("appended-correction", input, (input, signal, completed) => fixture.service.request(settings, input, signal, fixture.gate, completed), new AbortController().signal)
    const result = await run()
    assert.equal(result.get(unit.id), "## 来源")
    assert.equal(fixture.seen.length, 2)
    const prefix = fixture.seen[0].body.messages
    assert.deepEqual(fixture.seen[1].body.messages.slice(0, prefix.length), prefix, "Retry notes disrupted the existing template message prefix.")
    assert.deepEqual(fixture.seen[1].body.messages.at(-2), { role: "assistant", content: "用于理解的上下文：\n<context>\n## 编写搜索结果文档\n</context>" })
    const correction = fixture.seen[1].body.messages.at(-1)!
    assert.equal(correction.role, "user")
    assert.ok(correction.content.endsWith("Translate the following text into Simplified Chinese:\n\nSources"), "Retry omitted the target language or current source heading.")
    assert.ok(!correction.content.includes("Writing Search Results"), "Retry source included reference content.")
    assert.deepEqual(await run(), result)
    assert.equal(fixture.seen.length, 2, "The correct heading did not enter the shared cache.")
    store.clear()
  }
})

test("logged summary and list outputs recover a single style-boundary line break before validation and cache on the first request", async (t) => {
  const summary =
    "**Summary MUST be ≤ 800 characters.** Must directly answer the task with specific data. Include the search document path (e.g., /memory/search/{topic}.md) so the parent agent can retrieve the full results. Do NOT list every source URL — keep the summary readable. The summary should be self-contained: a reader should understand the answer without opening the document."
  const cases = [
    {
      source: summary,
      output:
        "** 摘要的长度必须≤800个字符。  \n** 必须使用具体数据来直接回答任务要求。请包含搜索文档的路径（例如，/memory/search/{topic}.md），以便父代理可以获取完整结果。不要列出所有的源URL——保持摘要的易读性。摘要应该是自包含的：读者无需打开文档就能理解答案。"
    },
    {
      source: summary,
      output:
        "** 摘要必须长度不超过 800 个字符。  \n** 必须使用具体数据直接回答任务要求。需包含搜索文档的路径（例如，/memory/search/{topic}.md），以便父代理可以获取完整结果。不要列出所有的源 URL——保持摘要易于阅读。摘要应自成一体：读者无需打开文档即可理解答案。"
    },
    {
      source: summary,
      output:
        "** 摘要必须不超过 800 个字符。  \n** 必须用具体数据直接回答任务要求。需包含搜索文档的路径（例如，/memory/search/{topic}.md），以便父代理可以获取完整结果。不要列出所有源 URL——保持摘要易于阅读。摘要应自成一体：读者无需打开文档即可理解答案。"
    },
    {
      source: "5. **Write a search results document** to `/memory/search/{topic}.md` summarizing findings (see below)",
      output: "** 编写搜索结果文档  \n** 将结果总结到 `/memory/search/{topic}.md` 中（详见下文）"
    }
  ]
  for (const { source, output } of cases) {
    for (const newline of ["\n", "\r\n"]) {
      const fixture = await chatFixture(t, () => output.replaceAll("\n", newline))
      const input = prepareInput(fixture.settings, inputOf(parseMarkdown(source)))
      const unit = input.units[0]
      const store = new TranslationStore()
      const run = () =>
        store.translate(
          "logged-style",
          input,
          (input, signal, completed) => fixture.service.request(fixture.settings, input, signal, fixture.gate, completed),
          new AbortController().signal
        )
      const result = await run()
      const translation = result.get(unit.id)!
      assert.ok(validateTranslation(unit, translation) === undefined)
      assert.ok(translation.includes("**摘要") || translation.includes("5. **编写"))
      assert.ok(!translation.includes("\n"))
      assert.deepEqual(await run(), result)
      assert.equal(fixture.seen.length, 1, "A recoverable boundary consumed retries or failed to cache.")
      store.clear()
    }
  }
})

test("style-boundary recovery preserves prose whitespace and rejects paragraph breaks or invalid markers", () => {
  const unit = inputOf(parseMarkdown("**Read *the original* document** and keep `sourceId`.")).units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  const output = "**阅读  仔细 *原始* 文档** 并保留 `sourceId`."
  const wrapped = output.replace("**阅读", "** \r\n 阅读").replace("文档**", "文档 \r\n **")
  const restored = prepared.restore(wrapped)
  assert.ok(validateTranslation(unit, restored) === undefined)
  assert.ok(restored.includes("阅读  仔细 *原始* 文档"))
  assert.throws(() => prepared.restore(output.replace("文档**", "文档\n\n**")), /structure-invalid/)
  assert.ok(validateTranslation(unit, prepared.restore(wrapped.replace("`sourceId`", ""))) === undefined)
  assert.throws(() => prepared.restore(wrapped + "<CTP999>"), /marker-mismatch/)
})

test("a source-owned inline code marker may echo its exact backtick wrapper without changing code contents", async (t) => {
  const source = "- in the `Working language: the selected conversation language` line at the top of your input for all outputs, content generation, and summaries."
  const output = "您必须在使用输入时，始终遵循位于顶部 `<CTP0>` 行中指定的工作语言，用于所有输出、内容生成以及摘要的生成。"
  const fixture = await chatFixture(t, () => output)
  const input = inputOf(parseMarkdown(source))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.ok(result[0].text.includes("`Working language: the selected conversation language`") && !result[0].text.includes("``"))
  assert.equal(fixture.seen.length, 1)
  const prepared = prepareTranslation(input.units[0], emptyPreserveTerms, 32)
  assert.throws(() => prepared.restore(output + " <CTP0>"), /marker-mismatch/)
  assert.equal(validateTranslation(input.units[0], prepared.restore(output + " `extra`")) === undefined, true)
  const path = inputOf(parseMarkdown("Read /memory/search/result.md.")).units[0]
  assert.equal(
    validateTranslation(path, prepareTranslation(path, emptyPreserveTerms, 32).restore("阅读 `/memory/search/result.md`。")) === undefined,
    true,
    "A new inline-code wrapper around a plain path was rejected."
  )
})

test("single-item model failures do not collapse learned capacity for later healthy batches", async (t) => {
  let broken = true
  const fixture = await chatFixture(t, (_body, items) => (broken ? "" : items.map((item) => item.replace("Original", "译文")).join("\n%%\n")))
  const settings = { ...fixture.settings, maxConcurrentRequests: 1 }
  await assert.rejects(requestTranslation(fixture.service, settings, listBatch(1), new AbortController().signal, fixture.gate), /translation-item-invalid/)
  assert.equal(fixture.seen.length, settings.maxTranslationAttempts)
  broken = false
  const before = fixture.seen.length
  const result = await requestTranslation(fixture.service, settings, listBatch(4), new AbortController().signal, fixture.gate)
  assert.equal(result.length, 4)
  assert.equal(fixture.seen.length - before, 1, "An unrelated single-item failure fragmented a healthy four-item request.")
})

test("logged chapter translation accepts added backticks on the first request and shares cached preview output", async (t) => {
  const source =
    "Save chapters separately in order (`ch01.md`), preserving supplied `belong`; finish all chapters. Add no unsolicited TOC. Concatenated HTML: first chapter opens document/head/body, last closes body/html, middle chapters are fragments."
  const output = "按顺序保存各章（`ch01.md`），保留 `belong`；完成所有章节。不添加未请求的目录。合并 HTML 时首章打开 `document/head/body`，末章关闭 `body/html`，中间章节使用片段。"
  const fixture = await chatFixture(t, () => output)
  const input = inputOf(parseMarkdown(source))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate("logged-chapters", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  const result = await run()
  assert.equal(result.get(input.units[0].id), output)
  assert.equal(translatedMarkdown(parseMarkdown(source), result), output)
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 1)
})

test("logged HTML expansion receives a concrete correction and caches only the repaired chapter item", async (t) => {
  const source =
    "Save chapters separately in order (`ch01.md`), preserving supplied `belong`; finish all chapters. Add no unsolicited TOC. Concatenated HTML: first chapter opens document/head/body, last closes body/html, middle chapters are fragments."
  const broken =
    "按顺序分别保存各章节（例如 `ch01.md`），保持提供的`belong`信息不变；完成所有章节的写作。不要添加未经请求的目录结构。合并后的 HTML格式中：第一章在文档的<head>和<body>部分开始，最后一章在<body>和<html>部分结束，中间章节则作为独立片段存在。"
  const fixed = "按顺序分别保存各章节（例如 `ch01.md`），保留 `belong`，完成所有章节；不添加未请求的目录。合并 HTML 时，首章打开 document/head/body，末章关闭 body/html，中间章节使用片段。"
  const fixture = await chatFixture(t, (body, _items, call) => {
    if (call === 1) return broken + "\n%%\n阅读相邻内容。"
    const correction = modelFeedback(body)
    return /Remove HTML/.test(correction) && /plain text without angle brackets/.test(correction) ? fixed : broken
  })
  const input = inputOf(parseMarkdown(source + "\n\nRead the neighbour."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const run = () =>
    store.translate(
      "logged-html",
      input,
      (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, undefined, { details: false, emit: (event) => events.push(event) }),
      new AbortController().signal
    )
  const result = await run()
  assert.equal(result.get(input.units[0].id), fixed)
  assert.equal(result.get(input.units[1].id), "阅读相邻内容。")
  assert.equal(fixture.seen[1].items.length, 1)
  const warning = events.find((event) => event.kind === "request" && event.failures.length)
  assert.ok(warning?.kind === "request")
  assert.match(warning.failures[0].difference.reason, /HTML/)
  assert.equal(warning.failures[0].difference.actual, "<head>")
  assert.equal(translatedMarkdown(parseMarkdown(source + "\n\nRead the neighbour."), result), fixed + "\n\n阅读相邻内容。")
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})
