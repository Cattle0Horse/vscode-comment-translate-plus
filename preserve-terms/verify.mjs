import { build } from "esbuild"
import { readFile, writeFile, readdir, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import assert from "node:assert/strict"

const root = fileURLToPath(new URL("./", import.meta.url))
const buildResult = await build({
  stdin: {
    contents: 'export { parsePreserveTerms } from "../src/documents/terms.ts"',
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false
})
await writeFile(new URL("parser-check.cjs", import.meta.url), buildResult.outputFiles[0].text)
const { parsePreserveTerms } = createRequire(import.meta.url)("./parser-check.cjs")
await unlink(new URL("parser-check.cjs", import.meta.url))
const checked = []
const paths = ["../resources/preserve-terms.json", "../resources/preserve-terms.full.json", ...(await readdir(new URL("candidates/", import.meta.url))).map((name) => "candidates/" + name)]
for (const path of paths) {
  const terms = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))
  assert.equal(new Set(terms.map((term) => JSON.stringify(term))).size, terms.length)
  const parsed = parsePreserveTerms(terms)
  assert.deepEqual(parsed.literals, new Set(terms.filter((term) => typeof term === "string").map((term) => term.toLowerCase())))
  assert.equal(parsed.expressions.length, terms.filter((term) => typeof term !== "string").length)
  if (path.startsWith("../resources/") || path === "candidates/selected.json") assert.equal(parsed.literals.size + parsed.expressions.length, terms.length, `Duplicate rules in ${path}`)
  checked.push({ path, accepted: terms.length })
}
const curated = JSON.parse(await readFile(new URL("../resources/preserve-terms.json", import.meta.url), "utf8"))
const full = JSON.parse(await readFile(new URL("../resources/preserve-terms.full.json", import.meta.url), "utf8"))
const candidates = JSON.parse(await readFile(new URL("candidates/all.json", import.meta.url), "utf8"))
const additions = JSON.parse(await readFile(new URL("additions.json", import.meta.url), "utf8"))
const fullRules = parsePreserveTerms(full)
for (const term of [...curated, ...candidates, ...additions]) {
  const parsed = parsePreserveTerms([term])
  for (const literal of parsed.literals) assert.ok(fullRules.literals.has(literal), `Rule missing from full list: ${JSON.stringify(term)}`)
  for (const expression of parsed.expressions) assert.ok(fullRules.expressions.some((rule) => rule.source === expression.source && rule.flags === expression.flags))
}
const curatedRules = parsePreserveTerms(curated)
for (const term of ["tools", "ADMIN", "BTN", "REF", "go", "rust", "swift", "make", "less", "expect", "Feature", "Settings", "string", "Token", "token"]) {
  assert.equal(curatedRules.literals.has(term.toLowerCase()), false, `Ambiguous term selected: ${term}`)
}
for (const term of ["tools", "make", "less"]) assert.ok(fullRules.literals.has(term), `Ordinary word missing from full list: ${term}`)
const generated = [...paths, "manifest.json", "provenance.json", "review.json"]

async function contents() {
  return Promise.all(generated.map((path) => readFile(new URL(path, import.meta.url))))
}

const before = await contents()
execFileSync(process.execPath, [fileURLToPath(new URL("collect.mjs", import.meta.url)), "--offline"], { cwd: root, stdio: "pipe" })
assert.deepEqual(await contents(), before)
const result = { currentParserAccepted: checked, offlineRegenerationIdentical: true, semanticReview: "两份词库均未进行逐项翻译质量验收；full 包含普通词，需按领域选用" }
await writeFile(new URL("verification.json", import.meta.url), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
