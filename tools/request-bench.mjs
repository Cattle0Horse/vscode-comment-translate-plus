import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"
import manifest from "../package.json" with { type: "json" }

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { prepareInput } = await import("../artifacts/core/translation/prepare.mjs")
const { prepareTranslation } = await import("../artifacts/core/documents/terms.mjs")
const { referenceText } = await import("../artifacts/core/documents/references.mjs")
const { modelRequest, defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames } = await import("../artifacts/core/translation/providers/prompts.mjs")
const source = "# Benchmark guide\n\n" + Array.from({ length: 200 }, (_, index) => `Original paragraph ${index + 1} keeps \`sourceId\` unchanged.`).join("\n\n")
const input = {
  units: parseMarkdown(source)
    .groups.flatMap((group) => group.units)
    .filter((unit) => unit.text.startsWith("Original"))
}
const settings = {
  provider: "openai",
  apiUrl: "http://benchmark.invalid/v1/chat/completions",
  model: "benchmark",
  apiKey: "",
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  systemPrompt: defaultSystemPrompt,
  userPrompt: defaultUserPrompt,
  languageNames: defaultLanguageNames,
  preserveTerms: [],
  skipSameLanguage: false,
  minimumMarkerCharacters: manifest.contributes.configuration.properties["commentTranslatePlus.minimumMarkerCharacters"].default,
  maxItemsPerRequest: 20,
  maxRequestCharacters: 12000,
  maxContextCharacters: 2000,
  maxUnitContextCharacters: 1000,
  maxConcurrentRequests: 2
}

export default {
  id: "product.request-reference-and-prompt-measurement",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ source, settings, units: 200, request: "one-unit-payloads", network: false })),
  scenarios: [
    {
      id: "resolve-reference-and-render-200-single-unit-prompts",
      run() {
        const prepared = prepareInput(settings, input)
        assert.equal(prepared.units.length, 200)
        for (const unit of prepared.units) {
          const original = prepareTranslation(unit, settings.preserveTerms, settings.minimumMarkerCharacters)
          const context = referenceText([{ source: unit, hasMarkers: original.hasMarkers }])
          const item = context.includes("<CTP") ? prepareTranslation(unit, settings.preserveTerms, settings.minimumMarkerCharacters, context) : original
          const { payload } = modelRequest({ settings, context, items: [{ id: unit.id, text: item.text, hasMarkers: item.hasMarkers, format: unit.format }] })
          assert.ok(payload.messages.reduce((sum, message) => sum + message.content.length, 0) <= settings.maxRequestCharacters)
        }
      }
    }
  ]
}
