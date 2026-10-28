import assert from "node:assert/strict"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PersistentCache } from "../src/host/persistentCache.ts"
import type { PersistentCacheOptions } from "../src/host/persistentCache.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parsePreserveTerms } from "../src/documents/terms.ts"
import { defaultLanguageNames, defaultSystemPrompt, defaultUserPrompt } from "../src/translation/providers/prompts.ts"
import { inputOf, limits } from "./support/fixtures.ts"

const options: PersistentCacheOptions = { enabled: true, maxEntries: 10000, maxBytes: 20 * 1024 * 1024 }

function storage(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "translation-cache-test-"))
  const path = join(directory, "cache.sqlite")
  const opened: PersistentCache[] = []
  let warnings = 0
  t.after(async () => {
    for (const cache of opened) await cache.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    path,
    get warnings() {
      return warnings
    },
    query(sql: string) {
      const database = new DatabaseSync(path)
      try {
        return database.prepare(sql).all()
      } finally {
        database.close()
      }
    },
    execute(sql: string) {
      const database = new DatabaseSync(path)
      try {
        database.exec(sql)
      } finally {
        database.close()
      }
    },
    async open(configured = options) {
      const cache = new PersistentCache(path, () => warnings++)
      await cache.configure(configured)
      opened.push(cache)
      return cache
    }
  }
}

test("usage snapshots separate committed payload, pending mutations and physical files without flushing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const disk = storage(t)
  const cache = await disk.open()
  const text = "合成译文"
  cache.set("first", text)
  cache.set("second", "another translation")
  let snapshot = cache.snapshot()
  assert.equal(snapshot.state, "ready")
  assert.equal(snapshot.entries, 0)
  assert.equal(snapshot.bytes, 0)
  assert.equal(snapshot.pendingChanges, 2)
  assert.equal(disk.query("SELECT COUNT(*) AS count FROM translations")[0].count, 0)
  await cache.flush()
  const other = await disk.open()
  other.set("external", "另一窗口")
  await other.flush()
  cache.set("first", "待提交的新译文")
  cache.remove("second")
  snapshot = cache.snapshot()
  assert.equal(snapshot.entries, 3)
  assert.equal(
    snapshot.bytes,
    [text, "another translation", "另一窗口"].reduce((total, value) => total + Buffer.byteLength(value, "utf8") + 64, 0)
  )
  assert.equal(snapshot.pendingChanges, 2)
  assert.equal(
    snapshot.diskBytes,
    ["", "-wal", "-shm"].reduce((total, suffix) => total + (statSync(disk.path + suffix, { throwIfNoEntry: false })?.size ?? 0), 0)
  )
  assert.ok(snapshot.diskBytes! > snapshot.bytes!)
  assert.equal(disk.query("SELECT COUNT(*) AS count FROM translations")[0].count, 3)
  await cache.configure({ ...options, maxEntries: 1 })
  snapshot = cache.snapshot()
  assert.equal(snapshot.entries, Number(disk.query("SELECT COUNT(*) AS count FROM translations")[0].count))
  assert.equal(snapshot.maxEntries, 1)
  assert.equal(snapshot.pendingChanges, 0)
})

test("disabled usage does not create storage and still reports remaining database files", async (t) => {
  const disk = storage(t)
  const cache = await disk.open({ ...options, enabled: false })
  assert.equal(cache.snapshot().state, "disabled")
  assert.equal(cache.snapshot().diskBytes, 0)
  assert.equal(cache.snapshot().entries, 0)
  assert.equal(existsSync(disk.path), false)
  await cache.configure(options)
  cache.set("first", "合成译文")
  await cache.flush()
  await cache.configure({ ...options, enabled: false })
  const snapshot = cache.snapshot()
  assert.equal(snapshot.state, "disabled")
  assert.equal(snapshot.entries, 0)
  assert.equal(snapshot.bytes, 0)
  assert.ok(snapshot.diskBytes! > 0)
})

