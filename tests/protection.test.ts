import { ModelRetry } from "../src/model/diagnostics.ts"
import { emptyPreserveTerms, prepareTranslation, parsePreserveTerms } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { validateTranslation, translationIsUnchanged } from "../src/documents/validation.ts"
import { translatedMarkdown, progressiveMarkdown, previewLoadingMarker } from "../src/documents/presentation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { protectedFragments } from "../src/documents/protection.ts"
import { TranslationService } from "../src/translation/engine.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames } from "../src/translation/providers/prompts.ts"
import { limits, requestTranslation, batch, modelInput, chatFixture } from "./support/fixtures.ts"

test("short links reach the model in native form and retain exact targets", () => {
  for (const source of [
    "Read [Title](URL).",
    'Read [Title](URL "Caption").',
    'Read [Title](<https://example.com/a b> "Caption").',
    'Read ![Title](picture.png "Caption").',
    "Read [Title][guide].",
    "Read ![Title][guide].",
    "Read <https://example.com>.",
    "Read <a@example.com>."
  ])
    for (const format of ["markdown", "text"] as const) {
      const unit = { id: "link", text: source, start: 0, end: source.length, format }
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.equal(prepared.text, source)
      assert.equal(prepared.hasMarkers, false)
      const restored = prepared.restore(source.replace("Read", "阅读").replace("Title", "标题").replace("Caption", "说明"))
      assert.equal(validateTranslation(unit, restored), undefined, restored)
      assert.throws(() => prepared.restore(restored.replace(/URL|picture.png|guide|https:\/\/example.com(?:\/a b)?|a@example.com/u, "changed")), /structure-invalid/u)
    }
})

test("native link punctuation remains subject to structure and target validation", () => {
  const source = "Read [Title](URL) and ![Image](picture.png)."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, source)
  for (const output of [
    "阅读 [标题(URL) 和 ![图片](picture.png)。",
    "阅读 [标题](URL) 和 [图片](picture.png)。",
    "阅读 [标题](picture.png) 和 ![图片](URL)。",
    "阅读 标题URL 和 ![图片](picture.png)。"
  ])
    assert.ok(validateTranslation(unit, output) instanceof ModelRetry, output)
  const nested = parseMarkdown("Read [**Title**](URL) and **[Guide](OTHER)**.").groups[0].units[0]
  const formatted = prepareTranslation(nested, emptyPreserveTerms, 32)
  const restored = formatted.restore(formatted.text.replace("Read", "阅读").replace("Title", "标题").replace("Guide", "指南"))
  assert.equal(validateTranslation(nested, restored), undefined)
  assert.equal(validateTranslation(nested, restored.replace("[**标题**](URL)", "**[标题](URL)**")), undefined)
})

test("empty explicit link destinations keep their labels translatable without placeholders", () => {
  for (const source of ["Read [Title]().", "Read ![Title]()."]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, source)
    const restored = prepared.restore(source.replace("Read", "阅读").replace("Title", "标题"))
    assert.equal(restored, source.replace("Read", "阅读").replace("Title", "标题"))
    assert.equal(validateTranslation(unit, restored), undefined)
  }
})

test("label-derived reference targets stay intact rather than translating their lookup keys", () => {
  for (const reference of ["[Title]", "[Title][]", "![Title]", "![Title][]"]) {
    const source = "Read " + reference + ".\n\n[title]: https://example.com/guide"
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, unit.text)
    assert.equal(prepared.restore("阅读 " + reference + "。"), "阅读 " + reference + "。")
    assert.equal(validateTranslation(unit, "阅读 " + reference + "。"), undefined)
    assert.ok(validateTranslation(unit, unit.text.replace("Title", "标题")) instanceof ModelRetry)
    assert.throws(() => prepared.restore(unit.text.replace("Title", "标题")), /structure-invalid/u)
    assert.throws(() => translatedMarkdown(parseMarkdown(source), new Map([[unit.id, unit.text.replace("Title", "标题")]])), /structure-invalid/u)
  }
})

