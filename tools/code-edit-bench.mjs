import assert from "node:assert/strict"
import { grammar, workloads, grammarFingerprint } from "./code-parsing-bench.mjs"
import { hashText } from "./verify.mjs"

const { CodeTokenizer } = await import("../artifacts/core/documents/tokenization.mjs")
const { extractCode } = await import("../artifacts/core/documents/code.mjs")
const source = workloads[1]
const position = source.indexOf("Read", source.length >>> 1)
const revised = source.slice(0, position) + "View" + source.slice(position + 4)
const tokenizer = new CodeTokenizer(grammar)
await extractCode(source, "python", tokenizer, () => {})

export default {
  id: "product.code-local-edit",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ source, revised, grammar: grammarFingerprint })),
  scenarios: [false, true].map((incremental) => {
    let current = source
    return {
      id: incremental ? "incremental-edit" : "fresh-edit",
      async run() {
        current = current === source ? revised : source
        const units = await extractCode(current, "python", incremental ? tokenizer : new CodeTokenizer(grammar), () => {})
        assert.ok(units.some((unit) => unit.start <= position && unit.end > position && unit.text.includes(current === source ? "Read" : "View")))
        assert.ok(units.every((unit) => unit.text === current.slice(unit.start, unit.end)))
      }
    }
  })
}
