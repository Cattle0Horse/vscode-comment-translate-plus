import assert from "node:assert/strict"
import { test } from "node:test"
import { INITIAL, type IGrammar } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"
import { parseYaml, assertYamlStructure } from "../src/documents/yaml.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { displayTranslations } from "../src/documents/presentation.ts"
import { validateTranslation } from "../src/documents/validation.ts"

test("YAML block values keep sentence rows, continuation folding and exact unchanged source", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const marker of ["|", ">", "|-", ">+"]) {
      const source = ["notice: " + marker, "  Read the catalog.  ", "  Keep the ticket！\t", "  Read the next", "  section before leaving.", "active: true", ""].join(newline)
      const units = parseYaml(source).groups.flatMap((group) => group.units)
      const parts = units.filter((unit) => unit.projection)
      assert.deepEqual(
        parts.map((unit) => prepareTranslation(unit, 32).text),
        ["Read the catalog.", "Keep the ticket！", "Read the next section before leaving."]
      )
      let output = source
      const translated = parts.map((unit) => {
        const prepared = prepareTranslation(unit, 32)
        assert.equal(prepared.restore(prepared.text), unit.text)
        const translation = prepared.restore(prepared.text.replaceAll("Read", "阅读").replaceAll("Keep", "保留"))
        assert.equal(validateTranslation(unit, translation), undefined)
        return { ...unit, translation }
      })
      for (const unit of [...translated].reverse()) output = output.slice(0, unit.start) + unit.translation + output.slice(unit.end)
      assertYamlStructure(source, output)
      assert.ok(output.startsWith("notice: " + marker + newline + "  阅读 the catalog.  " + newline))
      const rows = displayTranslations(source, translated)
      assert.equal(rows.length, 3)
      assert.ok(rows.every((row) => !row.translation.includes(marker) && !row.translation.includes("notice:")))
      assert.throws(() => prepareTranslation(parts[0], 32).restore("Changed.\nactive: false"), /structure-invalid/)
    }
  }
})

function multilineGrammar(kind: "comment" | "string"): IGrammar {
  return {
    tokenizeLine(line: string, state: typeof INITIAL) {
      const scope = kind === "comment" ? "comment.block.fixture" : "string.template.fixture"
      const tokens = [...line.matchAll(/\/\*|\*\/|`|[^`]+/gu)].map((match) => ({
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        scopes: [
          scope,
          ...(line.trim() === "catalog." ? ["meta.template.expression.fixture"] : []),
          ...(match[0] === "/*" || match[0] === "*/" || match[0] === "`" ? ["punctuation.definition." + kind + ".fixture"] : [])
        ]
      }))
      return { tokens, ruleStack: state, stoppedEarly: false }
    }
  } as IGrammar
}

test("multiline code prose retains sentence display rows and cross-line comment styles", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const kind of ["comment", "string"] as const) {
      const source = (
        kind === "comment"
          ? ["/*", "Read the catalog.  ", "Keep the ticket?", "Read the next", "section before leaving.", "*/"]
          : ["`", "Read the catalog.  ", "Keep the ticket?", "Read the next", "section before leaving.", "`"]
      ).join(newline)
      const units = await extractCode(source, "fixture", new CodeTokenizer(multilineGrammar(kind)), () => {})
      assert.deepEqual(
        units.map((unit) => prepareTranslation(unit, 32).text),
        ["Read the catalog.", "Keep the ticket?", "Read the next section before leaving."]
      )
      const translations = units.map((unit) => {
        const prepared = prepareTranslation(unit, 32)
        assert.equal(prepared.restore(prepared.text), unit.text)
        const translation = prepared.restore(prepared.text.replaceAll("Read", "阅读").replaceAll("Keep", "保留"))
        assert.equal(validateTranslation(unit, translation), undefined)
        return { ...unit, translation }
      })
      assert.equal(displayTranslations(source, translations).length, 3)
    }
    const styled = ["/*", "**Read the first.", "Keep both styled.**", "Read the last.", "*/"].join(newline)
    const units = await extractCode(styled, "fixture", new CodeTokenizer(multilineGrammar("comment")), () => {})
    assert.equal(units.length, 1)
    assert.equal(prepareTranslation(units[0], 32).restore(prepareTranslation(units[0], 32).text), units[0].text)
  }
})

test("grammar-owned punctuation inside a multiline interpolation does not create a sentence unit", async () => {
  const source = ["`Read ${", "catalog.", "title} carefully.", "Keep the ticket.`"].join("\n")
  const units = await extractCode(source, "fixture", new CodeTokenizer(multilineGrammar("string")), () => {})
  assert.equal(units.length, 2)
  assert.ok(units[0].text.includes("catalog.\ntitle}"))
  for (const unit of units) {
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.restore(prepared.text), unit.text)
  }
})
