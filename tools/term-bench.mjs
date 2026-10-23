import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { hashText } from "./verify.mjs"

const modulePath = process.env.CTP_TERMS_BENCH_MODULE
const { parsePreserveTerms, prepareTranslation } = modulePath ? createRequire(import.meta.url)(resolve(modulePath)) : await import("../artifacts/core/documents/terms.mjs")
const entries = [...Array.from({ length: 5000 }, (_, index) => "Product" + index), { pattern: "HTTP(?:S)?", flags: "i" }]
const compiled = parsePreserveTerms(entries)
const units = Array.from({ length: 1000 }, (_, index) => {
  const text = index % 3 === 0 ? "Product4999" : index % 3 === 1 ? "Unknown product name." : "hTtPs"
  return { id: "u" + index, text, start: 0, end: text.length, format: "text" }
})

export default {
  id: "product.preserve-term-matching",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ entries, units, minimumMarkerCharacters: 32, network: false })),
  scenarios: [
    {
      id: "prepare-1000-units-5000-literals-one-regex",
      run() {
        for (const [index, unit] of units.entries()) assert.equal(prepareTranslation(unit, compiled, 32).needsTranslation, index % 3 === 1)
      }
    }
  ]
}
