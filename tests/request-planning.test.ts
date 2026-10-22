import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { TranslationService } from "../src/translation/engine.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import type { ServiceSettings } from "../src/translation/settings.ts"
import { chatFixture, listBatch, requestTranslation } from "./support/fixtures.ts"

test("partial model failure adjusts learned capacity using the attempted batch, not just the failed remainder", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => items.map((item, index) => (call === 1 && index === 1 ? "" : item)).join("\n%%\n"))
  const input = listBatch(4)
  const settings = { ...fixture.settings, maxConcurrentRequests: 1 }
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  const next = fixture.seen.length
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen[next].items.length, 2, "A single failed item incorrectly collapsed the learned batch capacity to one.")
})

test("a later batch recompiles its measured request when a consumer abandons one of its units", async (t) => {
  let release!: () => void
  let began!: () => void
  const firstRequest = new Promise<void>((resolve) => {
    began = resolve
  })
  const requests: string[][] = []
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[] }
    const items = body.messages.find((message) => message.role === "user")!.content.split("\n\n%%\n\n")
    requests.push(items)
    if (requests.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve
        began()
      })
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: items.join("\n\n%%\n\n") } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const gate = new RequestGate(100, 1)
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    release?.()
    gate.dispose()
    server.close()
    server.closeAllConnections()
  })
  const settings: ServiceSettings = {
    provider: "openai",
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: "mock",
    apiKey: "",
    systemPrompt: "",
    userPrompt: "${content}",
    languageNames: {},
    preserveTerms: [],
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    skipSameLanguage: false,
    maxItemsPerRequest: 2,
    maxRequestCharacters: 12000,
    maxContextCharacters: 0,
    maxUnitContextCharacters: 0,
    adaptiveBatching: false,
    batchBySemanticScope: false,
    initialItemsPerRequest: 2,
    initialRequestCharacters: 6000,
    batchGrowthSuccesses: 3,
    batchGrowthItems: 1,
    batchGrowthFactor: 1.25,
    batchShrinkFactor: 0.5,
    maxTranslationAttempts: 3,
    maxConcurrentRequests: 1
  }
  const units = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    text: `Original paragraph number ${index}.`,
    start: index * 40,
    end: index * 40 + 28,
    format: "text" as const
  }))
  const interests = new Map(units.map((unit) => [unit.id, new AbortController()]))
  const pending = new TranslationService().request(
    settings,
    prepareInput(settings, { units }),
    controller.signal,
    gate,
    undefined,
    undefined,
    new Map([...interests].map(([id, interest]) => [id, interest.signal]))
  )
  await firstRequest
  interests.get("3")!.abort("hover-target-changed")
  release()
  const result = await pending
  assert.deepEqual(
    requests.map((items) => items.length),
    [2, 1, 1]
  )
  assert.ok(!requests.flat().includes(units[3].text), "An abandoned unit remained in the compiled HTTP payload.")
  assert.deepEqual(result.map((item) => item.id).sort(), ["0", "1", "2", "4"])
})