test("undefined bracket prose translates through HTTP, assembles and reuses its cached result", async (t) => {
  const source = "The garden catalog groups flowers by color [amber·violet·ivory] and lists their flowering season beside each name."
  const output = "花园目录按颜色 [琥珀色·紫罗兰色·象牙色] 将花卉分组，并在每个名称旁标明花期。"
  const fixture = await chatFixture(t, () => output)
  const parsed = parseMarkdown(source)
  const input = { units: parsed.groups.flatMap((group) => group.units) }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate("bracket-prose", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  const result = await translate()
  assert.equal(result.get(input.units[0].id), output)
  assert.equal(translatedMarkdown(parsed, result), output)
  assert.deepEqual([...(await translate())], [...result])
  assert.equal(fixture.seen.length, 1, "Ordinary bracket prose caused retries or was not cached.")
})

test("undefined shortcut candidates remain prose while nested syntax and actual links stay protected", () => {
  for (const format of ["markdown", "text"] as const) {
    for (const source of ["Read [Title].", "Read ![Title].", "Read [**Title**].", "Read [Title](URL) and [words]."]) {
      const unit = { id: "brackets", text: source, start: 0, end: source.length, format }
      const output = source.replaceAll("Read", "阅读").replaceAll("Title", "标题").replaceAll("words", "文字")
      assert.equal(prepareTranslation(unit, emptyPreserveTerms, 32).restore(output), output)
      assert.equal(validateTranslation(unit, output), undefined)
      if (source.includes("URL")) assert.ok(validateTranslation(unit, output.replace("URL", "OTHER")) instanceof ModelRetry)
    }
    const text = "Read [~~removed~~ and [Title](URL)]."
    const unit = { id: "nested", text, start: 0, end: text.length, format }
    const output = "阅读 [~~已删除~~和[标题](URL)]。"
    assert.equal(validateTranslation(unit, output), undefined)
    assert.ok(validateTranslation(unit, output.replace("URL", "OTHER")) instanceof ModelRetry)
    if (format === "markdown") assert.ok(validateTranslation(unit, output.replaceAll("~~", "")) instanceof ModelRetry)
  }
})

test("adding a definition invalidates cached bracket prose even without model context", async (t) => {
  const fixture = await chatFixture(t, (_body, _items, call) => (call === 1 ? "阅读 [标题]。" : "阅读 [Title]。"))
  const store = new TranslationStore()
  t.after(() => store.clear())
  for (const definition of ["", "\n\n[title]: https://example.com"]) {
    const parsed = parseMarkdown("Read [Title]." + definition)
    const input = { units: parsed.groups.flatMap((group) => group.units).map((unit) => ({ ...unit, reference: [] })) }
    const result = await store.translate(
      "definition-change",
      input,
      (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate),
      new AbortController().signal
    )
    assert.equal(result.get(input.units[0].id), definition ? "阅读 [Title]。" : "阅读 [标题]。")
    assert.equal(translatedMarkdown(parsed, result), (definition ? "阅读 [Title]。" : "阅读 [标题]。") + definition)
  }
  assert.equal(fixture.seen.length, 2)
})

test("synthetic catalog prose retries only damaged native link structure before caching", async (t) => {
  const text = "The sample catalog lists travel guides and illustrated maps. Use `SampleReader` to browse the shelves, and open [Title](URL) for the description of a selected book."
  const expectedInput = text
  const output = "示例目录列出旅行指南与插图地图。使用 `SampleReader` 浏览书架，并打开[标题](URL)查看所选图书的说明。"
  const fixture = await chatFixture(t, (_body, items, call) => {
    assert.equal(items[0], expectedInput)
    return (call === 1 ? [output.replace("[标题]", "[标题"), "按书架编号排列图书。"] : [output]).join("\n%%\n")
  })
  const source = text + "\n\nArrange the books by shelf number."
  const parsed = parseMarkdown(source)
  const input = { units: parsed.groups.flatMap((group) => group.units) }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate("writing-link", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  const first = await translate()
  assert.equal(first.get(input.units[0].id), output.replace("<CTP0>", "`SampleReader`").replace("<CTP1>", "URL"))
  assert.equal(first.get(input.units[1].id), "按书架编号排列图书。")
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [2, 1]
  )
  assert.deepEqual([...(await translate())], [...first])
  assert.equal(fixture.seen.length, 2, "A completed result was not cached.")
  assert.ok(translatedMarkdown(parsed, first).includes("[标题](URL)"))
  assert.equal(parsed.source, source)
})

test("preserve regexes match complete bodies across wrappers without changing literal terms or mixed prose", () => {
  const rules = parsePreserveTerms(["a.b", { pattern: "HTTP(?:S|\\(S\\))?", flags: "i" }, { pattern: "项目[甲乙]" }])
  const unit = (text: string) => ({ id: "regex", text, start: 0, end: text.length, format: "text" as const })
  for (const text of ["a.b", "HTTP", "https", "HtTp(S)", "项目甲", "项目乙"]) {
    const prepared = prepareTranslation(unit(text), rules, 32)
    assert.equal(prepared.needsTranslation, false, text)
    assert.equal(prepared.restore(prepared.text), text)
  }
  for (const text of ["axb", "HTTP/i", "HTTP!", "Read HTTP.", "HTTP HTTPS", "项目丙"]) assert.equal(prepareTranslation(unit(text), rules, 32).needsTranslation, true, text)
  for (const parsed of [parseMarkdown("- **hTtPs**"), parseYaml('HTTP: "https"')]) {
    for (const item of parsed.groups.flatMap((group) => group.units)) {
      const prepared = prepareTranslation(item, rules, 32)
      assert.equal(prepared.needsTranslation, false, item.text)
      assert.equal(prepared.restore(prepared.text), item.text)
    }
  }
  assert.equal(prepareTranslation(unit("http"), parsePreserveTerms(["/HTTP/i"]), 32).needsTranslation, true, "A string was interpreted as a regex literal.")
  const alternatives = parsePreserveTerms([{ pattern: "foo|foobar" }])
  assert.equal(prepareTranslation(unit("foobar"), alternatives, 32).needsTranslation, false)
  const multiline = parsePreserveTerms([{ pattern: "^HTTP$", flags: "m" }])
  for (const text of ["Read\nHTTP", "HTTP\nRead"]) assert.equal(prepareTranslation(unit(text), multiline, 32).needsTranslation, true, "Multiline anchors escaped whole-body matching.")
  for (const [pattern, flags] of [
    ["first.second", "s"],
    ["first\\nsecond", "u"]
  ])
    assert.equal(prepareTranslation(unit("first\nsecond"), parsePreserveTerms([{ pattern, flags }]), 32).needsTranslation, false)
})

test("invalid preserve regexes fail at configuration parsing with their item location", () => {
  for (const entry of [
    null,
    123,
    [],
    {},
    { pattern: "" },
    { pattern: "[" },
    { pattern: "HTTP", flags: "ii" },
    { pattern: "HTTP", flags: "g" },
    { pattern: "HTTP", flags: "y" },
    { pattern: "HTTP", flags: "v" },
    { pattern: "HTTP", flags: 1 },
    { pattern: "HTTP", unknown: true }
  ])
    assert.throws(() => parsePreserveTerms(["Widget", entry]), /preserveTerms 第 2 项/)
  assert.throws(() => parsePreserveTerms("HTTP"), /preserveTerms/)
  assert.throws(() => parsePreserveTerms([" "]), /preserveTerms 第 1 项/)
})

test("whole-body regex skipping and internal long-URL markers remain independent through HTTP and cache", async (t) => {
  const url = "https://example.com/" + "very-long-path/".repeat(240) + "?a=1&b=two#section"
  const source = "HTTP\n\nRead " + url + " with API."
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read", "阅读").replace("API", "接口")).join("\n%%\n"))
  const settings = { ...fixture.settings, preserveTerms: parsePreserveTerms([{ pattern: "https?", flags: "i" }]), skipSameLanguage: false }
  const input = { units: parseMarkdown(source).groups.flatMap((group) => group.units) }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate("regex-url", input, (batch, signal, completed) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed), new AbortController().signal)
  const first = await translate()
  assert.deepEqual([...first.values()], ["HTTP", "阅读 " + url + " with 接口."])
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    ["Read <CTP0> with API."]
  )
  assert.equal(fixture.seen[0].items[0].length < url.length / 100, true, "The model still had to repeat the full URL.")
  assert.deepEqual([...(await translate()).values()], [...first.values()])
  assert.equal(fixture.seen.length, 1, "Completed regex or protected results bypassed the cache.")
})