test("unreadable usage remains unknown and preserves storage failure state", async (t) => {
  const disk = storage(t)
  writeFileSync(disk.path, "synthetic damaged SQLite file")
  const cache = await disk.open()
  const snapshot = cache.snapshot()
  assert.equal(snapshot.state, "failed")
  assert.equal(snapshot.entries, undefined)
  assert.equal(snapshot.bytes, undefined)
  assert.equal(snapshot.diskBytes, Buffer.byteLength("synthetic damaged SQLite file"))
  assert.equal(disk.warnings, 1)
  assert.equal(readFileSync(disk.path, "utf8"), "synthetic damaged SQLite file")
})

test("SQLite batches writes and reopens with keyed lookup without saving source keys", async (t) => {
  const disk = storage(t)
  const first = await disk.open()
  for (let index = 0; index < 128; index++) first.set("synthetic-source-" + index, "译文 " + index)
  assert.equal(disk.query("SELECT * FROM translations").length, 0)
  assert.equal(await first.get("synthetic-source-5"), "译文 5")
  await first.flush()
  assert.equal(disk.query("SELECT * FROM translations").length, 128)
  assert.ok(disk.query("SELECT key FROM translations").every((row) => typeof row.key === "string" && /^[0-9a-f]{64}$/u.test(row.key)))
  await first.close()
  assert.ok(!readFileSync(disk.path).includes(Buffer.from("synthetic-source")))
  const next = await disk.open()
  assert.equal(await next.get("synthetic-source-5"), "译文 5")
  assert.equal(await next.get("missing"), undefined)
})

test("scheduled batching commits while idle and large bursts flush before the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const disk = storage(t)
  const cache = await disk.open()
  cache.set("first", "第一项")
  cache.set("second", "第二项")
  assert.equal(disk.query("SELECT * FROM translations").length, 0)
  t.mock.timers.tick(2500)
  assert.equal(disk.query("SELECT * FROM translations").length, 2)
  cache.set("large", "x".repeat(256 * 1024))
  assert.equal(disk.query("SELECT * FROM translations").length, 3)
})

test("independent connections observe committed writes and deletes without losing unrelated records", async (t) => {
  const disk = storage(t)
  const first = await disk.open()
  const second = await disk.open()
  first.set("left", "左侧")
  second.set("right", "右侧")
  await first.flush()
  await second.flush()
  assert.equal(await first.get("right"), "右侧")
  assert.equal(await second.get("left"), "左侧")
  first.remove("left")
  assert.equal(await first.get("left"), undefined)
  await first.flush()
  assert.equal(await second.get("left"), undefined)
  assert.equal(await second.get("right"), "右侧")
})

test("LRU eviction reaches the low watermark, preserves recently read entries and applies reduced capacity", async (t) => {
  const disk = storage(t)
  const cache = await disk.open({ ...options, maxEntries: 10 })
  for (let index = 0; index < 10; index++) cache.set("item-" + index, "译文" + index)
  await cache.flush()
  await cache.get("item-0")
  cache.set("item-10", "译文10")
  await cache.flush()
  assert.equal(disk.query("SELECT * FROM translations").length, 8)
  assert.equal(await cache.get("item-0"), "译文0")
  for (let index = 1; index <= 3; index++) assert.equal(await cache.get("item-" + index), undefined)
  await cache.configure({ ...options, maxEntries: 5 })
  assert.equal(disk.query("SELECT * FROM translations").length, 4)
})

