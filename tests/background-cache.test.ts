import assert from "node:assert/strict"
import { test } from "node:test"
import { TranslationStore, memoryCacheMaxEntries } from "../src/translation/store.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { chatFixture } from "./support/fixtures.ts"
import { prepareInput } from "../src/translation/prepare.ts"

function input(count: number, prefix = "Source"): TranslationInput {
  return { units: Array.from({ length: count }, (_, index) => ({ id: String(index), start: 0, end: 20, text: prefix + " paragraph " + index + ".", format: "text" as const })) }
}

const echo: Parameters<TranslationStore["translate"]>[2] = async (input, _signal, _accept, _interests, _priority, admit) => {
  admit(input.units.map((unit) => unit.id))
  return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
}

function background(store: TranslationStore, value: TranslationInput, action = echo) {
  return store.translate("identity", value, action, new AbortController().signal, false, undefined, undefined, undefined, () => 3, true)
}

test("full memory permits hits but refuses new background requests without evicting earlier translations", async (t) => {
  const store = new TranslationStore()
  t.after(() => store.clear())
  const value = input(memoryCacheMaxEntries)
  await store.translate("identity", value, echo, new AbortController().signal)
  const offline = () => assert.fail("A completed unit was requested again.")
  assert.equal((await background(store, value, offline)).size, memoryCacheMaxEntries)
  await assert.rejects(background(store, input(1, "Missing")), /background-cache-full-memory/)
  assert.equal((await background(store, value, offline)).size, memoryCacheMaxEntries)
  await store.translate("identity", input(1, "Foreground"), echo, new AbortController().signal)
  assert.equal((await background(store, input(1, "Foreground"), offline)).size, 1)
})

test("oversized actual background output preserves earlier results and remains uncached", async (t) => {
  const store = new TranslationStore()
  t.after(() => store.clear())
  const initial: typeof echo = async (batch) => batch.units.map((unit) => ({ id: unit.id, text: "x".repeat(180000) }))
  await background(store, input(5), initial)
  let requests = 0
  const large: typeof echo = async (batch, _signal, _accept, _interests, _priority, admit) => {
    admit(batch.units.map((unit) => unit.id))
    requests++
    return batch.units.map((unit) => ({ id: unit.id, text: "x".repeat(150000) }))
  }
  await assert.rejects(background(store, input(1, "Large"), large), /background-cache-full-memory/)
  assert.equal(requests, 1)
  await background(store, input(5), () => assert.fail("The previous translation was evicted."))
  assert.equal((await background(store, input(1, "Large"))).size, 1)
})

test("inflight foreground reservations constrain background admission and cancellation releases them", async (t) => {
  const store = new TranslationStore()
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    store.clear()
  })
  let ready!: () => void
  const reserved = new Promise<void>((resolve) => {
    ready = resolve
  })
  const held: typeof echo = (batch, signal, _accept, _interests, _priority, admit) => {
    admit(batch.units.map((unit) => unit.id))
    ready()
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  }
  const foreground = store.translate("identity", input(600), held, controller.signal)
  const cancelled = assert.rejects(foreground)
  await reserved
  await assert.rejects(background(store, input(500, "Other")), /background-cache-full-memory/)
  controller.abort("user-cancelled")
  await cancelled
  assert.equal((await background(store, input(500, "Other"))).size, 500)
})

test("an actual HTTP result that cannot fit stops later batches without evicting earlier memory results", async (t) => {
  const store = new TranslationStore()
  t.after(() => store.clear())
  await background(store, input(5), async (batch) => batch.units.map((unit) => ({ id: unit.id, text: "x".repeat(180000) })))
  const fixture = await chatFixture(t, () => "译".repeat(150000))
  t.after(() => fixture.gate.dispose())
  const settings = { ...fixture.settings, maxItemsPerRequest: 1, initialItemsPerRequest: 1 }
  const pending = prepareInput(settings, input(2, "Pending"))
  const action: typeof echo = (batch, signal, accepted, interests, priority, admit) =>
    fixture.service.request(settings, batch, signal, fixture.gate, accepted, undefined, interests, priority, admit)
  await assert.rejects(background(store, pending, action), /background-cache-full-memory/)
  assert.equal(fixture.seen.length, 1, "Later HTTP was sent after an actual output exceeded available memory.")
  await background(store, input(5), () => assert.fail("Existing memory results were evicted."))
})