test("Python docstring continuation indentation survives raw model output and unchanged results are cached", async (t) => {
  const sources = [
    ['"""Search matching Skills by task meaning.', '"""根据任务含义搜索匹配的技能。'],
    ["        Args:", "        Args:"],
    ["            query: A concise capability intent; preserve any explicitly named Skill id.", "            query：一个简洁的能力请求；请保留所有明确命名的 Skill id。"]
  ]
  const fixture = await chatFixture(t, (_body, items) =>
    items
      .map((text) => {
        if (text.includes("Search matching Skills")) return "根据任务含义搜索匹配的技能。"
        if (text.includes("Args:")) return "Args:"
        return "query：一个简洁的能力请求；请保留所有明确命名的 Skill id。"
      })
      .join("\n%%\n")
  )
  const units = sources.map(([text], index) => ({
    id: "docstring-" + index,
    start: 0,
    end: text.length,
    text,
    format: "text" as const,
    kind: "string" as const,
    protected: index === 0 ? [{ start: 0, end: 3 }] : []
  }))
  const settings = { ...fixture.settings, maxTranslationAttempts: 1 }
  const store = new TranslationStore()
  const translate = () =>
    store.translate("docstring", { units }, (input, signal) => requestTranslation(fixture.service, settings, input, signal, fixture.gate), new AbortController().signal)
  const result = await translate()
  for (const [index, unit] of units.entries()) assert.equal(result.get(unit.id), sources[index][1])
  assert.ok(translationIsUnchanged(units[1], result.get(units[1].id)!))
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, 1, "Restored indentation or an unchanged label triggered another request.")
  assert.deepEqual(
    fixture.seen[0].items,
    sources.map(([text], index) => (index === 0 ? text.slice(3) : text.trimStart()))
  )
})

test("multiline strings fold continuation layout while preserving local shells and exact unchanged results", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = '"""Read carefully.' + newline + "        Args:" + newline + newline + "\t\tRead  slowly.  " + newline + '        """'
    const unit = {
      id: "multiline-string",
      start: 0,
      end: text.length,
      text,
      format: "text" as const,
      kind: "string" as const,
      protected: [
        { start: 0, end: 3 },
        { start: text.length - 3, end: text.length }
      ]
    }
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, "Read carefully. Args: Read  slowly.")
    assert.equal(
      prepared.restore(prepared.text.replace("Read carefully.", "仔细阅读。").replace("Read  slowly.", "慢慢  阅读。")),
      '"""仔细阅读。 Args: 慢慢  阅读。  ' + newline + '        """'
    )
    assert.equal(prepared.restore(prepared.text), text)
    assert.equal(prepared.hasMarkers, false)
    assert.throws(() => prepared.restore(prepared.text + "\n额外行"), /structure-invalid/u)
  }
})

