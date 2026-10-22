import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { validTranslation, translationIsUnchanged } from "../src/documents/validation.ts"
import { translatedMarkdown, progressiveMarkdown, previewLoadingMarker } from "../src/documents/presentation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { prepareTranslation, parsePreserveTerms } from "../src/documents/terms.ts"
import { protectedFragments } from "../src/documents/protection.ts"
import { TranslationService } from "../src/translation/engine.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames } from "../src/translation/providers/prompts.ts"
import { limits, requestTranslation, batch, modelInput, chatFixture } from "./support/fixtures.ts"

test("links keep native syntax with one protected target while captions remain translatable", () => {
  for (const [source, input] of [
    ["Read [Title](URL).", "Read [Title](<CTP0>)."],
    ['Read [Title](URL "Caption").', 'Read [Title](<CTP0> "Caption").'],
    ['Read [Title](<https://example.com/a b> "Caption").', 'Read [Title](<CTP0> "Caption").'],
    ['Read ![Title](picture.png "Caption").', 'Read ![Title](<CTP0> "Caption").'],
    ["Read [Title][guide].", "Read [Title][<CTP0>]."],
    ["Read ![Title][guide].", "Read ![Title][<CTP0>]."],
    ["Read <https://example.com>.", "Read <CTP0>."],
    ["Read <a@example.com>.", "Read <CTP0>."]
  ]) {
    for (const format of ["markdown", "text"] as const) {
      const unit = { id: "link", text: source, start: 0, end: source.length, format }
      const prepared = prepareTranslation(unit, [])
      assert.equal(prepared.text, input, source)
      const output = prepared.text.replace("Read", "阅读").replace("Title", "标题").replace("Caption", "说明")
      const restored = prepared.restore(output)
      assert.equal(restored, source.replace("Read", "阅读").replace("Title", "标题").replace("Caption", "说明"))
      assert.ok(validTranslation(unit, restored), restored)
      for (const damaged of [output.replace("<CTP0>", ""), output + "<CTP0>", output.replace("<CTP0>", "<CTP99>"), output.replace("<CTP0>", "<CTP0")])
        assert.throws(() => prepared.restore(damaged), /marker-mismatch/u)
    }
  }
})

test("native link punctuation remains subject to structure and target validation", () => {
  const source = "Read [Title](URL) and ![Image](picture.png)."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, [])
  assert.equal(prepared.text, "Read [Title](<CTP0>) and ![Image](<CTP1>).")
  for (const output of [
    "阅读 [标题(<CTP0>) 和 ![图片](<CTP1>)。",
    "阅读 [标题](<CTP0>) 和 [图片](<CTP1>)。",
    "阅读 [标题](<CTP1>) 和 ![图片](<CTP0>)。",
    "阅读 标题<CTP0> 和 ![图片](<CTP1>)。"
  ])
    assert.equal(validTranslation(unit, prepared.restore(output)), false, output)
  const nested = parseMarkdown("Read [**Title**](URL) and **[Guide](OTHER)**.").groups[0].units[0]
  const formatted = prepareTranslation(nested, [])
  const restored = formatted.restore(formatted.text.replace("Read", "阅读").replace("Title", "标题").replace("Guide", "指南"))
  assert.ok(validTranslation(nested, restored))
  assert.equal(validTranslation(nested, restored.replace("[**标题**](URL)", "**[标题](URL)**")), false)
})

test("empty explicit link destinations keep their labels translatable without placeholders", () => {
  for (const source of ["Read [Title]().", "Read ![Title]()."]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, [])
    assert.equal(prepared.text, source)
    const restored = prepared.restore(source.replace("Read", "阅读").replace("Title", "标题"))
    assert.equal(restored, source.replace("Read", "阅读").replace("Title", "标题"))
    assert.ok(validTranslation(unit, restored))
  }
})

