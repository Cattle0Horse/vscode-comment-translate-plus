import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { RequestGate } from "../src/translation/requestGate.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { chatFixture, waitFor } from "./support/fixtures.ts"

function paragraphs(count: number) {
  return {
    units: Array.from({ length: count }, (_, index) => ({ id: String(index), start: index * 40, end: index * 40 + 30, text: `Original paragraph ${index + 1}.`, format: "text" as const }))
  }
}

test("waiting HTTP uses the latest priority, preserves FIFO within a tier and never interrupts active work", async (t) => {
  const gate = new RequestGate(100, 1)
  t.after(() => gate.dispose())
  const signal = new AbortController().signal
  let release!: () => void
  const held = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
    signal
  )
  const order: string[] = []
  let foreground = "old"
  const enqueue = (id: string, tier: number) =>
    gate.run(
      async () => {
        order.push(id)
      },
      signal,
      () => (id === foreground ? 0 : tier)
    )
  const cancelled = new AbortController()
  const abandoned = gate.run(
    async () => {
      assert.fail("Cancelled queued HTTP started.")
    },
    cancelled.signal,
    () => 0
  )
  const rejected = assert.rejects(abandoned)
  const background = enqueue("background", 2)
  const first = enqueue("first", 1)
  const second = enqueue("second", 1)
  const promoted = enqueue("new", 2)
  foreground = "new"
  cancelled.abort("document-closed")
  assert.deepEqual(order, [], "Queued work preempted an active request.")
  release()
  await Promise.all([held, rejected, background, first, second, promoted])
  assert.deepEqual(order, ["new", "first", "second", "background"])
})

test("a new viewport overtakes the unplanned tail of the same whole-document translation", async (t) => {
  let release!: () => void
  const fixture = await chatFixture(t, async (_body, items, call) => {
    if (call === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return items.join("\n%%\n")
  })
  t.after(() => release?.())
  const gate = new RequestGate(100, 1)
  t.after(() => gate.dispose())
  const input = paragraphs(4)
  const settings = { ...fixture.settings, targetLanguage: "en", maxItemsPerRequest: 1 }
  let viewport = input.units[0].id
  const result = fixture.service.request(settings, prepareInput(settings, input), new AbortController().signal, gate, undefined, undefined, undefined, (id) => (id === viewport ? 0 : 1))
  await waitFor(() => !!release)
  viewport = input.units[3].id
  release()
  assert.equal((await result).length, 4)
  assert.deepEqual(
    fixture.seen.flatMap(({ items }) => items),
    [input.units[0], input.units[3], input.units[1], input.units[2]].map((unit) => unit.text)
  )
})

test("a queued recovery cannot block newly visible units in the same document", async (t) => {
  let release!: () => void
  const fixture = await chatFixture(t, async (_body, items, call) => {
    if (call === 1) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return ""
    }
    return items.join("\n%%\n")
  })
  t.after(() => release?.())
  const gate = new RequestGate(100, 1)
  t.after(() => gate.dispose())
  const input = paragraphs(4)
  const settings = { ...fixture.settings, targetLanguage: "en", maxItemsPerRequest: 1 }
  let viewport = "0"
  const pending = fixture.service.request(settings, prepareInput(settings, input), new AbortController().signal, gate, undefined, undefined, undefined, (id) => (id === viewport ? 0 : 1))
  await waitFor(() => !!release)
  viewport = "3"
  release()
  assert.equal((await pending).length, 4)
  assert.deepEqual(
    fixture.seen.slice(0, 2).flatMap(({ items }) => items),
    [input.units[0].text, input.units[3].text]
  )
  assert.equal(fixture.seen.filter(({ items }) => items[0] === input.units[0].text).length, 2, "Priority changes consumed attempts or lost the failed unit's recovery.")
})