test("string boundary whitespace is restored exactly while internal or added output spaces remain significant", () => {
  const text = '"  Read  carefully.\t "'
  const unit = {
    id: "literal-spaces",
    start: 0,
    end: text.length,
    text,
    format: "text" as const,
    kind: "string" as const,
    protected: [
      { start: 0, end: 1 },
      { start: text.length - 1, end: text.length }
    ]
  }
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, "Read  carefully.")
  assert.equal(prepared.restore("仔细  阅读。"), '"  仔细  阅读。\t "')
  assert.equal(prepared.restore(prepared.text), text)
  assert.equal(translationIsUnchanged(unit, prepared.restore("Read carefully.")), false)
  assert.equal(translationIsUnchanged(unit, prepared.restore(" " + prepared.text)), false)
})

test("technical overlap handling preserves syntax and earlier rules across interleaved matches", () => {
  const text = "API https://example.com/HTTP DNS ./API/config.json JSON ops@API.example HTTP(S) CPU `API DNS` sourceId"
  const unit = { id: "overlap", start: 0, end: text.length, text, format: "markdown" as const }
  assert.deepEqual(
    protectedFragments(unit).map((fragment) => fragment.text),
    ["https://example.com/HTTP", "./API/config.json", "ops@API.example", "`API DNS`"]
  )
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.needsTranslation, true)
  assert.equal(prepared.text, text)
  assert.equal(prepared.restore(prepared.text), text)
  assert.throws(() => prepared.restore(prepared.text.replace("https://example.com/HTTP", "")), /translation-structure-invalid/)
})

test("dense technical prose keeps every occurrence and adjacent style boundary intact", () => {
  const text = "Read **sourceId** and *source_id*, then " + "HTTP/2 https://example.com/API ./API/config.json sourceId ".repeat(256) + "carefully."
  const unit = { id: "dense", start: 0, end: text.length, text, format: "markdown" as const }
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.needsTranslation, true)
  assert.equal(prepared.text, text)
  assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), text.replace("Read", "阅读"))
  assert.throws(() => prepared.restore(prepared.text + "<CTP0>"), /translation-marker-mismatch/)
})

test("paired style boundaries tolerate added horizontal whitespace without changing prose or original outer spacing", () => {
  for (const [source, output, expected] of [
    ["**Targeted search**: now.", "** \t目标搜索\t **: now.", "**目标搜索**: now."],
    ["Read *carefully* now.", "阅读 * \t仔细 \t* now.", "阅读 *仔细* now."],
    ["Read _carefully_ now.", "阅读 _ 仔细 _ now.", "阅读 _仔细_ now."],
    ["Read __carefully__ now.", "阅读 __ 仔细 __ now.", "阅读 __仔细__ now."],
    ["Read ~~carefully~~ now.", "阅读 ~~ 仔细 ~~ now.", "阅读 ~~仔细~~ now."],
    ["Read ***carefully*** now.", "阅读 *** 仔细 *** now.", "阅读 ***仔细*** now."],
    ["Read **carefully and *slowly*** now.", "阅读 ** 仔细  和 * 缓慢 *** now.", "阅读 **仔细  和 *缓慢*** now."]
  ]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.hasMarkers, false)
    const restored = prepared.restore(output)
    assert.equal(restored, expected)
    assert.equal(validateTranslation(unit, restored), undefined, source)
  }
})

test("style whitespace tolerance preserves marker integrity, newlines, technical content and non-style whitespace", () => {
  const source = "Read **carefully** and keep `sourceId` at [guide](https://example.com)."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  const output = prepared.text.replace("carefully", " 仔细 ").replace("Read", "阅读  ")
  const restored = prepared.restore(output)
  assert.equal(restored, source.replace("Read", "阅读  ").replace("carefully", "仔细"))
  assert.equal(validateTranslation(unit, restored), undefined)
  assert.equal(prepared.restore(prepared.text.replace("carefully", " carefully ")), source)
  assert.equal(validateTranslation(unit, prepared.restore(output.replace("`sourceId`", ""))), undefined)
  assert.throws(() => prepared.restore(output + "<CTP99>"), /marker-mismatch/)
  assert.equal(prepared.restore(output.replace("仔细", "\n仔细")), restored)
  assert.throws(() => prepared.restore(output.replace("仔细", "\n\n仔细")), /structure-invalid/)
  const literal = '"Read **carefully**  now."'
  const string = prepareTranslation({ id: "string", start: 0, end: literal.length, text: literal, format: "text", kind: "string" }, emptyPreserveTerms, 32)
  assert.equal(string.restore(string.text.replace("carefully", " carefully ")), literal.replace("carefully", " carefully "))
})