test("byte limits count UTF-8 payload, evict in batches and reject oversized replacements without evicting healthy rows", async (t) => {
  const disk = storage(t)
  const cache = await disk.open({ ...options, maxBytes: 2000 })
  for (let index = 0; index < 15; index++) cache.set("item-" + index, "中".repeat(50))
  await cache.flush()
  assert.ok(Number(disk.query("SELECT SUM(bytes) AS bytes FROM translations")[0].bytes) <= 1600)
  cache.set("large", "old")
  cache.set("healthy", "保留健康项")
  await cache.flush()
  cache.set("large", "中".repeat(1000))
  await cache.flush()
  assert.equal(await cache.get("large"), undefined)
  assert.equal(await cache.get("healthy"), "保留健康项")
  const escaped = "\\".repeat(1000)
  cache.set("escaped", escaped)
  await cache.flush()
  assert.equal(await cache.get("escaped"), escaped, "SQLite text should not pay JSON escaping overhead.")
})

test("disable clears records visible to other connections and close commits the final batch", async (t) => {
  const disk = storage(t)
  const cache = await disk.open()
  const other = await disk.open()
  cache.set("source", "译文")
  await cache.close()
  assert.equal(await other.get("source"), "译文")
  other.set("buffered", "未提交")
  await other.configure({ ...options, enabled: false })
  other.set("ignored", "忽略")
  assert.equal(disk.query("SELECT * FROM translations").length, 0)
  await other.configure(options)
  assert.equal(await other.get("source"), undefined)
})

test("corrupt databases and locked transactions degrade to misses without destroying committed rows", async (t) => {
  const damaged = storage(t)
  writeFileSync(damaged.path, "synthetic damaged SQLite file")
  const broken = await damaged.open()
  assert.equal(await broken.get("source"), undefined)
  broken.set("source", "译文")
  await broken.flush()
  assert.equal(damaged.warnings, 1)
  const disk = storage(t)
  const cache = await disk.open()
  cache.set("healthy", "健康项")
  await cache.flush()
  const lock = new DatabaseSync(disk.path)
  lock.exec("BEGIN IMMEDIATE")
  try {
    cache.set("new", "新项")
    await cache.flush()
    assert.equal(disk.warnings, 1)
  } finally {
    lock.exec("ROLLBACK")
    lock.close()
  }
  assert.equal(await (await disk.open()).get("healthy"), "健康项")
  assert.equal(await (await disk.open()).get("new"), undefined)
})

test("store restores validated units and force refresh replaces persisted results", async (t) => {
  const disk = storage(t)
  const cache = await disk.open()
  const input = inputOf(parseMarkdown("Read `token`.\n\nKeep the guide."))
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) =>
    input.units.map((unit) => ({ id: unit.id, text: unit.text.replace("Read", "阅读").replace("Keep", "保留") }))
  const signal = () => new AbortController().signal
  const expected = await new TranslationStore(cache).translate("identity", input, action, signal())
  await cache.close()
  const restored = await disk.open()
  const next = new TranslationStore(restored)
  const offline = () => assert.fail("A disk hit unexpectedly requested translation.")
  assert.deepEqual(await next.translate("identity", input, offline, signal()), expected)
  const refreshed = await next.translate("identity", input, async (input) => input.units.map((unit) => ({ id: unit.id, text: unit.text })), signal(), true)
  assert.deepEqual(
    [...refreshed.values()],
    input.units.map((unit) => unit.text)
  )
  next.clear("configuration-changed", true)
  await next.translate("identity", input, offline, signal())
  await restored.close()
  assert.deepEqual(await new TranslationStore(await disk.open()).translate("identity", input, offline, signal()), refreshed)
})

test("store rejects corrupted cached syntax and retries through the normal action", async (t) => {
  const disk = storage(t)
  const cache = await disk.open()
  const input = inputOf(parseMarkdown("Read [guide](https://a.example)."))
  await new TranslationStore(cache).translate(
    "identity",
    input,
    async (input) => input.units.map((unit) => ({ id: unit.id, text: "阅读 [guide](https://a.example)." })),
    new AbortController().signal
  )
  await cache.close()
  disk.execute("UPDATE translations SET text = REPLACE(text, 'https://a.example', 'https://b.example')")
  let requests = 0
  const result = await new TranslationStore(await disk.open()).translate(
    "identity",
    input,
    async (input) => {
      requests++
      return input.units.map((unit) => ({ id: unit.id, text: "阅读 [guide](https://a.example)." }))
    },
    new AbortController().signal
  )
  assert.equal(requests, 1)
  assert.equal(result.get(input.units[0].id), "阅读 [guide](https://a.example).")
})

