import assert from "node:assert/strict"
import { build } from "esbuild"
import { mkdir } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { hashText } from "./verify.mjs"
import manifest from "../package.json" with { type: "json" }

await mkdir("artifacts/bench", { recursive: true })
const revision = process.env.CTP_HOT_PATHS_REVISION
await build({
  plugins: revision
    ? [
        {
          name: "revision-sources",
          setup(builder) {
            builder.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, ({ path }) => ({
              contents: execFileSync("git", ["show", revision + ":" + relative(process.cwd(), path).replaceAll("\\", "/")], { encoding: "utf8" }),
              loader: "ts"
            }))
          }
        }
      ]
    : [],
  stdin: {
    contents: [
      'export { protectedFragments } from "./src/documents/protection.ts"',
      'export { prepareTranslation, emptyPreserveTerms } from "./src/documents/terms.ts"',
      'export { pythonStringUnits } from "./src/documents/python.ts"',
      'export { isTargetLanguage } from "./src/documents/languageDetection.ts"',
      'export { BatchPolicy } from "./src/translation/planning.ts"',
      'export { TranslationUnit } from "./src/translation/unit.ts"',
      'export { openai } from "./src/translation/providers/openai.ts"'
    ].join("\n"),
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: "node",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  format: "esm",
  target: "es2022",
  outfile: "artifacts/bench/hot-paths.mjs"
})
const { protectedFragments, prepareTranslation, emptyPreserveTerms, pythonStringUnits, isTargetLanguage, BatchPolicy, TranslationUnit, openai } =
  await import("../artifacts/bench/hot-paths.mjs")
const unit = (text, index = 0) => ({ id: "u" + index, text, start: 0, end: text.length, format: "text" })
const fragments = Array.from({ length: 200 }, (_, index) => unit(`Read [guide](./guide-${index}.md), /catalog/${index} and HTTP/2.`, index))
const languages = Array.from({ length: 200 }, (_, index) => ({ ...unit("这是已经写好的中文说明，不需要再次请求翻译服务。", index), format: "markdown" }))
const expression = "{record.title}"
const pythonSource = 'f"Read ' + expression + " then " + expression + '."'
const pythonRegion = { ...unit(pythonSource), kind: "string", language: "python" }
const expressions = [...pythonSource.matchAll(/\{record.title\}/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
const [python] = pythonStringUnits(pythonSource, pythonRegion, [{ start: 0, end: pythonSource.length, protected: expressions }])
const translatedPython = "阅读 {record.title}，然后阅读 {record.title}。"
const restoredPython = python.projection.codec.restore(translatedPython)
const placeholder = "{summarize_" + "catalog_".repeat(10) + "entries()}"
const repairSource = "Read " + placeholder + "."
const repair = prepareTranslation({ ...unit(repairSource), language: "python", kind: "string", protected: [{ start: 5, end: 5 + placeholder.length }] }, 32)
const truncated = "阅读 " + placeholder.slice(0, -2) + "}。"
const defaults = manifest.contributes.configuration.properties["commentTranslatePlus.service.profiles"].items.properties
const settings = {
  provider: "openai",
  apiUrl: "http://benchmark.invalid",
  model: "benchmark",
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  systemPrompt: defaults.systemPrompt.default,
  userPrompt: defaults.userPrompt.default,
  languageNames: defaults.languageNames.default,
  preserveTerms: emptyPreserveTerms,
  skipSameLanguage: false,
  minimumMarkerCharacters: 32,
  includeContext: true,
  maxItemsPerRequest: 30,
  maxRequestCharacters: 12000,
  maxContextCharacters: 2000,
  batchBySemanticScope: false,
  adaptiveBatching: false
}
const candidates = Array.from(
  { length: 30 },
  (_, index) => new TranslationUnit({ ...unit("Read the catalog entry " + index + ".", index), reference: [], preserved: false }, settings, openai)
)
for (const candidate of candidates) candidate.prepare("")
const policy = new BatchPolicy(settings, openai)

export default {
  id: "product.local-hot-paths",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ fragments, languages, pythonSource, translatedPython, repairSource, truncated, settings, iterations: 200, network: false })),
  scenarios: [
    {
      id: "reused-fragments-200",
      run() {
        for (const item of fragments) assert.ok(protectedFragments(item).length >= 3)
      }
    },
    {
      id: "fresh-fragments-200",
      run() {
        for (const item of fragments) assert.ok(protectedFragments({ ...item }).length >= 3)
      }
    },
    {
      id: "python-serialize-and-validate-200",
      run() {
        for (let index = 0; index < 200; index++) {
          assert.equal(python.projection.codec.restore(translatedPython), restoredPython)
          assert.equal(python.projection.codec.content(restoredPython), translatedPython)
        }
      }
    },
    {
      id: "placeholder-repair-200",
      run() {
        for (let index = 0; index < 200; index++) assert.equal(repair.restore(truncated), "阅读 " + placeholder + "。")
      }
    },
    {
      id: "reused-language-200",
      run() {
        for (const item of languages) assert.equal(isTargetLanguage(item, "zh-CN"), true)
      }
    },
    {
      id: "fresh-language-200",
      run() {
        for (const item of languages) assert.equal(isTargetLanguage({ ...item }, "zh-CN"), true)
      }
    },
    {
      id: "plan-30-items-200-times",
      run() {
        for (let index = 0; index < 200; index++) assert.equal(policy.plan(candidates).units.length, 30)
      }
    }
  ]
}
