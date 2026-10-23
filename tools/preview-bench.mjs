import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { translatedMarkdown, progressiveMarkdown } = await import("../artifacts/core/documents/presentation.mjs")
const paragraph = "# Heading\n\n1. Read the original content with `inlineCode`.\n2. Keep [this link](https://example.com) unchanged.\n\n"
const sizes = [10 * 1024, 100 * 1024, 1024 * 1024]
const inputs = sizes.map((size) => paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size))
const documents = inputs.map(parseMarkdown)
const translations = documents.map(
  (document) => new Map(document.groups.flatMap((group) => group.units).map((unit) => [unit.id, unit.text.replace("Read ", "阅读 ").replace("Keep ", "保留 ")]))
)
const partial = translations.map((items) => new Map([...items].filter((_, index) => index % 2 === 0)))

export default {
  id: "product.markdown-preview-assemble-and-validate",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ inputs, translations: translations.map((values) => [...values]), partial: "even-index-units" })),
  scenarios: documents.flatMap((document, index) => [
    {
      id: `assemble-and-validate-${sizes[index]}-source-ascii-bytes`,
      run() {
        const result = translatedMarkdown(document, translations[index])
        assert.ok(result.includes("阅读") && result.includes("`inlineCode`"))
      }
    },
    {
      id: `progressive-half-pending-${sizes[index]}-source-ascii-bytes`,
      run() {
        const result = progressiveMarkdown(document, partial[index])
        assert.ok(result.includes('role="progressbar"') && result.includes("`inlineCode`"))
      }
    }
  ])
}