test("label-derived reference targets stay intact rather than translating their lookup keys", () => {
  for (const reference of ["[Title]", "[Title][]", "![Title]", "![Title][]"]) {
    const source = "Read " + reference + "."
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, [])
    assert.equal(prepared.text, "Read <CTP0>.")
    assert.equal(prepared.restore("阅读 <CTP0>。"), "阅读 " + reference + "。")
    assert.ok(validTranslation(unit, "阅读 " + reference + "。"))
    assert.equal(validTranslation(unit, source.replace("Title", "标题")), false)
  }
})

test("logged writing link uses two protected values and retries only damaged native structure before caching", async (t) => {
  const text =
    "Create outlines, drafts, rewrites, and finished documents directly. Read supplied research and current source documents before using them; delegate missing research to `SearchAgent` when needed. Match the user's language, audience, tone, format, and length, and cite sources with [Title](URL)."
  const expectedInput = text.replace("`SearchAgent`", "<CTP0>").replace("URL", "<CTP1>")
  const output = "直接创建提纲、草稿、重写稿和完整文档，先阅读研究和当前源文件，必要时委派给 <CTP0>，按用户需求写作并使用[标题](<CTP1>)标注来源。"
  const fixture = await chatFixture(t, (_body, items, call) => {
    assert.equal(items[0], expectedInput)
    return (call === 1 ? [output.replace("[标题]", "[标题"), "为长文档规划章节结构。"] : [output]).join("\n%%\n")
  })
  const source = text + "\n\nPlan sections for a long document."
  const parsed = parseMarkdown(source)
  const input = { units: parsed.groups.flatMap((group) => group.units) }
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate("writing-link", input, (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate), new AbortController().signal)
  const first = await translate()
  assert.equal(first.get(input.units[0].id), output.replace("<CTP0>", "`SearchAgent`").replace("<CTP1>", "URL"))
  assert.equal(first.get(input.units[1].id), "为长文档规划章节结构。")
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
    const prepared = prepareTranslation(unit(text), rules)
    assert.equal(prepared.needsTranslation, false, text)
    assert.equal(prepared.restore(prepared.text), text)
  }
  for (const text of ["axb", "HTTP/i", "HTTP!", "Read HTTP.", "HTTP HTTPS", "项目丙"]) assert.equal(prepareTranslation(unit(text), rules).needsTranslation, true, text)
  for (const parsed of [parseMarkdown("- **hTtPs**"), parseYaml('HTTP: "https"')]) {
    for (const item of parsed.groups.flatMap((group) => group.units)) {
      const prepared = prepareTranslation(item, rules)
      assert.equal(prepared.needsTranslation, false, item.text)
      assert.equal(prepared.restore(prepared.text), item.text)
    }
  }
  assert.equal(prepareTranslation(unit("http"), parsePreserveTerms(["/HTTP/i"])).needsTranslation, true, "A string was interpreted as a regex literal.")
  const alternatives = parsePreserveTerms([{ pattern: "foo|foobar" }])
  assert.equal(prepareTranslation(unit("foobar"), alternatives).needsTranslation, false)
  const multiline = parsePreserveTerms([{ pattern: "^HTTP$", flags: "m" }])
  for (const text of ["Read\nHTTP", "HTTP\nRead"]) assert.equal(prepareTranslation(unit(text), multiline).needsTranslation, true, "Multiline anchors escaped whole-body matching.")
  for (const [pattern, flags] of [
    ["first.second", "s"],
    ["first\\nsecond", "u"]
  ])
    assert.equal(prepareTranslation(unit("first\nsecond"), parsePreserveTerms([{ pattern, flags }])).needsTranslation, false)
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
    const prepared = prepareTranslation(unit, [])
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
  const prepared = prepareTranslation(unit, [])
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
    ["https://example.com/HTTP", "./API/config.json", "ops@API.example", "`API DNS`", "sourceId"]
  )
  const prepared = prepareTranslation(unit, [])
  assert.equal(prepared.needsTranslation, true)
  assert.equal(prepared.text, "API <CTP0> DNS <CTP1> JSON <CTP2> HTTP(S) CPU <CTP3> <CTP4>")
  assert.equal(prepared.restore(prepared.text), text)
  assert.throws(() => prepared.restore(prepared.text.replace("<CTP0>", "")), /translation-marker-mismatch/)
})

