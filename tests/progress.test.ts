import assert from "node:assert/strict"
import { test } from "node:test"
import { TranslationStore } from "../src/translation/store.ts"
import type { PreparedInput, TranslationItem } from "../src/model/translation.ts"
import { waitFor } from "./support/fixtures.ts"

function input(text: string, id = text) {
  return { units: [{ id, text, start: 0, end: text.length, format: "text" as const }] }
}

test("global pending units deduplicate consumers and update after partial completion and cancellation", async (t) => {
  const observed: number[] = []
  const store = new TranslationStore(undefined, () => observed.push(store.progress().pending))
  t.after(() => store.clear())
  const calls: { input: PreparedInput; accept: (item: TranslationItem) => void; finish: (items: readonly TranslationItem[]) => void }[] = []
  const action: Parameters<TranslationStore["translate"]>[2] = (input, _signal, accept) => new Promise((finish) => calls.push({ input, accept, finish }))
  const first = new AbortController()
  const run = store.translate("shared", { units: [...input("First paragraph.").units, ...input("Shared paragraph.").units] }, action, first.signal)
  const cancelled = assert.rejects(run)
  const alias = store.translate("shared", input("Shared paragraph.", "alias"), action, new AbortController().signal)
  const other = store.translate("shared", input("Other paragraph."), action, new AbortController().signal)
  assert.equal(store.progress().pending, 3)
  await waitFor(() => calls.length === 2)
  first.abort("user-cancelled")
  await cancelled
  assert.equal(store.progress().pending, 2, "Cancelling one consumer discarded shared work or retained its unused unit.")
  const shared = calls[0].input.units.find((unit) => unit.text === "Shared paragraph.")!
  calls[0].accept({ id: shared.id, text: shared.text })
  assert.equal(store.progress().pending, 1)
  calls[0].finish(calls[0].input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  await alias
  calls[1].finish(calls[1].input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  await other
  assert.equal(store.progress().pending, 0)
  assert.equal(observed.at(-1), 0)
  assert.ok(observed.includes(3) && observed.includes(2) && observed.includes(1))
  await store.translate("shared", input("Shared paragraph."), () => assert.fail("A cache hit repeated translation."), new AbortController().signal)
  assert.equal(store.progress().pending, 0)
})

test("failed units leave no global pending progress", async (t) => {
  const store = new TranslationStore()
  t.after(() => store.clear())
  await assert.rejects(
    store.translate(
      "failed",
      input("Failed paragraph."),
      async () => {
        throw Error("service-network-failed")
      },
      new AbortController().signal
    )
  )
  assert.equal(store.progress().pending, 0)
})

test("current-file progress follows consumer ownership while global work stays deduplicated", async (t) => {
  const store = new TranslationStore()
  t.after(() => store.clear())
  const calls: { input: PreparedInput; finish: (items: readonly TranslationItem[]) => void }[] = []
  const action: Parameters<TranslationStore["translate"]>[2] = (input) => new Promise((finish) => calls.push({ input, finish }))
  const controller = new AbortController()
  const request = (text: string, resource: string, signal = new AbortController().signal) =>
    store.translate("shared", input(text), action, signal, false, undefined, undefined, undefined, () => 3, true, resource)
  const first = request("Shared paragraph.", "a.md", controller.signal)
  const cancelled = assert.rejects(first)
  const shared = request("Shared paragraph.", "b.md")
  const other = request("Other paragraph.", "b.md")
  assert.deepEqual(store.progress("a.md"), { pending: 2, current: 1 })
  assert.deepEqual(store.progress("b.md"), { pending: 2, current: 2 })
  assert.deepEqual(store.progress("idle.md"), { pending: 2, current: 0 })
  await waitFor(() => calls.length === 2)
  controller.abort("user-cancelled")
  await cancelled
  assert.deepEqual(store.progress("a.md"), { pending: 2, current: 0 })
  assert.deepEqual(store.progress("b.md"), { pending: 2, current: 2 })
  calls[0].finish(calls[0].input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  await shared
  assert.deepEqual(store.progress("b.md"), { pending: 1, current: 1 })
  calls[1].finish(calls[1].input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  await other
  assert.deepEqual(store.progress("b.md"), { pending: 0, current: 0 })
})
