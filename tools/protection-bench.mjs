import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { validTranslation } = await import("../artifacts/core/documents/validation.mjs")
const { prepareTranslation } = await import("../artifacts/core/documents/terms.mjs")
const source = Array.from({ length: 200 }, (_, index) => `**Read field ${index}.** Keep \`sourceId\` and [guide](https://example.com/${index}).`).join("\n\n")
const units = parseMarkdown(source).groups.flatMap((group) => group.units)

export default {
  id: "product.protected-content",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ source, preserveTerms: [], network: false, outcome: "prepare-echo-restore-validate" })),
  scenarios: [
    {
      id: "prepare-restore-validate-200-formatted-units",
      run() {
        for (const unit of units) {
          const prepared = prepareTranslation(unit, [])
          const restored = prepared.restore(prepared.text)
          assert.equal(restored, unit.text)
          assert.equal(validTranslation(unit, restored), true)
        }
      }
    }
  ]
}