test("style whitespace is repaired before attempt exhaustion and the validated translation is cached", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((text) => text.replace("Targeted search", " 目标搜索 ").replace("write results doc", "生成结果文档")).join("\n%%\n"))
  const source = '**Targeted search**:\n`search_web(query="Tesla stock")` → write results doc → `report_summary("Result")`'
  const input = { units: parseMarkdown(source).groups.flatMap((group) => group.units) }
  const settings = { ...fixture.settings, maxTranslationAttempts: 1 }
  const store = new TranslationStore()
  const translate = () => store.translate("style", input, (request, signal) => requestTranslation(fixture.service, settings, request, signal, fixture.gate), new AbortController().signal)
  const expected = source.replace("\n", " ").replace("Targeted search", "目标搜索").replace("write results doc", "生成结果文档")
  assert.deepEqual([...(await translate()).values()], [expected])
  assert.deepEqual([...(await translate()).values()], [expected])
  assert.equal(fixture.seen.length, 1, "A locally repairable style boundary must not consume retries or bypass the cache.")
})

test("translated slash-separated prose is not mistaken for a new path while explicit paths stay protected", () => {
  for (const format of ["text", "markdown"] as const) {
    for (const [text, translated] of [
      ["Use task/context fields.", "使用任务/上下文字段。"],
      ["Read input/output.", "读取输入/输出。"],
      ["Read or write.", "读/写。"],
      ["Read accented prose.", "Lire entrée/sortie."],
      ["Read combining marks.", "Lire e\u0301/sortie."]
    ]) {
      const unit = { id: "slash", start: 0, end: text.length, text, format }
      const restored = prepareTranslation(unit, emptyPreserveTerms, 32).restore(translated)
      assert.equal(restored, translated)
      assert.equal(validateTranslation(unit, restored), undefined, translated)
    }
    for (const path of ["/上下文/配置.json", "./上下文/配置.json", "../config.json", "C:\\项目\\config.json"]) {
      const text = "Read " + path + "."
      const unit = { id: "path", start: 0, end: text.length, text, format }
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.equal(prepared.restore(prepared.text.replace("Read", "读取")), text.replace("Read", "读取"))
      assert.throws(() => prepared.restore("读取路径。"), /structure-invalid/)
    }
  }
})

test("Markdown prefixes stay local and one equivalent echoed prefix is tolerated without accepting new structure", () => {
  for (const [prefix, echoed] of [
    ["- ", "* "],
    ["  - ", "- "],
    ["+ ", "- "],
    ["* ", "+ "],
    ["1. ", "1. "],
    ["2. ", "1. "],
    ["12) ", "1) "],
    ["> - [ ] ", "> * [ ] "],
    ["> 2. [x] ", "> 1. [ ] "],
    ["> > ", ">> "],
    ["# ", "# "],
    ["## ", "## "]
  ]) {
    const source = prefix + "Read the original document."
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, "Read the original document.")
    for (const output of ["阅读原始文档。", prefix + "阅读原始文档。", echoed + "阅读原始文档。"]) {
      const restored = prepared.restore(output)
      assert.equal(restored, prefix + "阅读原始文档。")
      assert.equal(validateTranslation(unit, restored), undefined)
    }
  }
  const unit = parseMarkdown("- Read the original document.").groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  for (const output of ["- - 阅读原始文档。", "- 阅读原始文档。\n- 新增条目。", "- 阅读原始文档。\n\n新增段落。", "# 新增标题。"])
    if (/[\r\n]/u.test(output)) assert.throws(() => prepared.restore(output), /structure-invalid/, output)
    else assert.ok(validateTranslation(unit, prepared.restore(output)) instanceof ModelRetry, output)
  const ordered = parseMarkdown("2. Read the original document.").groups[0].units[0]
  assert.ok(validateTranslation(ordered, prepareTranslation(ordered, emptyPreserveTerms, 32).restore("- 阅读原始文档。")) instanceof ModelRetry)
  const codeUnit = parseMarkdown("- Read `sourceId`.").groups[0].units[0]
  const code = prepareTranslation(codeUnit, emptyPreserveTerms, 32)
  const echoedCode = "- " + code.text.replace("Read", "读取")
  assert.equal(validateTranslation(codeUnit, code.restore(echoedCode)), undefined)
  assert.equal(validateTranslation(codeUnit, code.restore("- 读取代码。")), undefined)
  for (const text of ["- Read the original document.", "2. Read the original document."]) {
    const literal = { id: "literal", start: 0, end: text.length, text, format: "text" as const, kind: "string" as const }
    assert.equal(prepareTranslation(literal, emptyPreserveTerms, 32).text, text)
  }
})

