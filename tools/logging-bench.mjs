import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { TranslationLog } = await import("../artifacts/core/host/logging.mjs")
const source = "Read the complete original paragraph and preserve sourceId. ".repeat(20)
const translation = "阅读完整原始段落并保留 sourceId。".repeat(20)
const secret = "synthetic-benchmark-credential"
const system = "Translate each source item. " + source
const context = { file: "sample.md", name: "fixture", model: "benchmark", targetLanguage: "zh-CN", apiKey: secret, position: (offset) => "sample.md:1:" + (offset + 1) }
const request = {
  kind: "request",
  taskId: "T1",
  requestId: "T1/R1",
  ids: ["one"],
  attempt: 1,
  elapsedMs: 100,
  httpRequests: 1,
  cancelled: false,
  detailsIncluded: true,
  completed: 1,
  failures: [],
  sourceCharacters: source.length,
  contextCharacters: 0,
  inputCharacters: system.length + source.length + secret.length,
  referenceKinds: [],
  batchReason: "待译项已选完",
  modelRequest: {
    model: "benchmark",
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: source + secret }
    ]
  },
  modelResponse: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: translation } }] })
}

export default {
  id: "product.translation-log-format",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ request, context, count: 200, io: false })),
  scenarios: [
    {
      id: "summary-200-task-lifecycles",
      run() {
        let count = 0
        const log = new TranslationLog(() => count++)
        log.configure("info", false)
        for (let index = 0; index < 200; index++) {
          const taskId = "T" + index
          log.record({ kind: "start", taskId, total: 1 }, context)
          log.record({ ...request, taskId, requestId: taskId + "/R1" }, context)
          log.record({ kind: "finish", taskId, status: "complete", total: 1, completed: 1, changed: 1, unchanged: 0, skipped: 0, httpRequests: 1, elapsedMs: 100, failures: [] }, context)
        }
        assert.equal(count, 400)
      }
    },
    ...["info", "warning", "error"].map((level) => ({
      id: level + "-200-detail-requests",
      run() {
        let count = 0
        let definitions = 0
        const log = new TranslationLog((entry) => {
          assert.ok(!entry.includes(secret))
          count++
          if (entry.includes("--- system ")) definitions++
        })
        log.configure(level, true)
        for (let index = 0; index < 200; index++) log.record({ ...request, requestId: "T1/R" + index }, context)
        assert.equal(count, level === "info" ? 200 : 0)
        assert.equal(definitions, level === "info" ? 1 : 0)
      }
    }))
  ]
}
