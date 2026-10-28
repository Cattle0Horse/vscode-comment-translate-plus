import assert from "node:assert/strict"
import { test } from "node:test"
import { INITIAL, type IGrammar } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { pythonStringUnits } from "../src/documents/python.ts"
import { projectionContent } from "../src/documents/projection.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, modelContext, modelFeedback, requestTranslation } from "./support/fixtures.ts"
import type { TextUnit } from "../src/model/document.ts"
import { parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { displayTranslations, translatedMarkdown, translationDisplayText } from "../src/documents/presentation.ts"

// The grammar boundary is TextMate's public token protocol; the desktop suite also uses the real Python grammar.
const grammar = {
  tokenizeLine(line: string, state: typeof INITIAL) {
    const tokens: { startIndex: number; endIndex: number; scopes: string[] }[] = []
    for (const match of line.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
      const start = match.index
      if (!tokens.length && start) tokens.push({ startIndex: 0, endIndex: start, scopes: ["source.python"] })
      tokens.push(
        { startIndex: start, endIndex: start + 1, scopes: ["string.quoted.single.python", "punctuation.definition.string.begin.python"] },
        { startIndex: start + 1, endIndex: start + match[0].length - 1, scopes: ["string.quoted.single.python"] },
        { startIndex: start + match[0].length - 1, endIndex: start + match[0].length, scopes: ["string.quoted.single.python", "punctuation.definition.string.end.python"] }
      )
    }
    if (!tokens.length) tokens.push({ startIndex: 0, endIndex: line.length, scopes: ["source.python"] })
    return { tokens, ruleStack: state, stoppedEarly: false }
  }
} as IGrammar

test("Python source literal sentence endings retain independent requests, display rows and replacement ranges", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const ending of [".", "?", "!", "。", "？", "！"]) {
      const source = ["notice = (", '    "Read the museum catalog' + ending + ' "', '    "Keep the ticket for "', '    "the next exhibition."', ")"].join(newline)
      const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
      const prepared = units.map((unit) => prepareTranslation(unit, 32))
      assert.deepEqual(
        prepared.map((item) => item.text),
        ["Read the museum catalog" + ending, "Keep the ticket for the next exhibition."]
      )
      for (const [index, unit] of units.entries()) {
        assert.equal(source.slice(unit.start, unit.end), unit.text)
        assert.equal(prepared[index].restore(prepared[index].text), unit.text)
      }
      const translated = units.map((unit, index) => ({ ...unit, translation: prepared[index].restore(index === 0 ? "阅读博物馆目录。" : "保留门票供下次展览使用。") }))
      assert.ok(translated.every((unit) => !validateTranslation(unit, unit.translation)))
      assert.equal(displayTranslations(source, translated).length, 2)
      const replacement = source.slice(0, units[0].start) + translated[0].translation + source.slice(units[0].end)
      assert.ok(replacement.includes('"阅读博物馆目录。 "' + newline + '    "Keep the ticket for "'))
    }
  }
})