test("dense technical prose keeps every occurrence and adjacent style boundary intact", () => {
  const text = "Read **sourceId** and *source_id*, then " + "HTTP/2 https://example.com/API ./API/config.json sourceId ".repeat(256) + "carefully."
  const unit = { id: "dense", start: 0, end: text.length, text, format: "markdown" as const }
  const prepared = prepareTranslation(unit, [])
  assert.equal(prepared.needsTranslation, true)
  assert.deepEqual(prepared.text.replace(/<CTP\d+>/gu, " ").match(/\p{L}+/gu), ["Read", "and", "then", "carefully"])
  assert.equal(prepared.restore(prepared.text.replace("Read", "阅读")), text.replace("Read", "阅读"))
  assert.throws(() => prepared.restore(prepared.text + "<CTP0>"), /translation-marker-mismatch/)
})

test("paired style boundaries tolerate added horizontal whitespace without changing prose or original outer spacing", () => {
  for (const [source, output, expected] of [
    ["**Targeted search**: now.", "<CTP0> \t目标搜索\t <CTP1>: now.", "**目标搜索**: now."],
    ["Read *carefully* now.", "阅读<CTP0> \t仔细 \t<CTP1>now.", "阅读 *仔细* now."],
    ["Read _carefully_ now.", "阅读<CTP0> 仔细 <CTP1>now.", "阅读 _仔细_ now."],
    ["Read __carefully__ now.", "阅读<CTP0> 仔细 <CTP1>now.", "阅读 __仔细__ now."],
    ["Read ~~carefully~~ now.", "阅读<CTP0> 仔细 <CTP1>now.", "阅读 ~~仔细~~ now."],
    ["Read ***carefully*** now.", "阅读<CTP0> <CTP1> 仔细 <CTP2> <CTP3>now.", "阅读 ***仔细*** now."],
    ["Read **carefully and *slowly*** now.", "阅读<CTP0> 仔细  和<CTP1> 缓慢 <CTP2> <CTP3>now.", "阅读 **仔细  和 *缓慢*** now."],
    ["Read\t **carefully**  now.", "阅读<CTP0> 仔细 <CTP1>now.", "阅读\t **仔细**  now."],
    ["**First** and **second**.", "<CTP2> 第二 <CTP3>和<CTP0> 第一 <CTP1>.", " **第二**和**第一** ."]
  ]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const restored = prepareTranslation(unit, []).restore(output)
    assert.equal(restored, expected)
    assert.ok(validTranslation(unit, restored), source)
  }
})

