import { validatedText } from "./support/assertions.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { INITIAL, type IGrammar } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { pythonStringUnits } from "../src/documents/python.ts"
import { projectionContent } from "../src/documents/projection.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { unlikelyTargetLanguage } from "../src/documents/languageDetection.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TextUnit } from "../src/model/document.ts"
import { chatFixture, modelFeedback, requestTranslation } from "./support/fixtures.ts"

function stringGrammar(source: string, expression: string): IGrammar {
  const first = source.indexOf(expression)
  const last = first + expression.length
  const scope = "string.template.js"
  return {
    tokenizeLine(_line: string, state: typeof INITIAL) {
      return {
        ruleStack: state,
        stoppedEarly: false,
        tokens: [
          { startIndex: 0, endIndex: 1, scopes: [scope, "punctuation.definition.string.begin.js"] },
          { startIndex: 1, endIndex: first, scopes: [scope] },
          { startIndex: first, endIndex: last, scopes: [scope, expression.startsWith("${") ? "meta.template.expression.js" : "constant.character.escape.js"] },
          { startIndex: last, endIndex: source.length - 1, scopes: [scope] },
          { startIndex: source.length - 1, endIndex: source.length, scopes: [scope, "punctuation.definition.string.end.js"] }
        ]
      }
    }
  } as IGrammar
}

test("string delimiters stay local when an escape or interpolation touches either end", async () => {
  for (const [source, fragment] of [
    ["`Read ${JSON.stringify(entries)}`", "${JSON.stringify(entries)}"],
    ["`${JSON.stringify(entries)} Read`", "${JSON.stringify(entries)}"],
    ['"Read\\n"', "\\n"],
    ['"\\nRead"', "\\n"]
  ]) {
    const [unit] = await extractCode(source, "javascript", new CodeTokenizer(stringGrammar(source, fragment)), () => {})
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.text, source.slice(1, -1))
    assert.equal(prepared.restore(prepared.text), source)
    const output = prepared.text.replace("Read", "阅读")
    const restored = prepared.restore(output)
    assert.equal(restored, source[0] + output + source.at(-1))
    assert.equal(validateTranslation(unit, restored), undefined)
    assert.throws(() => prepared.restore(output.replace(fragment, "")), /structure-invalid/)
  }
})

test("Python parsed literals recover unique closing suffixes and reject ambiguous or changed expressions", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["notice = (", '  f"Record count ({len(records)} items); "', '  "read the gallery guide."', ")"].join(newline)
    const expr = "{len(records)}"
    const literals = [...source.matchAll(/f?"[^"]*"/gu)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      protected: m[0].includes(expr) ? [{ start: source.indexOf(expr), end: source.indexOf(expr) + expr.length }] : []
    }))
    const region: TextUnit = { id: "python", start: 0, end: source.length, text: source, format: "text", kind: "string", language: "python" }
    const [unit] = pythonStringUnits(source, region, literals)
    const prepared = prepareTranslation(unit, 32)
    for (const [output, expected] of [
      ["条目数：{len(records}。", "条目数：{len(records)}。"],
      ["条目数（{len(records}）项；阅读画廊指南。", "条目数（{len(records)}）项；阅读画廊指南。"]
    ]) {
      const restored = prepared.restore(output)
      assert.equal(projectionContent(unit, restored), expected)
      assert.equal(validateTranslation(unit, restored), undefined)
    }
    for (const output of ["条目数：{len(other}。", "条目数：{len(records}>。", "条目数：{len(records}.changed", "条目数：{len(records} 和 {len(records}。"])
      assert.throws(() => prepared.restore(output), /structure-invalid/)
  }
})

test("multiline comment HTML examples keep their markup through folding and reject tag damage", () => {
  for (const newline of ["\n", "\r\n"])
    for (const heading of [true, false]) {
      const text = [
        ...(heading ? ["* Example usage:"] : []),
        '*   <section data-kind="demo">',
        ' *   <script type="module" src="gallery.js"></script>',
        " *   Logs the sample results."
      ].join(newline)
      const unit: TextUnit = { id: "html", start: 0, end: text.length, text, format: "text", kind: "comment", commentPrefix: "*", language: "javascript" }
      const prepared = prepareTranslation(unit, 32)
      const output = prepared.text.replace("Example usage:", "示例用法：").replace("Logs the sample results.", "记录示例结果。")
      const restored = prepared.restore(output)
      assert.equal(validateTranslation(unit, restored), undefined)
      assert.ok(validateTranslation(unit, restored.replace("section", "article")))
      assert.ok(validateTranslation(unit, restored + " <aside>新增内容</aside>"))
      assert.ok(validateTranslation(unit, restored.replace('data-kind="demo"', 'data-kind="changed"')))
    }
})

