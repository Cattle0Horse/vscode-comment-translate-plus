import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { parseMarkdown } = await import("../artifacts/core/documents/markdown.mjs")
const { TranslationStore } = await import("../artifacts/core/translation/store.mjs")
const source = Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1} includes \`sourceId\` and [guide](https://example.com).`).join("\n\n")
const input = { units: parseMarkdown(source).groups.flatMap((group) => group.units) }
const batches = Array.from({ length: 10 }, (_, index) => ({ units: input.units.slice(index * 20, index * 20 + 20) }))

function response(batch) {
  return batch.units.map((unit) => ({ id: unit.id, text: unit.text }))
}

async function publish(batch, signal, completed) {
  signal.throwIfAborted()
  for (const unit of batch.units) completed({ id: unit.id, text: unit.text })
  return response(batch)
}

async function fill(store) {
  for (const batch of batches) assert.equal((await store.translate("benchmark", batch, publish, new AbortController().signal)).size, batch.units.length)
}

const warm = new TranslationStore()
await fill(warm)

export default {
  id: "product.translation-cache-validation",
  kind: "product",
  fingerprint: hashText(
    JSON.stringify({ source, units: input.units, groups: batches.map((batch) => batch.units.length), cache: "per-unit", partial: "all-but-final-unit-then-repair", network: false })
  ),
  scenarios: [
    {
      id: "cold-progress-and-validation-200-units",
      async run() {
        const store = new TranslationStore()
        try {
          await fill(store)
        } finally {
          store.clear()
        }
      }
    },
    {
      id: "warm-cache-200-units",
      async run() {
        for (const batch of batches) {
          const result = await warm.translate(
            "benchmark",
            batch,
            () => {
              throw Error("Warm workload unexpectedly requested translation.")
            },
            new AbortController().signal
          )
          assert.equal(result.size, batch.units.length)
        }
      }
    },
    {
      id: "partial-cache-recovery-200-units",
      async run() {
        const store = new TranslationStore()
        try {
          for (const batch of batches) {
            await assert.rejects(
              store.translate(
                "benchmark",
                batch,
                async (request, signal, completed) => {
                  signal.throwIfAborted()
                  for (const unit of request.units.slice(0, -1)) completed({ id: unit.id, text: unit.text })
                  throw Error("translation-structure-invalid")
                },
                new AbortController().signal
              ),
              { message: "translation-structure-invalid" }
            )
            const result = await store.translate(
              "benchmark",
              batch,
              (request, signal, completed) => {
                assert.equal(request.units.length, 1)
                return publish(request, signal, completed)
              },
              new AbortController().signal
            )
            assert.equal(result.size, batch.units.length)
          }
        } finally {
          store.clear()
        }
      }
    }
  ]
}