test("synthetic multiline visitor notes translate and cache without model line markers", async (t) => {
  const source =
    "- The museum guide describes the pottery room, the map gallery, and the\r\n" +
    "  courtyard garden beside the eastern entrance. Visitors can collect a\r\n" +
    "  printed floor plan at the desk and follow the numbered signs upstairs;\r\n" +
    "  the reading room remains open until the last afternoon tour finishes."
  const output = "- 博物馆指南介绍陶器展厅、地图画廊和东门旁的庭院花园。游客可在服务台领取楼层图，按编号标识上楼；阅览室会开放至最后一场下午导览结束。"
  const fixture = await chatFixture(t, () => output)
  const settings = { ...fixture.settings, maxTranslationAttempts: 1 }
  const store = new TranslationStore()
  for (const format of ["text", "markdown"] as const) {
    const unit = { id: "selection", start: 0, end: source.length, text: source, format }
    const translate = () =>
      store.translate(format, { units: [unit] }, (request, signal) => requestTranslation(fixture.service, settings, request, signal, fixture.gate), new AbortController().signal)
    assert.deepEqual([...(await translate()).values()], [output])
    assert.deepEqual([...(await translate()).values()], [output])
    const request = fixture.seen.at(-1)!
    assert.ok(!/[\r\n]/u.test(request.items[0]))
    assert.ok(!request.items[0].includes("<CTP"))
    assert.ok(!request.items[0].includes("  "))
    assert.equal(prepareTranslation(unit, emptyPreserveTerms, 32).restore(request.items[0]), source)
  }
  assert.equal(fixture.seen.length, 2, "A validated folded translation bypassed the cache.")
})

test("complete prose wrappers stay local while internal punctuation and formatting stay translatable", () => {
  for (const source of [
    '"Read the original document."',
    "“Read the original document.”",
    "「Read the original document.」",
    "**Read the original document.**",
    "__Read the original document.__",
    "*Read the original document.*",
    "_Read the original document._",
    "~~Read the original document.~~",
    "[Read the original document.][guide]",
    '[**Read the original document.**](https://example.com "Title")'
  ]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, "Read the original document.")
    const restored = prepared.restore("阅读原始文档。")
    assert.equal(restored, source.replace("Read the original document.", "阅读原始文档。"))
    assert.equal(validateTranslation(unit, restored), undefined)
  }
  for (const text of ['"First" and "second"', "don't", 'Read "this" document.', "Gardens + maps + booklets", "D — Illustrated"]) {
    assert.equal(prepareTranslation({ id: "plain", start: 0, end: text.length, text, format: "text" }, emptyPreserveTerms, 32).text, text)
  }
  const text = "Read **this** carefully."
  for (const reference of ["[Read]", "[Read][]"]) {
    const prepared = prepareTranslation({ id: "reference", start: 0, end: reference.length, text: reference, format: "markdown" }, emptyPreserveTerms, 32)
    assert.notEqual(prepared.text, "Read", "A label-derived reference target was incorrectly treated as a separate local shell.")
    assert.equal(prepared.restore(prepared.text), reference)
  }
  const inline = prepareTranslation({ id: "inline", start: 0, end: text.length, text, format: "markdown" }, emptyPreserveTerms, 32)
  assert.equal(inline.text, text)
  assert.equal(inline.restore(inline.text.replace("this", "这部分")), text.replace("this", "这部分"))
  const spacedText = " \t“ Read the original document. ”\r\n"
  const spaced = { id: "spaces", start: 0, end: spacedText.length, text: spacedText, format: "text" as const }
  const body = prepareTranslation(spaced, emptyPreserveTerms, 32)
  assert.equal(body.text, "Read the original document.")
  assert.equal(body.restore("阅读原始文档。"), spaced.text.replace("Read the original document.", "阅读原始文档。"))
  const scalar = parseMarkdown("---\nlabel: '  \"Read\"  '\n---").groups[0].units.find((unit) => !unit.yamlKey)!
  assert.equal(prepareTranslation(scalar, emptyPreserveTerms, 32).text, scalar.content)
})

test("comment shells stay local while documentation continuation prefixes fold into one space", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const text of ["/* Keep `sourceId` unchanged. */", "/**" + newline + " * Keep `sourceId` unchanged." + newline + " */", "/*! Keep `sourceId` unchanged. */"]) {
      const unit = { id: "comment", start: 0, end: text.length, text, format: "text" as const, kind: "comment" as const }
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.equal(prepared.text, "Keep `sourceId` unchanged.")
      const restored = prepared.restore("保留 `sourceId` 不变。")
      assert.equal(restored, text.replace("Keep `sourceId` unchanged.", "保留 `sourceId` 不变。"))
      assert.equal(validateTranslation(unit, restored), undefined)
      assert.ok(validateTranslation(unit, restored.replace("保留", "*/ 保留 /*")) instanceof ModelRetry)
      if (text.includes(newline)) assert.throws(() => prepared.restore("保留 `sourceId`\n不变。"), /structure-invalid/)
    }
    const text = ["/**", " * Read the original document.", " *", " * Continue reading.", " * Keep `sourceId` unchanged.", " */"].join(newline)
    const unit = { id: "multiline", start: 0, end: text.length, text, format: "text" as const, kind: "comment" as const }
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.ok(!prepared.text.includes("*") && !/[\r\n]/.test(prepared.text))
    assert.equal(
      prepared.restore(prepared.text.replace("Read the original document.", "阅读原始文档。").replace("Keep ", "保留 ")),
      ["/**", " * 阅读原始文档。 Continue reading. 保留 `sourceId` unchanged.", " */"].join(newline)
    )
    assert.equal(prepared.hasMarkers, false)
    assert.equal(validateTranslation(unit, prepared.restore(prepared.text.replace("`sourceId`", ""))), undefined)
    assert.equal(validateTranslation(unit, prepared.restore(prepared.text + "`sourceId`")), undefined)
    assert.throws(() => prepared.restore(prepared.text.replace("Continue", "\nContinue")), /structure-invalid/)
  }
  const literal = "/* Compute 2 * 3 and read *this* carefully. */"
  assert.equal(
    prepareTranslation({ id: "literal", start: 0, end: literal.length, text: literal, format: "text", kind: "comment" }, emptyPreserveTerms, 32).text,
    "Compute 2 * 3 and read *this* carefully."
  )
})