test("style whitespace tolerance preserves marker integrity, newlines, technical content and non-style whitespace", () => {
  const source = "Read **carefully** and keep `sourceId` at [guide](https://example.com)."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, [])
  const output = prepared.text.replace("carefully", " 仔细 ").replace("Read", "阅读  ")
  const restored = prepared.restore(output)
  assert.equal(restored, source.replace("Read", "阅读  ").replace("carefully", "仔细"))
  assert.ok(validTranslation(unit, restored))
  assert.equal(prepared.restore(prepared.text.replace("carefully", " carefully ")), source)
  assert.throws(() => prepared.restore(output.replace("<CTP0>", "")), /marker-mismatch/)
  assert.throws(() => prepared.restore(output + "<CTP0>"), /marker-mismatch/)
  assert.throws(() => prepared.restore(output + "<CTP99>"), /marker-mismatch/)
  assert.equal(prepared.restore(output.replace("仔细", "\n仔细")), restored, "A single style-boundary line break did not restore the original inline structure.")
  assert.throws(() => prepared.restore(output.replace("仔细", "\n\n仔细")), /structure-invalid/, "An added paragraph was accepted as style whitespace.")
  const nested = prepareTranslation(parseMarkdown("Read ***carefully*** now.").groups[0].units[0], [])
  assert.throws(() => nested.restore("Read<CTP0> <CTP1> 仔细 <CTP3> <CTP2>now."), /marker-mismatch/)
  for (const text of ["Read `sourceId` now.", '"Read  carefully"', "Read  carefully."]) {
    const plain = { id: "plain", start: 0, end: text.length, text, format: "text" as const }
    const input = prepareTranslation(plain, [])
    const output = input.text.replace("Read", "阅读").replace(/(<CTP\d+>)/g, " $1 ")
    assert.equal(input.restore(output), text.replace("Read", "阅读").replace("`sourceId`", " `sourceId` "))
  }
  const literal = '"Read **carefully**  now."'
  const string = prepareTranslation({ id: "string", start: 0, end: literal.length, text: literal, format: "text", kind: "string" }, [])
  assert.equal(string.restore(string.text.replace("carefully", " carefully ")), literal.replace("carefully", " carefully "))
  const yaml = parseYaml('label: "Read **carefully**  now."')
    .groups.flatMap((group) => group.units)
    .find((unit) => unit.content?.includes("Read"))!
  const scalar = prepareTranslation(yaml, [])
  assert.equal(scalar.restore(scalar.text.replace("carefully", " carefully ")), '"Read ** carefully **  now."')
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
      const restored = prepareTranslation(unit, []).restore(translated)
      assert.equal(restored, translated)
      assert.ok(validTranslation(unit, restored), translated)
    }
    for (const path of ["/上下文/配置.json", "./上下文/配置.json", "../config.json", "C:\\项目\\config.json"]) {
      const text = "Read " + path + "."
      const unit = { id: "path", start: 0, end: text.length, text, format }
      const prepared = prepareTranslation(unit, [])
      assert.equal(prepared.restore(prepared.text.replace("Read", "读取")), text.replace("Read", "读取"))
      assert.throws(() => prepared.restore("读取路径。"), /marker-mismatch/)
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
    const prepared = prepareTranslation(unit, [])
    assert.equal(prepared.text, "Read the original document.")
    for (const output of ["阅读原始文档。", prefix + "阅读原始文档。", echoed + "阅读原始文档。"]) {
      const restored = prepared.restore(output)
      assert.equal(restored, prefix + "阅读原始文档。")
      assert.ok(validTranslation(unit, restored))
    }
  }
  const unit = parseMarkdown("- Read the original document.").groups[0].units[0]
  const prepared = prepareTranslation(unit, [])
  for (const output of ["- - 阅读原始文档。", "- 阅读原始文档。\n- 新增条目。", "- 阅读原始文档。\n\n新增段落。", "# 新增标题。"])
    if (/[\r\n]/u.test(output)) assert.throws(() => prepared.restore(output), /structure-invalid/, output)
    else assert.equal(validTranslation(unit, prepared.restore(output)), false, output)
  const ordered = parseMarkdown("2. Read the original document.").groups[0].units[0]
  assert.equal(validTranslation(ordered, prepareTranslation(ordered, []).restore("- 阅读原始文档。")), false)
  const codeUnit = parseMarkdown("- Read `sourceId`.").groups[0].units[0]
  const code = prepareTranslation(codeUnit, [])
  const echoedCode = "- " + code.text.replace("Read", "读取")
  assert.ok(validTranslation(codeUnit, code.restore(echoedCode)))
  assert.throws(() => code.restore("- 读取代码。"), /marker-mismatch/)
  for (const text of ["- Read the original document.", "2. Read the original document."]) {
    const literal = { id: "literal", start: 0, end: text.length, text, format: "text" as const, kind: "string" as const }
    assert.equal(prepareTranslation(literal, []).text, text)
  }
})

test("logged multiline slide handoff translates and caches without asking the model to preserve line markers", async (t) => {
  const source =
    "- Analytical slide handoffs carry page purpose, supporting evidence, metric\r\n" +
    "  definitions, baselines, and gaps through the existing task/context fields.\r\n" +
    "  The prompt checks local content consistency and returns factual conflicts;\r\n" +
    "  Coordinator owns whole-deck coverage and exported-file validation is separate."
  const output =
    "- 分析性幻灯片内容的传递涉及页面目的、支持性证据、指标定义、基准数据以及现有任务/上下文中的差距。提示信息会检查本地内容的一致性，并识别出事实上的冲突；协调员负责整个幻灯片的覆盖情况，而导出文件的验证则属于另一项独立任务。"
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
    assert.equal(prepareTranslation(unit, []).restore(request.items[0]), source)
  }
  assert.equal(fixture.seen.length, 2, "A validated folded translation bypassed the cache.")
})

