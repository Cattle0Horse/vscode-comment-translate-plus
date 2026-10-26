import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareSelection } from "../src/documents/selection.ts"
import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"

const policy = [
  "- Analytical delivery policy uses a lightweight task brief, evidence-aware handoffs,",
  "  task-specific computation with reused metrics, and checks against the original",
  "  request. Detailed report guidance lives in `coordinator/writing`; generic",
  "  alignment and delivery checks live in `coordinator/base`. Research scheduling",
  "  and search budgets remain governed by their existing rules.",
  "- Markdown reports use standard footnotes with reusable source IDs and linked",
  "  source metadata/locations. Brief conversational answers may use inline links;",
  "  unlinked numeric or research-batch markers are not report citations."
]

test("multiline Markdown selections translate list bodies separately and retain source-owned block separators", () => {
  for (const newline of ["\r\n", "\n"]) {
    const text = policy.join(newline)
    const source = "# Outside 😀" + newline + newline + text + newline + newline + "Untouched neighbour."
    const start = source.indexOf(text)
    const selected = prepareSelection(source, start, start + text.length, "markdown", "markdown")
    assert.equal(selected.units.length, 2)
    const translations = new Map<string, string>()
    for (const unit of selected.units) {
      assert.equal(source.slice(unit.start, unit.end), unit.text)
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.doesNotMatch(prepared.text, /[\r\n]|^[-*+] /u)
      assert.throws(() => prepared.restore(prepared.text + "\nAn extra explanation."), /structure-invalid/u)
      const output = unit === selected.units[0] ? "分析交付策略位于 `coordinator/writing` 和 `coordinator/base`。" : "Markdown 报告使用标准脚注。"
      const restored = prepared.restore(output)
      assert.equal(validateTranslation(unit, restored), undefined)
      translations.set(unit.id, restored)
    }
    assert.equal(selected.restore(translations), "- 分析交付策略位于 `coordinator/writing` 和 `coordinator/base`。" + newline + "- Markdown 报告使用标准脚注。")
    translations.delete(selected.units[1].id)
    assert.equal(selected.restore(translations), "- 分析交付策略位于 `coordinator/writing` 和 `coordinator/base`。" + newline + policy.slice(5).join(newline))
    const unchanged = new Map(selected.units.map((unit) => [unit.id, prepareTranslation(unit, emptyPreserveTerms, 32).restore(prepareTranslation(unit, emptyPreserveTerms, 32).text)]))
    assert.equal(selected.restore(unchanged), text)
  }
})

test("Markdown selection reassembly keeps numbering, nesting, task state, tables and fences local", () => {
  const source =
    "3. Read the guide.\r\n   - [x] Keep the rule.\r\n\r\n> Read the quote.\r\n>\r\n> Keep the quote.\r\n\r\n| Field | Meaning |\r\n| --- | --- |\r\n| First | Read more. |\r\n\r\n```text\r\nRead this code unchanged.\r\n```"
  const selected = prepareSelection(source, 0, source.length, "markdown", "markdown")
  const translations = new Map(
    selected.units.map((unit) => {
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      const translated = prepared.restore(
        prepared.text.replaceAll("Read", "阅读").replaceAll("Keep", "保留").replaceAll("Field", "字段").replaceAll("Meaning", "含义").replaceAll("First", "第一")
      )
      assert.equal(validateTranslation(unit, translated), undefined)
      return [unit.id, translated]
    })
  )
  assert.equal(
    selected.restore(translations),
    source
      .replaceAll("Read", "阅读")
      .replaceAll("Keep", "保留")
      .replaceAll("Field", "字段")
      .replaceAll("Meaning", "含义")
      .replaceAll("First", "第一")
      .replace("阅读 this code unchanged.", "Read this code unchanged.")
  )
  translations.set(selected.units[0].id, "3. Changed.\n4. Injected item.")
  assert.throws(() => selected.restore(translations), /structure-invalid/u)
})

test("partial Markdown selections stay inside their captured range and non-Markdown selections remain one text item", () => {
  const source = "Before 😀 selected words\r\n  continued words.\r\n- Next item. After"
  const start = source.indexOf("selected")
  const end = source.indexOf(" After")
  const selected = prepareSelection(source, start, end, "markdown", "markdown")
  const translations = new Map(
    selected.units.map((unit) => {
      assert.ok(unit.start >= start && unit.end <= end)
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      return [unit.id, prepared.restore(prepared.text.replace("selected words continued words.", "选中的文字。").replace("Next item.", "下一项。"))]
    })
  )
  assert.equal(source.slice(0, start) + selected.restore(translations) + source.slice(end), "Before 😀 选中的文字。\r\n- 下一项。 After")
  const plain = prepareSelection(source, start, end, "text", "typescript")
  assert.equal(plain.units.length, 1)
  assert.equal(plain.restore(new Map()), source.slice(start, end))
  assert.equal(plain.restore(new Map([[plain.units[0].id, "译文"]])), "译文")
})