test("Python adjacent source lines split completed sentences and preserve decoded paragraph breaks", async (t) => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "@catalog_tool(",
      "    description=(",
      '        "Pack/unpack parcels before "',
      '        "visiting. Supports +, -, *, /, parentheses. "',
      '        "Read the map. Keep the ticket. "',
      '        "Compare red/blue labels. "',
      '        "Choose the shelf or "',
      '        "the documented default.\\n\\nReference shelves:\\n"',
      "        + render_shelf_catalog()",
      "    ),",
      ")"
    ].join(newline)
    const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
    const prepared = units.map((unit) => prepareTranslation(unit, 32))
    assert.deepEqual(
      prepared.map((item) => item.text),
      [
        "Pack/unpack parcels before visiting. Supports +, -, *, /, parentheses.",
        "Read the map. Keep the ticket.",
        "Compare red/blue labels.",
        "Choose the shelf or the documented default.",
        "Reference shelves:"
      ]
    )
    let previousEnd = 0
    let restored = source
    for (const [index, unit] of units.entries()) {
      assert.ok(unit.start >= previousEnd)
      previousEnd = unit.end
      assert.equal(source.slice(unit.start, unit.end), unit.text)
      assert.equal(prepared[index].restore(prepared[index].text), unit.text)
      assert.equal(validateTranslation(unit, prepared[index].restore("阅读目录。")), undefined)
    }
    for (let index = units.length - 1; index >= 0; index--) {
      const unit = units[index]
      restored = restored.slice(0, unit.start) + prepared[index].restore("阅读目录。") + restored.slice(unit.end)
    }
    assert.ok(restored.includes("+ render_shelf_catalog()"))
    assert.equal((await extractCode(restored, "python", new CodeTokenizer(grammar), () => {})).length, units.length)
    const translations = ["参观前打包或拆包包裹。支持加法、减法、乘法、除法和括号。", "阅读地图并保留门票。", "比较红色与蓝色标签。", "选择书架或文档规定的默认项。", "参考书架："]
    const fixture = await chatFixture(t, (_body, items) => items.map((item) => translations[prepared.findIndex((entry) => entry.text === item)]).join("\n%%\n"))
    const store = new TranslationStore()
    t.after(() => store.clear())
    const run = () =>
      store.translate(
        "literal-sentences",
        { units },
        (input, signal, completed) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed),
        new AbortController().signal
      )
    const result = await run()
    assert.deepEqual(
      units.map((unit) => projectionContent(unit, result.get(unit.id)!)),
      [translations[0] + " ", translations[1] + " ", translations[2] + " ", translations[3], translations[4]]
    )
    const requests = fixture.seen.length
    assert.deepEqual(await run(), result)
    assert.equal(fixture.seen.length, requests)
    assert.deepEqual(
      fixture.seen.flatMap((request) => request.items),
      prepared.map((item) => item.text)
    )
  }
})

test("Python literal boundaries keep same-line sentences and cross-literal inline syntax together", async () => {
  for (const parts of [
    ['"Read the map. " "Keep the ticket."'],
    ['"Read **the map. "', '"Keep both styled.**"'],
    ['"Read `the map. "', '"Keep both literal.`"'],
    ['"Read [the map. "', '"Keep both linked.](https://example.com)"']
  ]) {
    const source = "notice = (" + parts.join("\n    ") + ")"
    const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
    assert.equal(units.length, 1)
    const prepared = prepareTranslation(units[0], 32)
    assert.equal(prepared.restore(prepared.text), units[0].text)
    assert.equal(validateTranslation(units[0], prepared.restore(prepared.text.replace("Read", "阅读"))), undefined)
  }
})

test("Python source-line sentence boundaries coexist with decoded breaks and escaped literal text", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const [parts, expected] of [
      [['"Read the map. "', '"Keep the ticket."'], ["Read the map. Keep the ticket."]],
      [
        ['"Read the map.\\n"', '"Keep the ticket."'],
        ["Read the map.", "Keep the ticket."]
      ],
      [['"Read the map.\\r\\n\\r\\nKeep the ticket."'], ["Read the map.", "Keep the ticket."]],
      [['"Read the map.\\\\nKeep the ticket."'], ["Read the map.\\nKeep the ticket."]]
    ]) {
      for (const gap of [" ", newline, " \\" + newline]) {
        const source = "notice = (" + parts.join(gap) + ")"
        const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
        assert.deepEqual(
          units.map((unit) => prepareTranslation(unit, 32).text),
          gap.includes("\n") && parts[0] === '"Read the map. "' ? ["Read the map.", "Keep the ticket."] : expected
        )
        for (const unit of units) assert.equal(prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text), unit.text)
      }
    }
  }
  const source = 'r"Read the map.\\n\\nKeep the ticket."'
  const region: TextUnit = { id: "raw-breaks", start: 0, end: source.length, text: source, kind: "string", format: "text", language: "python" }
  const units = pythonStringUnits(source, region, [{ start: 0, end: source.length, protected: [] }])
  assert.equal(units.length, 1)
  assert.equal(prepareTranslation(units[0], 32).text, "Read the map.\\n\\nKeep the ticket.")
  assert.equal(prepareTranslation(units[0], 32).restore(prepareTranslation(units[0], 32).text), units[0].text)
})

