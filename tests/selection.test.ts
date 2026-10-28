import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareSelection } from "../src/documents/selection.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"

const policy = [
  "- The library opens a small reading room every Saturday morning,",
  "  with illustrated guides and large maps arranged beside the windows;",
  "  A visitor guide lives in `examples/reading`; a shelf map is available",
  "  in `examples/shelves`. Readers can borrow a paper bookmark from the desk",
  "  and return it before the room closes in the afternoon.",
  "- The garden catalog lists flowers by their flowering season and color,",
  "  with a short note on watering each variety. Printed copies are available",
  "  at the front desk for visitors who prefer to read outside."
]

test("sentence-ending lines are separate translation items after ignoring trailing whitespace", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const prefix of ["", "> ", "  "]) {
      const lines = ["Read the catalog.  ", "Keep the ticket.\t ", "Ask the guide?", "Enjoy the gallery!", "Read the next", "section before leaving."]
      const source = lines.map((line) => prefix + line).join(newline)
      const selected = prepareSelection(source, 0, source.length, "markdown", "markdown")
      assert.deepEqual(
        selected.units.map((unit) => prepareTranslation(unit, 32).text),
        ["Read the catalog.", "Keep the ticket.", "Ask the guide?", "Enjoy the gallery!", "Read the next section before leaving."]
      )
      const unchanged = new Map(selected.units.map((unit) => [unit.id, prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text)]))
      assert.equal(selected.restore(unchanged), source)
      const translations = new Map(selected.units.map((unit) => [unit.id, prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text.replace("Read", "阅读"))]))
      assert.equal(
        selected.restore(translations),
        source.replace("Read the catalog.", "阅读 the catalog.").replace("Read the next" + newline + prefix + "section before leaving.", "阅读 the next section before leaving.")
      )
    }
  }
})

test("sentence boundaries retain cross-line inline syntax and distinguish Chinese endings from continuation punctuation", () => {
  for (const newline of ["\n", "\r\n"]) {
    const lines = ["Read the catalog。  ", "Keep the ticket？\t", "Enjoy the gallery！", "Read the next,", "section;", "before leaving.", "**Read the first.", "Keep the style together.**"]
    const source = lines.join(newline)
    const selected = prepareSelection(source, 0, source.length, "markdown", "markdown")
    assert.deepEqual(
      selected.units.map((unit) => unit.text),
      [lines[0].trimEnd(), lines[1].trimEnd(), lines[2], lines.slice(3, 6).join(newline), lines.slice(6).join(newline)]
    )
    const translations = new Map(
      selected.units.map((unit) => {
        const prepared = prepareTranslation(unit, 32)
        const translated = prepared.restore(prepared.text.replaceAll("Read", "阅读"))
        assert.equal(validateTranslation(unit, translated), undefined)
        return [unit.id, translated]
      })
    )
    assert.ok(selected.restore(translations).includes("**阅读 the first. Keep the style together.**"))
  }
})

test("selected shortcut links use definitions outside the selected range", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = "Read [TITLE   guide] and [plain words]."
    const source = [
      "---",
      "notes: |",
      "  [plain words]: https://example.com/yaml",
      "---",
      "# Guide",
      "",
      text,
      "",
      "```md",
      "[plain words]: https://example.com/code",
      "```",
      "",
      "[title guide]: https://example.com"
    ].join(newline)
    const start = source.indexOf(text)
    const selected = prepareSelection(source, start, start + text.length, "markdown", "markdown")
    const unit = selected.units[0]
    const output = "阅读 [TITLE   guide] 和 [普通文字]。"
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.restore(output), output)
    assert.equal(selected.restore(new Map([[unit.id, output]])), output)
    assert.ok(validateTranslation(unit, output.replace("TITLE   guide", "标题指南")))
    assert.throws(() => prepared.restore(output.replace("TITLE   guide", "标题指南")), /structure-invalid/u)
    assert.throws(() => selected.restore(new Map([[unit.id, output.replace("TITLE   guide", "标题指南")]])), /structure-invalid/u)
  }
})

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
      const prepared = prepareTranslation(unit, 32)
      assert.doesNotMatch(prepared.text, /[\r\n]|^[-*+] /u)
      assert.throws(() => prepared.restore(prepared.text + "\nAn extra explanation."), /structure-invalid/u)
      const output = unit === selected.units[0] ? "图书馆指南位于 `examples/reading` 和 `examples/shelves`。" : "花园目录按花期与颜色列出花卉。"
      const restored = prepared.restore(output)
      assert.equal(validateTranslation(unit, restored), undefined)
      translations.set(unit.id, restored)
    }
    assert.equal(selected.restore(translations), "- 图书馆指南位于 `examples/reading` 和 `examples/shelves`。" + newline + "- 花园目录按花期与颜色列出花卉。")
    translations.delete(selected.units[1].id)
    assert.equal(selected.restore(translations), "- 图书馆指南位于 `examples/reading` 和 `examples/shelves`。" + newline + policy.slice(5).join(newline))
    const unchanged = new Map(selected.units.map((unit) => [unit.id, prepareTranslation(unit, 32).restore(prepareTranslation(unit, 32).text)]))
    assert.equal(selected.restore(unchanged), text)
  }
})

test("Markdown selection reassembly keeps numbering, nesting, task state, tables and fences local", () => {
  const source =
    "3. Read the guide.\r\n   - [x] Keep the rule.\r\n\r\n> Read the quote.\r\n>\r\n> Keep the quote.\r\n\r\n| Field | Meaning |\r\n| --- | --- |\r\n| First | Read more. |\r\n\r\n```text\r\nRead this code unchanged.\r\n```"
  const selected = prepareSelection(source, 0, source.length, "markdown", "markdown")
  const translations = new Map(
    selected.units.map((unit) => {
      const prepared = prepareTranslation(unit, 32)
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
      const prepared = prepareTranslation(unit, 32)
      return [unit.id, prepared.restore(prepared.text.replace("selected words continued words.", "选中的文字。").replace("Next item.", "下一项。"))]
    })
  )
  assert.equal(source.slice(0, start) + selected.restore(translations) + source.slice(end), "Before 😀 选中的文字。\r\n- 下一项。 After")
  const plain = prepareSelection(source, start, end, "text", "typescript")
  assert.equal(plain.units.length, 1)
  assert.equal(plain.restore(new Map()), source.slice(start, end))
  assert.equal(plain.restore(new Map([[plain.units[0].id, "译文"]])), "译文")
})