test("complete prose wrappers stay local while internal punctuation and formatting stay translatable", () => {
  for (const source of [
    '"Read the original document."',
    "“Read the original document.”",
    "「Read the original document.」",
    "**Read the original document.**",
    "~~Read the original document.~~",
    "[Read the original document.][guide]",
    '[**Read the original document.**](https://example.com "Title")'
  ]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    const prepared = prepareTranslation(unit, [])
    assert.equal(prepared.text, "Read the original document.")
    const restored = prepared.restore("阅读原始文档。")
    assert.equal(restored, source.replace("Read the original document.", "阅读原始文档。"))
    assert.ok(validTranslation(unit, restored))
  }
  for (const text of ['"First" and "second"', "don't", 'Read "this" document.', "Hotspot + industry + companies", "D — Integrated"]) {
    assert.equal(prepareTranslation({ id: "plain", start: 0, end: text.length, text, format: "text" }, []).text, text)
  }
  const text = "Read **this** carefully."
  for (const reference of ["[Read]", "[Read][]"]) {
    const prepared = prepareTranslation({ id: "reference", start: 0, end: reference.length, text: reference, format: "markdown" }, [])
    assert.notEqual(prepared.text, "Read", "A label-derived reference target was incorrectly treated as a separate local shell.")
    assert.equal(prepared.restore(prepared.text), reference)
  }
  const inline = prepareTranslation({ id: "inline", start: 0, end: text.length, text, format: "markdown" }, [])
  assert.match(inline.text, /<CTP\d+>this<CTP\d+>/)
  assert.equal(inline.restore(inline.text.replace("this", "这部分")), text.replace("this", "这部分"))
  const spacedText = " \t“ Read the original document. ”\r\n"
  const spaced = { id: "spaces", start: 0, end: spacedText.length, text: spacedText, format: "text" as const }
  const body = prepareTranslation(spaced, [])
  assert.equal(body.text, "Read the original document.")
  assert.equal(body.restore("阅读原始文档。"), spaced.text.replace("Read the original document.", "阅读原始文档。"))
  const scalar = parseMarkdown("---\nlabel: '  \"Read\"  '\n---").groups[0].units.find((unit) => !unit.yamlKey)!
  assert.equal(prepareTranslation(scalar, []).text, scalar.content)
})