test("Python decoded paragraphs share one source-line display block but preserve replacement escapes", async () => {
  for (const escape of ["\\n\\n", "\\r\\n\\r\\n"]) {
    const source = 'notice = "Read the map.' + escape + 'Keep the ticket."'
    const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
    assert.equal(units.length, 2)
    const translations = ["阅读地图。", "保留门票。"]
    const translated = units.map((unit, index) => ({ ...unit, translation: prepareTranslation(unit, 32).restore(translations[index]) }))
    const rows = displayTranslations(source, [...translated].reverse())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].translation, translations.join(escape === "\\n\\n" ? "\n\n" : "\r\n\r\n"))
    assert.equal(rows[0].start, units[0].start)
    assert.equal(rows[0].end, units[1].end)
    for (const part of translated) {
      assert.equal(displayTranslations(source, [part]).length, 1)
      assert.equal(validateTranslation(part, part.translation), undefined)
      const replacement = source.slice(0, part.start) + part.translation + source.slice(part.end)
      assert.ok(replacement.includes(escape))
      assert.ok(!replacement.includes("\n"))
    }
    let replacement = source
    for (const part of [...translated].reverse()) replacement = replacement.slice(0, part.start) + part.translation + replacement.slice(part.end)
    assert.equal(replacement, 'notice = "阅读地图。' + escape + '保留门票。"')
  }
})

test("same-line Python paragraphs retry and cache independently before joining in source order", async (t) => {
  const source = 'notice = "Read /gallery.\\n\\nKeep the ticket."'
  const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
  const fixture = await chatFixture(t, (_body, items, call) =>
    items.map((item) => (item.startsWith("Read") ? (call === 1 ? "阅读画廊。" : "阅读 /gallery。") : "保留门票。")).join("\n%%\n")
  )
  const store = new TranslationStore()
  t.after(() => store.clear())
  const published: string[] = []
  const run = () =>
    store.translate(
      "same-line-paragraphs",
      { units },
      (input, signal, completed) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed),
      new AbortController().signal,
      false,
      (item) => published.push(item.id)
    )
  const result = await run()
  assert.deepEqual(
    fixture.seen.map((request) => request.items),
    [["Read /gallery.", "Keep the ticket."], ["Read /gallery."]]
  )
  assert.deepEqual(published, [units[1].id, units[0].id])
  const [row] = displayTranslations(
    source,
    units.map((unit) => ({ ...unit, translation: result.get(unit.id)! }))
  )
  assert.equal(row.translation, "阅读 /gallery。\n\n保留门票。")
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 2)
})

test("nested Python previews preserve escaped paragraph boundaries while display details decode them", async () => {
  const source = '> ```python\n> notice = "Read the map.\\n\\nKeep the ticket."\n> ```'
  const parsed = await parseMarkdownWithCode(source, async (code, language) => {
    const units = await extractCode(code, language, new CodeTokenizer(grammar), () => {})
    return { source: code, groups: units.map((unit) => ({ start: unit.start, end: unit.end, units: [unit] })), errors: [] }
  })
  const units = parsed.groups.flatMap((group) => group.units)
  const translations = new Map(units.map((unit, index) => [unit.id, prepareTranslation(unit, 32).restore(index === 0 ? "阅读地图。" : "保留门票。")]))
  const [row] = displayTranslations(
    source,
    [...units].reverse().map((unit) => ({ ...unit, translation: translations.get(unit.id)! }))
  )
  assert.equal(
    displayTranslations(
      source,
      units.map((unit) => ({ ...unit, translation: translations.get(unit.id)! }))
    ).length,
    1
  )
  assert.equal(row.translation, "阅读地图。\n\n保留门票。")
  assert.equal(translatedMarkdown(parsed, translations), '> ```python\n> notice = "阅读地图。\\n\\n保留门票。"\n> ```')
})