test("completed neighbours persist across a failed request and only missing units are retried", async (t) => {
  const disk = storage(t)
  const cache = await disk.open()
  const input = inputOf(parseMarkdown("First paragraph.\n\nSecond paragraph."))
  const signal = () => new AbortController().signal
  await assert.rejects(
    new TranslationStore(cache).translate(
      "partial",
      input,
      async (input, _signal, completed) => {
        completed({ id: input.units[0].id, text: "第一段。" })
        throw Error("synthetic-connection-failure")
      },
      signal()
    )
  )
  await cache.close()
  const requested: string[] = []
  const result = await new TranslationStore(await disk.open()).translate(
    "partial",
    input,
    async (input) => {
      requested.push(...input.units.map((unit) => unit.text))
      return input.units.map((unit) => ({ id: unit.id, text: "第二段。" }))
    },
    signal()
  )
  assert.deepEqual(requested, ["Second paragraph."])
  assert.deepEqual([...result.values()], ["第一段。", "第二段。"])
})

test("memory hits update persistent recency and preserve hot entries during eviction", async (t) => {
  const disk = storage(t)
  const cache = await disk.open({ ...options, maxEntries: 5 })
  const store = new TranslationStore(cache)
  const inputs = Array.from({ length: 6 }, (_, index) => inputOf(parseMarkdown("Paragraph " + index)))
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) => input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  const run = (index: number) => store.translate("hot", inputs[index], action, new AbortController().signal)
  for (let index = 0; index < 5; index++) await run(index)
  await cache.flush()
  await run(0)
  await run(5)
  await cache.close()
  await new TranslationStore(await disk.open({ ...options, maxEntries: 5 })).translate("hot", inputs[0], () => assert.fail("The hot entry was evicted."), new AbortController().signal)
})

test("result identity ignores unrelated settings while preserving prompts, languages, references and each unit's preservation decision", async () => {
  const settings = {
    ...limits,
    provider: "openai",
    apiUrl: "https://example.com/v1/chat/completions",
    model: "synthetic",
    apiKey: "",
    systemPrompt: defaultSystemPrompt,
    userPrompt: defaultUserPrompt,
    languageNames: defaultLanguageNames,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    skipSameLanguage: false,
    preserveTerms: parsePreserveTerms([])
  }
  const base = serviceIdentity(settings)
  assert.equal(
    serviceIdentity({ ...settings, apiKey: "rotated-synthetic-key", languageNames: { ...settings.languageNames, xx: "Unrelated" }, preserveTerms: parsePreserveTerms(["Unrelated"]) }),
    base
  )
  for (const change of [
    { systemPrompt: "Use formal language." },
    { userPrompt: "${content}" },
    { targetLanguage: "fr" },
    { languageNames: { ...settings.languageNames, [settings.targetLanguage]: "A different language label" } }
  ])
    assert.notEqual(serviceIdentity({ ...settings, ...change }), base)
  const store = new TranslationStore()
  const raw = inputOf(parseMarkdown("Widget"))
  let calls = 0
  const run = (preserve: string[]) => {
    const configured = { ...settings, preserveTerms: parsePreserveTerms(preserve) }
    return store.translate(
      serviceIdentity(configured),
      prepareInput(configured, raw),
      async (input) => {
        calls++
        return input.units.map((unit) => ({ id: unit.id, text: unit.preserved ? unit.text : "控件" }))
      },
      new AbortController().signal
    )
  }
  assert.equal([...(await run([])).values()][0], "控件")
  await run(["Other"])
  assert.equal(calls, 1)
  assert.equal([...(await run(["Widget"])).values()][0], "Widget")
  await run([])
  assert.equal(calls, 2)
})
