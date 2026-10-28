import assert from "node:assert/strict"
import { glob, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import textmate from "vscode-textmate"
import oniguruma from "vscode-oniguruma"
import { hashText } from "./verify.mjs"

const require = createRequire(import.meta.url)
const { Registry, parseRawGrammar } = textmate
const { loadWASM, createOnigScanner, createOnigString } = oniguruma
let grammarPath
for await (const path of glob(".vscode-test/**/extensions/python/syntaxes/MagicPython.tmLanguage.json")) {
  grammarPath = path
  break
}
assert.ok(grammarPath, "Run the official desktop host once to download its Python grammar before benchmarking.")
const grammarSource = await readFile(grammarPath, "utf8")

export const grammarFingerprint = hashText(grammarSource)

await loadWASM(await readFile(require.resolve("vscode-oniguruma/release/onig.wasm")))
const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
  loadGrammar: async () => parseRawGrammar(grammarSource, grammarPath)
})
const loaded = await registry.loadGrammar("source.python")

// The product benchmark bundle has its own TextMate INITIAL singleton.
export const grammar = { tokenizeLine: (line, state, limit) => loaded.tokenizeLine(line, state.ruleId === 0 ? textmate.INITIAL : state, limit) }

const { extractCode } = await import("../artifacts/core/documents/code.mjs")
const { CodeTokenizer } = await import("../artifacts/core/documents/tokenization.mjs")
const paragraph = 'notice = (\n    "Read the museum catalog "\n    "before visiting the gallery.\\n\\nKeep the ticket."\n)\n# Read the original notice.\n# Keep its references.\n'

export const workloads = [16 * 1024, 128 * 1024].map((size) => paragraph.repeat(Math.ceil(size / paragraph.length)))

workloads.push('notice = """' + "Read the museum catalog before visiting the gallery. ".repeat(2000) + '"""')

export default {
  id: "product.code-parsing",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ workloads, grammar: grammarFingerprint })),
  scenarios: workloads.map((source, index) => ({
    id: ["python-16k", "python-128k", "python-long-literal"][index],
    async run() {
      const units = await extractCode(source, "python", new CodeTokenizer(grammar), () => {})
      assert.ok(units.length && units.every((unit) => unit.text === source.slice(unit.start, unit.end)))
    }
  }))
}