test("Python multiline f-string prose survives interpolation-only lines and blank paragraphs", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const quote of ['"""', "'''"]) {
      const source = ["def museum_notice():", "    return f" + quote + "Read the museum catalog.", "", "Available exhibits:", "{labels}", "", "Keep the ticket.", quote].join(newline)
      let lineIndex = 0
      const multilineGrammar = {
        tokenizeLine(line: string, state: typeof INITIAL) {
          const scopes = ["source.python", "meta.fstring.python", "string.interpolated.python", "string.quoted.multi.python"]
          const token = (startIndex: number, endIndex: number, scopes: string[]) => ({ startIndex, endIndex, scopes })
          let tokens
          if (lineIndex === 0) tokens = [token(0, line.length, ["source.python"])]
          else if (lineIndex === 1) {
            const start = line.indexOf("f" + quote)
            tokens = [
              token(0, start, ["source.python"]),
              token(start, start + 1, [...scopes, "storage.type.string.python"]),
              token(start + 1, start + 1 + quote.length, [...scopes, "punctuation.definition.string.begin.python"]),
              token(start + 1 + quote.length, line.length, scopes)
            ]
          } else if (line === "{labels}") tokens = [token(0, line.length, ["source.python", "meta.fstring.python"])]
          else if (line === quote) tokens = [token(0, line.length, [...scopes, "punctuation.definition.string.end.python"])]
          else tokens = [token(0, line.length, scopes)]
          lineIndex++
          return { tokens, ruleStack: state, stoppedEarly: false }
        }
      } as IGrammar
      const units = await extractCode(source, "python", new CodeTokenizer(multilineGrammar), () => {})
      const prepared = units.map((unit) => prepareTranslation(unit, 32))
      assert.deepEqual(
        prepared.map((item) => item.text),
        ["Read the museum catalog.", "Available exhibits:", "{labels}", "Keep the ticket."]
      )
      assert.ok(prepared.every((item, index) => item.restore(item.text) === units[index].text))
      let translated = source
      const results = ["阅读博物馆目录。", "可参观的展览：", "{labels}", "保留门票。"]
      for (let index = units.length - 1; index >= 0; index--) {
        const output = prepared[index].restore(results[index])
        assert.equal(validateTranslation(units[index], output), undefined)
        translated = translated.slice(0, units[index].start) + output + translated.slice(units[index].end)
      }
      assert.equal(translated, ["def museum_notice():", "    return f" + quote + results[0], "", results[1], "{labels}", "", results[3], quote].join(newline))
    }
  }
})

test("Python adjacent literal prose sends complete paragraphs without source quote boundaries", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["description = (", '    "Read the museum catalog "', '    "before visiting the gallery.\\n\\nKeep the ticket "', '    "for the next exhibition."', ")"].join(newline)
    const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
    const prepared = units.map((unit) => prepareTranslation(unit, 32))
    assert.deepEqual(
      prepared.map((item) => item.text),
      ["Read the museum catalog before visiting the gallery.", "Keep the ticket for the next exhibition."]
    )
    assert.ok(
      prepared.every((item, index) => item.restore(item.text) === units[index].text),
      "An unchanged paragraph must retain every source byte."
    )
    const results = ["参观画廊前阅读博物馆目录。", "保留门票供下次展览使用。"]
    let restored = source
    for (let index = units.length - 1; index >= 0; index--) restored = restored.slice(0, units[index].start) + prepared[index].restore(results[index]) + restored.slice(units[index].end)
    assert.ok(
      restored.includes('"参观画廊前阅读博物馆目录。\\n\\n保留门票供下次展览使用。"'),
      "Paragraph replacement must remain a valid literal with the original semantic paragraph break."
    )
  }
})

