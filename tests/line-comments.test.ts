import assert from "node:assert/strict"
import { test } from "node:test"
import { INITIAL, type IGrammar } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation, translationIsUnchanged } from "../src/documents/validation.ts"
import { displayTranslations, translatedMarkdown } from "../src/documents/presentation.ts"
import { parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { BrowseSession } from "../src/features/browse/session.ts"
import { settled } from "./support/fixtures.ts"

// Exercise TextMate's public line-token boundary; the desktop suite uses installed grammars.
function lineGrammar(marker: string, punctuation = true): IGrammar {
  return {
    tokenizeLine(line: string, state: typeof INITIAL) {
      const start = line.indexOf(marker)
      const scope = "comment.line.fixture"
      const tokens =
        start < 0
          ? [{ startIndex: 0, endIndex: line.length, scopes: ["source.fixture"] }]
          : [
              { startIndex: 0, endIndex: start, scopes: ["source.fixture"] },
              { startIndex: start, endIndex: start + marker.length, scopes: punctuation ? [scope, "punctuation.definition.comment.fixture"] : [scope] },
              { startIndex: start + marker.length, endIndex: line.length, scopes: [scope] }
            ]
      return { tokens, ruleStack: state, stoppedEarly: false }
    }
  } as IGrammar
}

test("consecutive standalone line comments form one paragraph with local syntax and exact unchanged restoration", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const marker of ["//", "///", "#", "--", ";"]) {
      const source = [
        "  " + marker + " Read the museum catalog",
        "  " + marker + " before visiting the gallery.",
        "  " + marker,
        "  " + marker + " Keep the ticket.",
        "const end = 1;"
      ].join(newline)
      const units = await extractCode(source, "fixture", new CodeTokenizer(lineGrammar(marker)), () => {})
      assert.equal(units.length, 2)
      const prepared = prepareTranslation(units[0], 32)
      assert.equal(prepared.text, "Read the museum catalog before visiting the gallery.")
      assert.equal(prepared.restore(prepared.text), units[0].text)
      const translated = prepared.restore("参观画廊前阅读博物馆目录。")
      assert.equal(translated, marker + " 参观画廊前阅读博物馆目录。")
      assert.equal(validateTranslation(units[0], translated), undefined)
      assert.equal(translationIsUnchanged(units[0], marker + " Read the museum catalog before visiting the gallery."), true)
      assert.ok(validateTranslation(units[0], "uncommented executable text"))
      assert.throws(() => prepared.restore("参观画廊前阅读目录。\nInjected code."), /structure-invalid/)
      const rows = displayTranslations(source, [{ ...units[0], translation: translated }])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].end, source.indexOf("gallery.") + "gallery.".length)
    }
  }
})

test("sentence endings split adjacent comments after ignoring trailing whitespace", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["// Read the catalog.  ", "// Keep the ticket.\t", "// Read the next", "// section before leaving."].join(newline)
    const units = await extractCode(source, "fixture", new CodeTokenizer(lineGrammar("//")), () => {})
    assert.deepEqual(
      units.map((unit) => prepareTranslation(unit, 32).text),
      ["Read the catalog.", "Keep the ticket.", "Read the next section before leaving."]
    )
  }
})

test("blank lines, code, inline comments, indentation and marker changes separate comment paragraphs", async () => {
  const lines = ["// First.", "", "// Second.", "const value = 1; // Inline.", "// Third.", "  // Indented.", "// Fourth.", "/// Documentation.", "/// Continuation."]
  const grammar = lineGrammar("//")
  const units = await extractCode(lines.join("\n"), "fixture", new CodeTokenizer(grammar), () => {})
  assert.deepEqual(
    units.map((unit) => prepareTranslation(unit, 32).text),
    ["First.", "Second.", "Inline.", "Third.", "Indented.", "Fourth.", "Documentation.", "Continuation."]
  )
  const rust = await extractCode("/// Read the catalog\n/// before entering.", "rust", new CodeTokenizer(lineGrammar("///", false)), () => {})
  assert.equal(rust.length, 1)
  assert.equal(prepareTranslation(rust[0], 32).text, "Read the catalog before entering.")
})

test("decorative comment separators stay outside translated paragraphs and preserve their source positions", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const marker of ["#", "//", "///", "--", ";"]) {
      for (const separator of ["-----------", "===========", "* * *", "─━─━─"]) {
        const source = [
          marker + " Keep the ticket.",
          marker + " " + separator,
          marker + " Gallery guide",
          marker + " " + separator,
          marker + " Read the catalog",
          marker + " before entering."
        ].join(newline)
        const units = await extractCode(source, "fixture", new CodeTokenizer(lineGrammar(marker)), () => {})
        assert.deepEqual(
          units.map((unit) => prepareTranslation(unit, 32).text),
          ["Keep the ticket.", "Gallery guide", "Read the catalog before entering."]
        )
        const title = units[1]
        const translation = prepareTranslation(title, 32).restore("画廊指南")
        assert.equal(validateTranslation(title, translation), undefined)
        const rows = displayTranslations(source, [{ ...title, translation }])
        assert.equal(rows.length, 1)
        assert.equal(rows[0].start, source.indexOf(marker + " Gallery guide"))
        assert.equal(rows[0].end, title.end)
        assert.equal(source.slice(title.start, title.end), marker + " Gallery guide")
      }
    }
  }
})

test("comment paragraphs share edit invalidation and keep neighbouring paragraphs displayed", async () => {
  const source = "// Read the catalog\n// before entering.\n//\n// Keep the ticket."
  const grammar = lineGrammar("//")
  const units = await extractCode(source, "fixture", new CodeTokenizer(grammar), () => {})
  const session = new BrowseSession(
    async (input) => new Map(input.units.map((unit) => [unit.id, "// 译文：" + prepareTranslation(unit, 32).text])),
    () => {}
  )
  session.update({ source, groups: units.map((unit) => ({ ...unit, units: [unit] })), errors: [] }, 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await settled(session)
  session.invalidate(2, [{ rangeOffset: source.indexOf("entering"), rangeLength: 0, text: "x" }])
  assert.deepEqual(
    session.inspect().units.map((unit) => unit.text),
    ["// Keep the ticket."]
  )
  assert.equal(session.inspect().loading.length, 0)
  session.dispose()
})

test("quoted Markdown code fences collapse comment prose while preserving the outer container and syntax", async () => {
  const source = "> ```typescript\n> // Read the catalog\n> // before entering.\n> ```"
  const parsed = await parseMarkdownWithCode(source, async (source, language) => {
    const units = await extractCode(source, language, new CodeTokenizer(lineGrammar("//")), () => {})
    return { source, groups: units.map((unit) => ({ ...unit, units: [unit] })), errors: [] }
  })
  const units = parsed.groups.flatMap((group) => group.units)
  assert.equal(units.length, 1)
  const prepared = prepareTranslation(units[0], 32)
  assert.equal(prepared.text, "Read the catalog before entering.")
  assert.equal(prepared.restore(prepared.text), units[0].text)
  const translated = prepared.restore("进入前阅读目录。")
  assert.equal(validateTranslation(units[0], translated), undefined)
  assert.equal(translatedMarkdown(parsed, new Map([[units[0].id, translated]])), "> ```typescript\n> // 进入前阅读目录。\n> ```")
})
