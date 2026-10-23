import assert from "node:assert/strict"
import { resolve } from "node:path"
import { createRequire } from "node:module"
import { hashText } from "./verify.mjs"

const implementation = process.env.CTP_EXECUTION_BENCH_MODULE
const { TranslationService } = implementation ? createRequire(import.meta.url)(resolve(implementation)) : await import("../artifacts/core/translation/engine.mjs")
const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const source = Array.from({ length: 200 }, (_, index) => `Original paragraph ${index + 1} keeps \`sourceId\` unchanged.`).join("\n\n")
const input = {
  units: parseMarkdown(source)
    .groups.flatMap((group) => group.units)
    .map((unit) => ({ ...unit, reference: [] }))
}
const settings = {
  provider: "openai",
  apiUrl: "http://benchmark.invalid/v1/chat/completions",
  model: "benchmark",
  apiKey: "",
  systemPrompt: "Translate into Chinese. Separate items with ${separator} on its own line.",
  userPrompt: "${content}",
  languageNames: {},
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  preserveTerms: [],
  skipSameLanguage: false,
  maxItemsPerRequest: 20,
  maxRequestCharacters: 12000,
  maxContextCharacters: 0,
  maxUnitContextCharacters: 0,
  adaptiveBatching: true,
  batchBySemanticScope: true,
  initialItemsPerRequest: 5,
  initialRequestCharacters: 6000,
  batchGrowthSuccesses: 3,
  batchGrowthItems: 1,
  batchGrowthFactor: 1.25,
  batchShrinkFactor: 0.5,
  maxTranslationAttempts: 3,
  maxConcurrentRequests: 2
}

// This deterministic, in-process transport measures execution overhead, not service latency.
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body)
  const text = body.messages.find((message) => message.role === "user").content.replaceAll("Original", "译文")
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }))
}

async function translate(service) {
  const gate = {
    run(work, signal) {
      signal.throwIfAborted()
      return work()
    }
  }
  const results = await service.request(settings, input, new AbortController().signal, gate)
  assert.equal(results.length, 200)
  assert.ok(results.every((item) => item.text.includes("译文") && item.text.includes("`sourceId`")))
}

const learned = new TranslationService()
await translate(learned)

export default {
  id: "product.translation-execution-and-batch-policy",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ source, settings, transport: "in-process-deterministic", units: 200 })),
  scenarios: [
    {
      id: "cold-execution-200-protected-units",
      async run() {
        await translate(new TranslationService())
      }
    },
    {
      id: "learned-batch-execution-200-protected-units",
      async run() {
        await translate(learned)
      }
    }
  ]
}
