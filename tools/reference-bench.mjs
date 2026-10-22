import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { sourceReferences, referenceText } = await import("../artifacts/core/documents/references.mjs")
const code = Array.from({ length: 200 }, (_, index) => `// Read original ${index}.\nconst value${index} = "Original text ${index}.";`).join("\n")
const codeUnits = [...code.matchAll(/Original text \d+\./g)].map((match, index) => {
  const unit = { id: "u" + index, text: match[0], start: match.index, end: match.index + match[0].length, format: "text" }
  return { source: { ...unit, reference: sourceReferences(code, unit, "typescript") }, hasMarkers: false }
})
const markdown = "# Guide\n\n" + Array.from({ length: 100 }, (_, index) => `## Section ${index}\n\n- Parent ${index}.\n  - Child ${index}.\n    - Target ${index}.\n\n`).join("")
const markdownUnits = parseMarkdown(markdown)
  .groups.flatMap((group) => group.units)
  .filter((unit) => unit.text.includes("Target"))
  .map((source) => ({ source, hasMarkers: false }))

export default {
  id: "product.source-and-structural-reference-merge",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ code, markdown, groups: 20 })),
  scenarios: [
    {
      id: "merge-200-overlapping-code-windows",
      run() {
        assert.ok(referenceText(codeUnits).includes("Original text 199."))
      }
    },
    {
      id: "merge-100-list-ancestries-in-five-unit-requests",
      run() {
        for (let index = 0; index < markdownUnits.length; index += 5) assert.ok(referenceText(markdownUnits.slice(index, index + 5)).includes("# Guide"))
      }
    }
  ]
}