function docstring(body: readonly string[], newline: string, quote = '"""'): { source: string; units: TextUnit[] } {
  const source = ["def read_catalog():", "    " + quote + body[0], ...body.slice(1).map((line) => (line ? "    " + line : "")), "    " + quote].join(newline)
  const start = source.indexOf(quote)
  const region: TextUnit = { id: "docstring", start, end: source.length, text: source.slice(start), format: "text", kind: "string", language: "python" }
  return { source, units: pythonStringUnits(source, region, [{ start, end: source.length, protected: [] }]) }
}

test("Python docstrings fold prose and each list or parameter continuation while retaining structural boundaries", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const quote of ['"""', "'''"]) {
      const { source, units } = docstring(
        [
          "Read the museum catalog.",
          "",
          "Visit the gallery before",
          "collecting the ticket.",
          "",
          "- catalog: Read the shelf",
          "  before choosing a book.",
          "- ticket: Keep the receipt",
          "  until the visit ends.",
          "  1. Read the map",
          "     before entering.",
          "  2. Keep the badge.",
          "",
          "Args:",
          "    shelf: The requested shelf",
          "        inside the gallery.",
          "    limit: The maximum number of books.",
          "",
          "Example:",
          '    read_catalog(shelf="fiction", limit=4)',
          "",
          "Returns:",
          "    The matching books",
          "    from the catalog."
        ],
        newline,
        quote
      )
      const prepared = units.map((unit) => prepareTranslation(unit, 32))
      assert.deepEqual(
        prepared.map((item) => item.text),
        [
          "Read the museum catalog.",
          "Visit the gallery before collecting the ticket.",
          "catalog: Read the shelf before choosing a book.",
          "ticket: Keep the receipt until the visit ends.",
          "Read the map before entering.",
          "Keep the badge.",
          "Args:",
          "shelf: The requested shelf inside the gallery.",
          "limit: The maximum number of books.",
          "Example:",
          "Returns:",
          "The matching books from the catalog."
        ]
      )
      let previousEnd = 0
      for (const [index, unit] of units.entries()) {
        assert.ok(unit.start >= previousEnd && source.slice(unit.start, unit.end) === unit.text, "A prose item overlaps another or owns the wrong source range.")
        previousEnd = unit.end
        assert.equal(prepared[index].restore(prepared[index].text), unit.text)
        const translated = prepared[index].restore(prepared[index].text.replace(/Read|Visit|The/gu, "阅读"))
        assert.equal(validateTranslation(unit, translated), undefined)
      }
      assert.ok(!units.some((unit) => unit.text.includes("read_catalog(shelf=")), "An executable example became translation prose.")
      assert.throws(() => prepared[2].restore("第一条。\n- 新增条目。"), /structure-invalid/u)
    }
  }
})

test("Python paragraph results preserve successful neighbours and reuse the shared cache after one item exhausts attempts", async (t) => {
  const { units } = docstring(["Read the museum catalog.", "", "Visit the gallery before", "collecting the ticket."], "\n")
  const fixture = await chatFixture(t, (_body, items) => {
    return items.map((text) => (text.includes("Read the museum") ? "阅读博物馆目录。" : "参观画廊。\n额外说明。")).join("\n\n%%\n\n")
  })
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = (targets: readonly TextUnit[]) =>
    store.translate(
      "python-prose",
      { units: targets },
      (input, signal, completed) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed),
      new AbortController().signal
    )
  await assert.rejects(run(units), /translation-structure-invalid/u)
  const requests = fixture.seen.length
  assert.equal((await run([units[0]])).get(units[0].id), "阅读博物馆目录。")
  assert.equal(fixture.seen.length, requests, "A completed paragraph was sent again.")
})