test("progressive preview preserves Markdown/YAML boundaries, maps length changes and removes completed loading markers", () => {
  const source =
    '---\r\nlabel: "Original"\r\n---\r\n\r\n# Heading ##\r\n\r\nSetext title\r\n---\r\n\r\n1. First paragraph.\r\n2. Second paragraph.\r\n\r\n| Field | Value |\r\n| --- | --- |\r\n| name | Text |\r\n\r\n```ts\r\nconst untouched = 1;\r\n```'
  const parsed = parseMarkdown(source)
  const units = parsed.groups.flatMap((group) => group.units)
  const pending = progressiveMarkdown(parsed, new Map())
  assert.ok(pending.startsWith('---\r\nlabel: "Original"\r\n---'))
  assert.ok(pending.includes("Heading " + previewLoadingMarker + " ##"))
  assert.ok(pending.includes("Setext title " + previewLoadingMarker + "\r\n---"))
  assert.ok(pending.includes("const untouched = 1;\r\n```"))
  assert.equal(parseMarkdown(pending).groups.flatMap((group) => group.units).length, units.length)
  const heading = units.find((unit) => unit.text.startsWith("# Heading"))!
  const partial = new Map([[heading.id, "# 更长的标题内容 ##"]])
  const snapshot = progressiveMarkdown(parsed, partial)
  assert.ok(snapshot.includes("# 更长的标题内容 ##\r\n"))
  assert.equal(snapshot.split(previewLoadingMarker).length, pending.split(previewLoadingMarker).length - 1)
  const complete = new Map(units.map((unit) => [unit.id, partial.get(unit.id) ?? unit.text]))
  assert.equal(progressiveMarkdown(parsed, complete), translatedMarkdown(parsed, complete))
  assert.equal(parsed.source, source)
  assert.throws(() => progressiveMarkdown(parsed, new Map([[heading.id, "Paragraph instead of heading."]])), /structure-invalid/)
})

test("custom preserved terms match complete prose bodies and never mask occurrences within mixed content", () => {
  const unit = parseMarkdown("Read Feature and `Feature` at [Feature](https://example.com/Feature).").groups[0].units[0]
  const prepared = prepareTranslation(unit, parsePreserveTerms(["Feature"]), 32)
  assert.equal(prepared.restore(prepared.text), unit.text)
  assert.equal(prepared.text, prepareTranslation(unit, emptyPreserveTerms, 32).text)
  assert.ok(prepared.text.includes("Feature"))
  assert.equal(prepared.needsTranslation, true)
  assert.throws(() => prepared.restore(prepared.text + prepared.text), /structure-invalid/)
  assert.throws(() => prepared.restore("No placeholders survived."), /structure-invalid/)
  for (const source of ["Feature", "feature", "**FEATURE**", "  - fEaTuRe", "> Feature"]) {
    const unit = parseMarkdown(source)
      .groups.flatMap((group) => group.units)
      .at(-1)!
    const body = prepareTranslation(unit, parsePreserveTerms(["Feature"]), 32)
    assert.equal(body.needsTranslation, false, source)
    assert.equal(body.restore(body.text), unit.text)
  }
  for (const source of ["Feature.", "Feature Widget", "Use Feature.", "FeatureWidget"]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    assert.equal(prepareTranslation(unit, parsePreserveTerms(["Feature", "Widget"]), 32).needsTranslation, true, source)
    assert.equal(prepareTranslation(unit, parsePreserveTerms(["Feature", "Widget"]), 32).text, prepareTranslation(unit, emptyPreserveTerms, 32).text)
  }
  for (const unit of [
    ...parseYaml("Feature: Feature").groups.flatMap((group) => group.units),
    {
      id: "string",
      start: 0,
      end: 9,
      text: '"Feature"',
      format: "text" as const,
      kind: "string" as const,
      protected: [
        { start: 0, end: 1 },
        { start: 8, end: 9 }
      ]
    }
  ]) {
    const prepared = prepareTranslation(unit, parsePreserveTerms(["Feature"]), 32)
    assert.equal(prepared.needsTranslation, false)
    assert.equal(prepared.restore(prepared.text), unit.text)
  }
})

