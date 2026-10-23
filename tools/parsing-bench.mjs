import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const paragraph = "# Heading\n\n1. Read the original content with `inlineCode`.\n2. Keep [this link](https://example.com) unchanged.\n\n"
const sizes = [10 * 1024, 100 * 1024, 1024 * 1024]
const inputs = sizes.map((size) => paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size))

export default {
  id: "product.markdown-parse-and-raw-context",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ inputs, context: "raw-structural-snippets" })),
  scenarios: inputs.map((source, index) => ({
    id: `parse-and-reference-${sizes[index]}-ascii-bytes`,
    run() {
      const parsed = parseMarkdown(source)
      assert.ok(parsed.groups.length > 0 && parsed.errors.length === 0)
    }
  }))
}
