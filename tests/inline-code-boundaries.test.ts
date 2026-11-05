import assert from "node:assert/strict"
import { test } from "node:test"
import { inlineCodeProcessor } from "../src/documents/tree.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"

test("inline code removes a complete matched shell while preserving inner backticks and whitespace", () => {
  for (const [text, content] of [
    ["`catalog`", "catalog"],
    ["``catalog`entry``", "catalog`entry"],
    ["`` `catalog` ``", " `catalog` "]
  ])
    assert.equal(inlineCodeProcessor(text)?.content, content)
  for (const text of ["`catalog", "catalog`", "`catalog``", "``catalog`", "`first` and `second`", "````"]) assert.equal(inlineCodeProcessor(text), undefined)
})

test("technical paths in matching code shells validate without accepting changed native content", () => {
  const unit = parseMarkdown("Read /gallery/catalog.md before leaving.").groups[0].units[0]
  const prepared = prepareTranslation(unit, 32)
  for (const ticks of ["`", "``", "```"]) {
    const output = "离开前阅读 " + ticks + "/gallery/catalog.md" + ticks + "。"
    assert.equal(validateTranslation(unit, prepared.restore(output)), undefined)
    assert.throws(() => prepared.restore(output.replace("catalog.md", "other.md")), /structure-invalid/u)
  }
})