test("only long copy-only fragments are masked across indentation and repeated text", () => {
  for (const source of [
    'Use `edition` at [guide](https://example.com/a-very-long-private-resource) and <span data-id="private">this label</span>.',
    "  - Use `edition` here.\r\n    Keep `pages=[]` unchanged.",
    "Read ``code `with` delimiters`` and `a\nb` after 😀.",
    "Read [Feature](Feature), then translate the plain Feature label."
  ]) {
    const unit = { id: "protected", start: 0, end: source.length, text: source, format: "markdown" as const }
    const prepared = prepareTranslation(unit, parsePreserveTerms(["Feature"]), 32)
    assert.equal(prepared.text.includes("<CTP"), source.includes("a-very-long-private-resource"))
    assert.equal(prepared.restore(prepared.text), source)
    const translated = prepared.restore(prepared.text.replace("Use", "使用").replace("Read", "阅读"))
    assert.equal(validateTranslation(unit, translated), undefined)
  }
})

test("placeholder namespaces avoid literal source, preserved terms and reference markers and restore them literally", () => {
  const term = "<CTP1_0> $& ${targetLang}"
  const source = "Keep <CTP0> and " + term + " beside `pages_abcdefghijklmnopqrstuvwxyz_0123456789`."
  const unit = { id: "collision", start: 0, end: source.length, text: source, format: "markdown" as const }
  const context = "Literal <CTP2_0> in reference context."
  const prepared = prepareTranslation(unit, parsePreserveTerms([term]), 32, context)
  assert.equal(prepared.restore(prepared.text), source)
  assert.ok(prepared.text.includes("<CTP3_"))
})

test("Google and Bing adapters preserve protected structure through bounded real HTTP requests", async (t) => {
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost")
    paths.push(url.pathname)
    if (url.pathname === "/google") {
      response.end(JSON.stringify([[[url.searchParams.get("q")]]]))
      return
    }
    if (url.pathname === "/bing/translator") {
      response.setHeader("Set-Cookie", "fixture=session; Path=/bing; HttpOnly")
      response.end('IG:"probe" data-iid="translator.1" params_AbusePreventionHelper = [123456,"fixture-token",600000];')
      return
    }
    const parts = []
    for await (const part of request) parts.push(part)
    const form = new URLSearchParams(Buffer.concat(parts).toString())
    assert.equal(form.get("fromLang"), "auto-detect")
    assert.equal(form.get("to"), "zh-Hans")
    assert.equal(request.headers.cookie, "fixture=session")
    response.end(JSON.stringify([{ translations: [{ text: form.get("text"), to: "zh-Hans" }] }]))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port
  for (const provider of ["google", "bing"] as const) {
    const settings = {
      ...limits,
      provider,
      apiUrl: origin + (provider === "google" ? "/google" : "/bing/translator"),
      model: "",
      systemPrompt: defaultSystemPrompt,
      userPrompt: defaultUserPrompt,
      languageNames: defaultLanguageNames,
      apiKey: "",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      preserveTerms: emptyPreserveTerms,
      skipSameLanguage: false
    }
    const content = await requestTranslation(new TranslationService(), settings, batch, new AbortController().signal, new RequestGate(100, 2))
    const result = validateTranslations(batch, content)
    assert.deepEqual(
      [...result.values()],
      batch.units.map((unit) => unit.text)
    )
  }
  assert.equal(paths.filter((path) => path === "/google").length, 2)
  assert.equal(paths.filter((path) => path === "/bing/ttranslatev3").length, 2)
})

test("code comments and strings reach custom prompts as typed units with protected syntax", async (t) => {
  const fixture = await chatFixture(t, (body) => {
    assert.equal(body.messages[0].content, "Translate comment, string into Simplified Chinese.")
    return modelInput(body).replaceAll("Read the original document.", "阅读原始文档。")
  })
  const texts = ["// Read the original document.", "`Read the original document. ${sourceId}\\n`"]
  const input: TranslationInput = {
    units: texts.map((text, index) => ({
      id: "code" + index,
      start: index * 100,
      end: index * 100 + text.length,
      text,
      format: "text",
      kind: index ? "string" : "comment",
      protected: index
        ? [
            { start: 0, end: 1 },
            { start: text.indexOf("${"), end: text.length }
          ]
        : [{ start: 0, end: 2 }]
    }))
  }
  const result = validateTranslations(
    input,
    await requestTranslation(fixture.service, { ...fixture.settings, systemPrompt: "Translate ${contentType} into ${targetLang}." }, input, new AbortController().signal, fixture.gate)
  )
  assert.deepEqual([...result.values()], ["// 阅读原始文档。", "`阅读原始文档。 ${sourceId}\\n`"])
})

test("short CTP markers protect internal syntax while separable code delimiters stay local", () => {
  const text = '"Read ${sourceId}\\n"'
  const unit = {
    id: "literal",
    start: 0,
    end: text.length,
    text,
    format: "text" as const,
    kind: "string" as const,
    protected: [
      { start: 0, end: 1 },
      { start: 6, end: 17 },
      { start: 17, end: 19 },
      { start: 19, end: 20 }
    ]
  }
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, "Read ${sourceId}\\n")
  assert.equal(prepared.restore("阅读 ${sourceId}\\n"), '"阅读 ${sourceId}\\n"')
  assert.throws(() => prepared.restore("阅读"), /structure-invalid/)
  assert.throws(() => prepared.restore("阅读 ${sourceId}\\n ${sourceId}\\n"), /structure-invalid/)
})