test("Python paragraph serialization preserves interpolation, literal braces, escaped data and unlike quote styles", () => {
  for (const parts of [
    ['f"Read {name} and {{shelf}} "', '"before visiting."'],
    ['"Read the catalog "', 'f"before visiting {name}."'],
    ["'Read the catalog '", '"before visiting."'],
    ['r"Read the catalog "', '"before visiting."'],
    ['"Read \\u0041 \\t \\N{SNOWMAN} "', '"before visiting."'],
    ['"Read \\0 \\uD800 "', '"before visiting."']
  ]) {
    const source = "value = (" + parts.join("\n    ") + ")"
    let offset = "value = (".length
    const literals = parts.map((part) => {
      const start = offset
      offset += part.length + 5
      const expression = part.indexOf("{name}")
      return { start, end: start + part.length, protected: expression < 0 ? [] : [{ start: start + expression, end: start + expression + 6 }] }
    })
    const start = literals[0].start
    const end = literals.at(-1)!.end
    const region: TextUnit = { id: "literal", start, end, text: source.slice(start, end), kind: "string", format: "text", language: "python" }
    const [unit] = pythonStringUnits(source, region, literals)
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.restore(prepared.text), unit.text)
    const translated = prepared.restore(prepared.text.replace("Read", "阅读"))
    assert.equal(validateTranslation(unit, translated), undefined)
    assert.equal(projectionContent(unit, translated), unit.projection!.unit.text.replace("Read", "阅读"))
    if (parts.some((part) => part.includes("{name}"))) {
      const restoredSource = source.slice(0, unit.start) + translated + source.slice(unit.end)
      assert.ok(restoredSource.includes('f"') || restoredSource.includes("f'"), "A source interpolation became literal text.")
      assert.throws(() => prepared.restore(prepared.text.replace("{name}", "{other}")), /structure-invalid/u)
    }
    assert.ok(validateTranslation(unit, translated + '"; run_unrelated()'), "An injected literal terminator was accepted.")
  }
})

test("Python paragraph folding inside quoted Markdown fences retains container prefixes and valid source ranges", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["> ```python", "> value = (", '>     "Read the museum catalog "', '>     "before visiting."', "> )", "> ```"].join(newline)
    const parsed = await parseMarkdownWithCode(source, async (text, language) => {
      const units = await extractCode(text, language, new CodeTokenizer(grammar), () => {})
      return { source: text, groups: units.map((unit) => ({ start: unit.start, end: unit.end, units: [unit] })), errors: [] }
    })
    const units = parsed.groups.flatMap((group) => group.units)
    assert.equal(units.length, 1)
    const prepared = prepareTranslation(units[0], 32)
    assert.equal(prepared.text, "Read the museum catalog before visiting.")
    assert.equal(translatedMarkdown(parsed, new Map([[units[0].id, prepared.restore(prepared.text)]])), source)
    const translated = prepared.restore("参观前阅读博物馆目录。")
    assert.equal(validateTranslation(units[0], translated), undefined)
    assert.equal(translatedMarkdown(parsed, new Map([[units[0].id, translated]])), ["> ```python", "> value = (", '>     "参观前阅读博物馆目录。"', "> )", "> ```"].join(newline))
  }
})