test("angle pairs remain prose beside Chinese while real paths remain protected", () => {
  const source = "Draw lines at 30°/150° and 15.5°/75.5°/135.5°."
  const unit = parseMarkdown(source).groups[0].units[0]
  const output = "绘制30°/150°和15.5°/75.5°/135.5°角度的线条。"
  const restored = prepareTranslation(unit, 32).restore(output)
  assert.equal(restored, output)
  assert.equal(validateTranslation(unit, restored), undefined)
  const path = parseMarkdown("Read /gallery/150° and /30°.").groups[0].units[0]
  assert.throws(() => prepareTranslation(path, 32).restore("阅读画廊。"), /structure-invalid/)
})

test("an interpreter directive never becomes a translation unit while neighbouring comments do", async () => {
  const grammar = {
    tokenizeLine(line: string, state: typeof INITIAL) {
      return {
        ruleStack: state,
        stoppedEarly: false,
        tokens: [
          { startIndex: 0, endIndex: 1, scopes: ["comment.line.number-sign.python", "punctuation.definition.comment.python"] },
          { startIndex: 1, endIndex: line.length, scopes: ["comment.line.number-sign.python"] }
        ]
      }
    }
  } as IGrammar
  for (const newline of ["\n", "\r\n"]) {
    const source = ["#!/usr/bin/env python3", "# Read the gallery guide."].join(newline)
    const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
    assert.equal(units.length, 1)
    assert.equal(prepareTranslation(units[0], 32).text, "Read the gallery guide.")
    assert.equal(units[0].text, source.slice(units[0].start, units[0].end))
  }
})

test("explicit Chinese evidence prevents a false Japanese retry and caches the first accepted result", async (t) => {
  const text = "Describe the fictional reading tools and the tasks available to gallery visitors."
  const fixed = "委托合同、子任务生成以及面向读者的阅读工具。"
  assert.equal(unlikelyTargetLanguage(fixed, "zh-CN"), undefined)
  assert.equal(unlikelyTargetLanguage("请。図書館では、来館者が資料を借りる前に受付で手続きを行う必要があります。", "zh-CN")?.language, "ja")
  const fixture = await chatFixture(t, () => fixed)
  const store = new TranslationStore()
  t.after(() => store.clear())
  const unit = parseMarkdown(text).groups[0].units[0]
  const run = () =>
    store.translate(
      "chinese-evidence",
      { units: [unit] },
      (input, signal, complete) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, complete),
      new AbortController().signal
    )
  assert.equal((await run()).get(unit.id), fixed)
  assert.equal((await run()).get(unit.id), fixed)
  assert.equal(fixture.seen.length, 1)
})

test("corrected string and comment paths publish only valid restorations and share their HTTP cache", async (t) => {
  const js = "`Read ${JSON.stringify(entries)}`"
  const [javascript] = await extractCode(js, "javascript", new CodeTokenizer(stringGrammar(js, "${JSON.stringify(entries)}")), () => {})
  const py = 'f"Record count: {len(records)}."'
  const start = py.indexOf("{len(records)}")
  const region: TextUnit = { id: "python-http", start: 0, end: py.length, text: py, format: "text", kind: "string", language: "python" }
  const [python] = pythonStringUnits(py, region, [{ start: 0, end: py.length, protected: [{ start, end: start + "{len(records)}".length }] }])
  const text = '* Example usage:\n *   <section data-kind="demo">\n *   <script type="module" src="gallery.js"></script>\n *   Logs the sample results.'
  const html: TextUnit = { id: "html-http", start: 0, end: text.length, text, format: "text", kind: "comment", commentPrefix: "*", language: "javascript" }
  const units = [javascript, python, html].map((unit, index) => ({ ...unit, id: "http-" + index }))
  const fixture = await chatFixture(t, (_body, items) =>
    items
      .map((item) =>
        item
          .replace("Read", "阅读")
          .replace("Record count:", "条目数：")
          .replace("{len(records)}", "{len(records}")
          .replace("Example usage:", "示例用法：")
          .replace("Logs the sample results.", "记录示例结果。")
      )
      .join("\n%%\n")
  )
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const run = () =>
    store.translate(
      "parsed-log-regressions",
      { units },
      (input, signal, complete) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, complete),
      new AbortController().signal,
      false,
      (item) => published.push(validatedText(item.text))
    )
  const results = await run()
  for (const unit of units) {
    const restored = results.get(unit.id)!
    assert.notEqual(restored, unit.text)
    assert.equal(validateTranslation(unit, validatedText(restored)), undefined)
    assert.ok(published.includes(validatedText(restored)))
  }
  assert.equal(projectionContent(units[1], validatedText(results.get(units[1].id)!)), "条目数： {len(records)}.")
  assert.ok(
    fixture.seen.every((request) => !modelFeedback(request.body)),
    "Valid restorations consumed recovery requests."
  )
  const calls = fixture.seen.length
  assert.deepEqual(await run(), results)
  assert.equal(fixture.seen.length, calls)
})
