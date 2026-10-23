import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { translationDisplayText, displayTranslations } = await import("../artifacts/core/documents/presentation.mjs")
const { translationIsUnchanged } = await import("../artifacts/core/documents/validation.mjs")
const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const inputs = Array.from({ length: 200 }, (_, index) => "描述" + index + ": |-\n  阅读完整字段并保留所有内容。\n  保留真正的 | 符号和下一行。").map((text) => ({ text, format: "yaml" }))
const comparisons = inputs.map(({ text }) => {
  const unit = parseMarkdown("---\n" + text + "\n---").groups[0].units.find((unit) => unit.text.startsWith("|-"))
  assert.ok(unit)
  return { unit, translated: JSON.stringify(unit.content) }
})
const mixedSource =
  "---\n" +
  Array.from({ length: 200 }, (_, index) => `field${index}: Read value ${index}.`).join("\n") +
  "\n---\n\n| Field | Value |\n| --- | --- |\n" +
  Array.from({ length: 200 }, (_, index) => `| Read value ${index}. | \`id${index}\` |`).join("\n")
const mixedUnits = parseMarkdown(mixedSource)
  .groups.flatMap((group) => group.units)
  .map((unit) => ({
    ...unit,
    translation: unit.content === undefined ? unit.text.replace("Read", "阅读").replace("Field", "字段") : JSON.stringify(unit.content.replace("field", "字段").replace("Read", "阅读"))
  }))

export default {
  id: "product.yaml-display-presentation",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ inputs, comparisons, mixedSource })),
  scenarios: [
    {
      id: "display-and-flatten-200-yaml-fields",
      run() {
        for (const { text, format } of inputs) {
          const displayed = translationDisplayText(text, format).replace(/\s*\r?\n\s*/g, " ")
          assert.ok(displayed.includes("保留真正的 | 符号") && !displayed.includes("|-"))
        }
      }
    },
    {
      id: "compare-200-yaml-representation-only-results",
      run() {
        for (const { unit, translated } of comparisons) assert.equal(translationIsUnchanged(unit, translated), true)
      }
    },
    {
      id: "assemble-200-yaml-fields-and-201-table-rows",
      run() {
        const views = displayTranslations(mixedSource, mixedUnits)
        assert.equal(views.length, 401)
        assert.equal(views.filter((unit) => unit.format === "yaml").length, 200)
        assert.ok(views.filter((unit) => unit.format === "markdown").every((unit) => unit.translation.startsWith("| ") && unit.translation.endsWith(" |")))
      }
    }
  ]
}