test("tab focus prioritizes viewport then the current document while background translations finish", async (t) => {
  let release!: () => void
  const fixture = await chatFixture(t, async (_body, items, call) => {
    if (call === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return items.join("\n%%\n")
  })
  t.after(() => release?.())
  const gate = new RequestGate(100, 1)
  t.after(() => gate.dispose())
  const settings = { ...fixture.settings, targetLanguage: "en", maxItemsPerRequest: 1 }
  let active = "a"
  const a = paragraphs(3)
  const b = { units: paragraphs(5).units.slice(3) }
  const priority = (document: string, viewport: string) => (id: string) => (active !== document ? 2 : id === viewport ? 0 : 1)
  const first = fixture.service.request(settings, prepareInput(settings, a), new AbortController().signal, gate, undefined, undefined, undefined, priority("a", a.units[0].id))
  await waitFor(() => !!release)
  const second = fixture.service.request(settings, prepareInput(settings, b), new AbortController().signal, gate, undefined, undefined, undefined, priority("b", b.units[1].id))
  active = "b"
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(
    results.map((items) => items.length),
    [3, 2]
  )
  assert.deepEqual(
    fixture.seen.flatMap(({ items }) => items),
    [a.units[0], b.units[1], b.units[0], a.units[1], a.units[2]].map((unit) => unit.text)
  )
})

test("a shared foreground consumer promotes canonical queued units and detaching it restores background priority", async (t) => {
  for (const detach of [false, true]) {
    const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
    const gate = new RequestGate(100, 1)
    const store = new TranslationStore()
    t.after(() => {
      store.clear()
      gate.dispose()
    })
    let release!: () => void
    const held = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      new AbortController().signal
    )
    t.after(() => release())
    const settings = { ...fixture.settings, targetLanguage: "en", maxItemsPerRequest: 1 }
    const action: Parameters<TranslationStore["translate"]>[2] = (input, signal, accepted, interests, priority) =>
      fixture.service.request(settings, input, signal, gate, accepted, undefined, interests, priority)
    const input = paragraphs(2)
    const background = store.translate("shared", input, action, new AbortController().signal, false, undefined, undefined, undefined, () => 2)
    const foregroundController = new AbortController()
    const foregroundUnit = { ...input.units[1], id: "foreground", start: 9000, end: 9100 }
    const foreground = store.translate("shared", { units: [foregroundUnit] }, action, foregroundController.signal, false, undefined, undefined, undefined, () => 0)
    const foregroundResult = detach ? assert.rejects(foreground) : foreground
    if (detach) foregroundController.abort("hover-target-changed")
    release()
    await Promise.all([held, background, foregroundResult])
    assert.deepEqual(
      fixture.seen.flatMap(({ items }) => items),
      (detach ? input.units : [...input.units].reverse()).map((unit) => unit.text)
    )
    assert.equal((await store.translate("shared", input, action, new AbortController().signal)).size, 2)
    assert.equal(fixture.seen.length, 2, "A shared target was sent twice or its validated result was not cached.")
  }
})

test("Google and Bing prioritize a new viewport inside queued batches and beyond their unplanned tail", async (t) => {
  for (const [provider, maximum] of [
    ["google", 3],
    ["bing", 3],
    ["google", 2],
    ["bing", 2]
  ] as const) {
    const seen: string[] = []
    let release!: () => void
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://fixture.invalid")
      if (url.pathname === "/bing/translator") {
        response.end('IG:"fixture" data-iid="translator.1" params_AbusePreventionHelper = [123,"token"]')
        return
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const text = provider === "google" ? url.searchParams.get("q")! : new URLSearchParams(Buffer.concat(chunks).toString()).get("text")!
      seen.push(text)
      if (seen.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      response.end(JSON.stringify(provider === "google" ? [[[text]]] : [{ translations: [{ text }] }]))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const gate = new RequestGate(100, 1)
    const controller = new AbortController()
    t.after(() => {
      controller.abort()
      release?.()
      gate.dispose()
      server.closeAllConnections()
      server.close()
    })
    const fixture = await chatFixture(t, () => {
      assert.fail("Traditional provider called OpenAI.")
    })
    const settings = {
      ...fixture.settings,
      provider,
      targetLanguage: "en",
      maxItemsPerRequest: maximum,
      batchBySemanticScope: false,
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${provider === "google" ? "google" : "bing/translator"}`
    }
    const input = paragraphs(3)
    let viewport = "0"
    // Start with one tier; the final unit can belong to this batch or its unplanned tail.
    let scrolling = false
    const pending = fixture.service.request(settings, prepareInput(settings, input), controller.signal, gate, undefined, undefined, undefined, (id) =>
      scrolling && id === viewport ? 0 : 1
    )
    await waitFor(() => !!release)
    viewport = "2"
    scrolling = true
    release()
    assert.equal((await pending).length, 3)
    assert.deepEqual(seen, [input.units[0].text, input.units[2].text, input.units[1].text])
  }
})
