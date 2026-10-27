import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"
import manifest from "../package.json" with { type: "json" }

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { validateTranslation } = await import("../artifacts/core/documents/validation.mjs")
const { prepareTranslation, emptyPreserveTerms } = await import("../artifacts/core/documents/terms.mjs")
const source = Array.from({ length: 200 }, (_, index) => `**Read field ${index}.** Keep \`sourceId\` and [guide](https://example.com/${index}).`).join("\n\n")
const units = parseMarkdown(source).groups.flatMap((group) => group.units)
const minimumMarkerCharacters = manifest.contributes.configuration.properties["commentTranslatePlus.minimumMarkerCharacters"].default

export default {
  id: "product.protected-content",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ source, preserveTerms: emptyPreserveTerms, minimumMarkerCharacters, network: false, outcome: "prepare-echo-restore-validate" })),
  scenarios: [
    {
      id: "prepare-restore-validate-200-formatted-units",
      run() {
        for (const unit of units) {
          const prepared = prepareTranslation(unit, minimumMarkerCharacters)
          const restored = prepared.restore(prepared.text)
          assert.equal(restored, unit.text)
          assert.equal(validateTranslation(unit, restored), undefined)
        }
      }
    }
  ]
}