test("Repeated f-string expressions belong only to their own paragraphs", () => {
  const source = 'f"Read {name}.\\n\\nVisit {name}."'
  const protectedRanges = [...source.matchAll(/\{name\}/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  const region: TextUnit = { id: "repeated", start: 0, end: source.length, text: source, kind: "string", format: "text", language: "python" }
  const units = pythonStringUnits(source, region, [{ start: 0, end: source.length, protected: protectedRanges }])
  assert.equal(units.length, 2)
  for (const unit of units) {
    const prepared = prepareTranslation(unit, 32)
    const output = prepared.restore(prepared.text.replace(/Read|Visit/gu, "参观"))
    assert.equal(validateTranslation(unit, output), undefined)
    assert.equal(projectionContent(unit, output), "参观 {name}.")
    assert.throws(() => prepared.restore("参观 {name} 和 {name}."), /structure-invalid/u)
  }
})

test("Python string display owns prose only and ends before a closing triple quote", () => {
  for (const quote of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const { source, units } = docstring(["Read the museum catalog.", "", "Returns:", "    The configured catalog reader."], newline, quote)
      const first = units[0]
      const last = units.at(-1)!
      assert.equal(source.slice(first.start - quote.length, first.start), quote)
      assert.ok(!first.text.includes(quote) && !last.text.includes(quote))
      const result = prepareTranslation(last, 32).restore("配置完成的目录读取器。")
      assert.equal(translationDisplayText(result, last.format, last), "        配置完成的目录读取器。")
      const [row] = displayTranslations(source, [{ ...last, translation: result }])
      assert.equal(row.end, source.lastIndexOf(newline + "    " + quote))
      assert.equal(source.slice(row.end), newline + "    " + quote)
      assert.ok(!row.translation.includes(quote), "A display row included its source-language delimiter.")
    }
    const source = quote + "Read the museum catalog." + quote
    const region: TextUnit = { id: "single-line", text: source, start: 0, end: source.length, format: "text", kind: "string", language: "python" }
    const [unit] = pythonStringUnits(source, region, [{ start: 0, end: source.length, protected: [] }])
    const translated = prepareTranslation(unit, 32).restore("阅读博物馆目录。")
    assert.equal(translationDisplayText(translated, unit.format, unit), "阅读博物馆目录。")
    assert.equal(source.slice(0, unit.start) + translated + source.slice(unit.end), quote + "阅读博物馆目录。" + quote)
  }
})

test("Python paragraph recovery excludes distant docstring fields and restores an omitted native path", async (t) => {
  const { units } = docstring(
    [
      "Read the museum catalog.",
      "",
      "Route gallery requests to /archive and send requests outside /archive",
      "to /gallery when visits are allowed.",
      "",
      "Args:",
      "    shelf: A shelf identifier.",
      "    ticket: A visitor ticket.",
      "    language: A catalog language.",
      "    distant_catalog_only: Additional internal metadata.",
      "",
      "Returns:",
      "    The selected gallery."
    ],
    "\n"
  )
  const target = units[1]
  const attempts: string[] = []
  const fixture = await chatFixture(t, (body, items, call) => {
    attempts.push(...items)
    assert.ok(!modelContext(body).includes("distant_catalog_only"), "A paragraph inherited the complete docstring as reference.")
    if (call === 1) return "将目录请求路由至 /archive。\n\n参数：额外参考内容。"
    if (call === 2) return "将 /archive 内外的目录请求路由至 /archive。"
    const feedback = modelFeedback(body)
    assert.ok(feedback.includes("/gallery") && /exactly 1/u.test(feedback), "The corrective request did not identify the missing native path and its required count.")
    return "将目录请求路由至 /archive；允许参观时，将 /archive 之外的请求发送至 /gallery。"
  })
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate(
      "paragraph-path",
      { units: [target] },
      (input, signal, completed) => requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed),
      new AbortController().signal
    )
  const result = await run()
  const translated = result.get(target.id)!
  assert.equal(validateTranslation(target, translated), undefined)
  assert.equal(translated.split("/archive").length - 1, 2)
  assert.equal(translated.split("/gallery").length - 1, 1)
  assert.ok(!translated.includes("额外参考内容"))
  assert.equal(attempts.length, 3)
  assert.ok(attempts.every((text) => text === "Route gallery requests to /archive and send requests outside /archive to /gallery when visits are allowed."))
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 3, "A recovered paragraph was sent again instead of using its cache.")
})