test("comment shells stay local while documentation continuation prefixes fold into one space", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const text of ["/* Keep `sourceId` unchanged. */", "/**" + newline + " * Keep `sourceId` unchanged." + newline + " */", "/*! Keep `sourceId` unchanged. */"]) {
      const unit = { id: "comment", start: 0, end: text.length, text, format: "text" as const, kind: "comment" as const }
      const prepared = prepareTranslation(unit, [])
      assert.equal(prepared.text, "Keep <CTP0> unchanged.")
      const restored = prepared.restore("保留 <CTP0> 不变。")
      assert.equal(restored, text.replace("Keep `sourceId` unchanged.", "保留 `sourceId` 不变。"))
      assert.ok(validTranslation(unit, restored))
      assert.equal(validTranslation(unit, restored.replace("保留", "*/ 保留 /*")), false)
      if (text.includes(newline)) assert.throws(() => prepared.restore("保留 <CTP0>\n不变。"), /structure-invalid/)
    }
    const text = ["/**", " * Read the original document.", " *", " * Continue reading.", " * Keep `sourceId` unchanged.", " */"].join(newline)
    const prepared = prepareTranslation({ id: "multiline", start: 0, end: text.length, text, format: "text", kind: "comment" }, [])
    assert.ok(!prepared.text.includes("*") && !/[\r\n]/.test(prepared.text))
    assert.equal(
      prepared.restore(prepared.text.replace("Read the original document.", "阅读原始文档。").replace("Keep ", "保留 ")),
      ["/**", " * 阅读原始文档。 Continue reading. 保留 `sourceId` unchanged.", " */"].join(newline)
    )
    const markers = prepared.text.match(/<CTP\d+>/g)!
    assert.throws(() => prepared.restore(prepared.text.replace(markers[0], "")), /marker-mismatch/)
    assert.equal(markers.length, 1, "Continuation decoration still consumed model markers.")
    assert.throws(() => prepared.restore(prepared.text + markers[0]), /marker-mismatch/)
    assert.throws(() => prepared.restore(prepared.text.replace("Continue", "\nContinue")), /structure-invalid/)
  }
  const literal = "/* Compute 2 * 3 and read *this* carefully. */"
  assert.equal(prepareTranslation({ id: "literal", start: 0, end: literal.length, text: literal, format: "text", kind: "comment" }, []).text, "Compute 2 * 3 and read *this* carefully.")
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
  const prepared = prepareTranslation(unit, ["Feature"])
  assert.equal(prepared.restore(prepared.text), unit.text)
  assert.equal(prepared.text, prepareTranslation(unit, []).text)
  assert.ok(prepared.text.includes("Feature"))
  assert.equal(prepared.needsTranslation, true)
  assert.throws(() => prepared.restore(prepared.text + prepared.text), /marker-mismatch/)
  assert.throws(() => prepared.restore("No placeholders survived."), /marker-mismatch/)
  for (const source of ["Feature", "**Feature**", "  - Feature", "> Feature"]) {
    const unit = parseMarkdown(source)
      .groups.flatMap((group) => group.units)
      .at(-1)!
    const body = prepareTranslation(unit, ["Feature"])
    assert.equal(body.needsTranslation, false, source)
    assert.equal(body.restore(body.text), unit.text)
  }
  for (const source of ["Feature.", "feature", "Feature Widget", "Use Feature.", "FeatureWidget"]) {
    const unit = parseMarkdown(source).groups[0].units[0]
    assert.equal(prepareTranslation(unit, ["Feature", "Widget"]).needsTranslation, true, source)
    assert.equal(prepareTranslation(unit, ["Feature", "Widget"]).text, prepareTranslation(unit, []).text)
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
    const prepared = prepareTranslation(unit, ["Feature"])
    assert.equal(prepared.needsTranslation, false)
    assert.equal(prepared.restore(prepared.text), unit.text)
  }
})

test("AI input masks exact protected ranges, including indented CRLF and repeated literal text", () => {
  for (const source of [
    'Use `supersedes` at [guide](https://example.com/private) and <span data-id="private">this label</span>.',
    "  - Use `supersedes` here.\r\n    Keep `members=[]` unchanged.",
    "Read ``code `with` delimiters`` and `a\nb` after 😀.",
    "Read [Feature](Feature), then translate the plain Feature label."
  ]) {
    const unit = { id: "protected", start: 0, end: source.length, text: source, format: "markdown" as const }
    const prepared = prepareTranslation(unit, ["Feature"])
    assert.ok(!prepared.text.includes("supersedes") && !prepared.text.includes("https://example.com/private") && !prepared.text.includes('data-id="private"'))
    assert.ok(!prepared.text.includes("`"), "Protected code reached the AI input instead of an opaque placeholder.")
    assert.equal(prepared.restore(prepared.text), source)
  }
})

test("placeholder namespaces avoid literal source, preserved terms and reference markers and restore them literally", () => {
  const term = "<CTP1_0> $& ${targetLang}"
  const source = "Keep <CTP0> and " + term + " beside `members`."
  const unit = { id: "collision", start: 0, end: source.length, text: source, format: "markdown" as const }
  const context = "Literal <CTP2_0> in reference context."
  const prepared = prepareTranslation(unit, [term], context)
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
      preserveTerms: [],
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
  const prepared = prepareTranslation(unit, [])
  assert.equal(prepared.text, "Read <CTP0>")
  assert.equal(prepared.restore("阅读 <CTP0>"), '"阅读 ${sourceId}\\n"')
  assert.throws(() => prepared.restore("阅读 <CTP10>"), /marker-mismatch/)
  assert.throws(() => prepared.restore("阅读 <CTP0> <CTP0>"), /marker-mismatch/)
})
