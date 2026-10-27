import { ModelRetry } from "../src/model/diagnostics.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { validateTranslation } from "../src/documents/validation.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { embeddedMarkdown, inputOf } from "./support/fixtures.ts"
import type { TextUnit } from "../src/model/document.ts"

test("natural-language line boundaries collapse to exactly one space without changing inline spacing or unchanged results", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text = "Read  carefully. \t" + newline + "  \t" + newline + "\tContinue reading."
    const units: TextUnit[] = [
      { id: "plain", start: 0, end: text.length, text, format: "text" as const },
      ...(["comment", "string"] as const).map((kind) => ({ id: kind, start: 0, end: text.length, text, format: "text" as const, kind })),
      inputOf(parseYaml("message: " + JSON.stringify(text))).units[1]
    ]
    for (const unit of units) {
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.text, "Read  carefully. Continue reading.")
      assert.equal(prepared.hasMarkers, false)
      assert.equal(prepared.restore(prepared.text), unit.text)
      const translated = prepared.restore("仔细  阅读。 继续阅读。")
      assert.equal(translated, unit.content === undefined ? "仔细  阅读。 继续阅读。" : JSON.stringify("仔细  阅读。 继续阅读。"))
      assert.equal(validateTranslation(unit, translated), undefined)
      assert.throws(() => prepared.restore("仔细阅读。\n继续阅读。"), /structure-invalid/u)
    }
  }
  const markdown = inputOf(parseMarkdown("Read  carefully.  \n  Continue reading.")).units[0]
  const prepared = prepareTranslation(markdown, 32)
  assert.equal(prepared.text, "Read  carefully. Continue reading.")
  assert.equal(validateTranslation(markdown, prepared.restore("仔细  阅读。 继续阅读。")), undefined)
})

test("documentation prefixes collapse with their line boundary while escapes and interpolation stay protected", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text = ["/**", " * Read `sourceId` carefully.  ", " *", " * Continue reading.", " */"].join(newline)
    const unit = { id: "doc", start: 0, end: text.length, text, format: "text" as const, kind: "comment" as const }
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.text, "Read `sourceId` carefully. Continue reading.")
    assert.equal(prepared.restore(prepared.text), text)
    const translated = prepared.restore("仔细阅读 `sourceId`。 继续阅读。")
    assert.equal(translated, ["/**", " * 仔细阅读 `sourceId`。 继续阅读。", " */"].join(newline))
    assert.equal(validateTranslation(unit, translated), undefined)
    assert.equal(validateTranslation(unit, prepared.restore("仔细阅读。 继续阅读。")), undefined)
    const string = '"""Read \\n carefully.' + newline + '  Continue ${name}."""'
    const literal = prepareTranslation(
      {
        id: "string",
        start: 0,
        end: string.length,
        text: string,
        format: "text",
        kind: "string",
        protected: [
          { start: 0, end: 3 },
          { start: string.length - 3, end: string.length },
          { start: 8, end: 10 }
        ]
      },
      32
    )
    assert.equal(literal.text, "Read \\n carefully. Continue ${name}.")
    assert.equal(literal.restore(literal.text), string)
    assert.throws(() => literal.restore(literal.text.replace("\\n", "")), /structure-invalid/u)
    const code = ["/**", " * Read `code", " * fragment` carefully.", " */"].join(newline)
    const protectedCode = prepareTranslation({ ...unit, text: code, end: code.length }, 32)
    assert.equal(protectedCode.text, code.slice(code.indexOf("Read"), code.lastIndexOf(" carefully.") + " carefully.".length))
    assert.equal(protectedCode.restore(protectedCode.text.replace("Read ", "阅读 ").replace(" carefully.", "。")), code.replace("Read ", "阅读 ").replace(" carefully.", "。"))
  }
})

test("Markdown continuation prefixes fold with prose while paragraph and list boundaries stay structural", () => {
  for (const newline of ["\n", "\r\n"]) {
    const quoted = inputOf(parseMarkdown(["> Read first.", ">   Continue reading."].join(newline))).units[0]
    const prepared = prepareTranslation(quoted, 32)
    assert.equal(prepared.text, "Read first. Continue reading.")
    assert.equal(validateTranslation(quoted, prepared.restore("先阅读。 继续阅读。")), undefined)
    for (const source of ["- Read first." + newline + "- Continue reading.", "Read first." + newline + newline + "Continue reading."]) {
      const unit = { id: "selection", start: 0, end: source.length, text: source, format: "markdown" as const }
      const selection = prepareTranslation(unit, 32)
      const translated = selection.restore(selection.text.replace("Read first.", "先阅读。"))
      assert.equal(validateTranslation(unit, translated), undefined, translated)
      assert.ok(validateTranslation(unit, translated.replaceAll(newline, " ")) instanceof ModelRetry)
    }
  }
})

test("folded prose and scalars preserve nested Markdown containers without guessing translated line positions", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["> ````markdown", "> Read first.", ">   Continue reading.", ">", "> ```yaml", "> message: |-", ">   Read first.", ">   Continue reading.", "> ```", "> ````"].join(
      newline
    )
    const parsed = await embeddedMarkdown(source)
    const translations = new Map<string, string>()
    for (const unit of inputOf(parsed).units) {
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.restore(prepared.text), unit.text)
      const translated = prepared.restore(prepared.text.replace("Read first.", "先阅读。"))
      assert.equal(validateTranslation(unit, translated), undefined, translated)
      translations.set(unit.id, translated)
    }
    const translated = translatedMarkdown(parsed, translations)
    assert.ok(translated.includes("> 先阅读。 Continue reading."))
    assert.ok(translated.includes('> message: "先阅读。 Continue reading.'))
    assert.equal(parsed.source, source)
  }
})
