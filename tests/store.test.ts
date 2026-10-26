import { ModelRetry } from "../src/model/diagnostics.ts"
import { emptyPreserveTerms, prepareTranslation, parsePreserveTerms } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { translatedMarkdown, translationDisplayText, progressiveMarkdown, previewLoadingMarker } from "../src/documents/presentation.ts"
import type { TranslationItem } from "../src/model/translation.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationService } from "../src/translation/engine.ts"
import { serviceIdentity } from "../src/translation/settings.ts"
import { defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames } from "../src/translation/providers/prompts.ts"
import { isTargetLanguage } from "../src/documents/languageDetection.ts"
import { TranslationLog } from "../src/host/logging.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import {
  modelFeedback,
  referenceText,
  embeddedMarkdown,
  limits,
  requestTranslation,
  inputOf,
  modelContext,
  source,
  batch,
  sessionResponse,
  waitFor,
  modelInput,
  dropLastProtection,
  chatFixture,
  listBatch,
  logContext
} from "./support/fixtures.ts"

test("fenced Markdown and YAML reuse scalar and prose translation while preserving containers, Unicode offsets and untouched code", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const prefix of ["", "> ", "  ", ">   "]) {
      const body = [
        "````markdown",
        "# Read 😀",
        "",
        "Read the",
        "original document.",
        "",
        "```yml",
        "title: Read",
        "description: |-",
        "  Read the",
        "  original document.",
        "enabled: true",
        "count: 10",
        "```",
        "````"
      ]
      const source =
        (prefix === "  " ? "- Guide" + newline + newline : "") +
        body.map((line) => prefix + line).join(newline) +
        newline +
        ["```unknown", "Read untouched.", "```", "", "```", "Read unlabelled.", "```"].join(newline)
      const parsed = await embeddedMarkdown(source)
      assert.deepEqual(parsed.errors, [])
      const units = parsed.groups.flatMap((group) => group.units)
      assert.ok(units.some((unit) => unit.content === "Read the\noriginal document."))
      assert.ok(units.some((unit) => unit.text.includes("# Read 😀")))
      const translations = new Map<string, string>()
      for (const unit of units) {
        assert.equal(source.slice(unit.start, unit.end), unit.text)
        const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
        assert.equal(prepared.restore(prepared.text), unit.text, "No-change translations must retain original YAML syntax and every container prefix.")
        const translated = prepared.restore(prepared.text.replaceAll("Read", "阅读"))
        assert.equal(validateTranslation(unit, translated), undefined)
        translations.set(unit.id, translated)
      }
      const translated = translatedMarkdown(parsed, translations)
      assert.ok(translated.includes(prefix + "# 阅读 😀"))
      assert.ok(translated.includes(prefix + "阅读 the original document."))
      assert.ok(translated.includes(prefix + 'description: "阅读 the original document."'))
      assert.ok(translated.includes(prefix + "enabled: true") && translated.includes(prefix + "count: 10"))
      assert.ok(translated.endsWith(["```unknown", "Read untouched.", "```", "", "```", "Read unlabelled.", "```"].join(newline)))
      assert.equal(progressiveMarkdown(parsed, new Map()).includes(previewLoadingMarker), prefix === "  ", "Pending fenced prose must not inject HTML into a code block.")
    }
  }
})

test("moving an embedded document reuses validated per-unit cache without retaining parser offsets", async () => {
  const store = new TranslationStore()
  const source = "> ```md\n> Read the guide\n> and keep `sourceId`.\n> ```"
  let calls = 0
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) => {
    calls++
    return input.units.map((unit) => {
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      return { id: unit.id, text: prepared.restore(prepared.text.replace("Read", "阅读")) }
    })
  }
  for (const prefix of ["", "\n\n\n"]) {
    const parsed = await embeddedMarkdown(prefix + source)
    const result = await store.translate("embedded", inputOf(parsed), action, new AbortController().signal)
    assert.equal(translatedMarkdown(parsed, result), prefix + source.replace("Read", "阅读").replace("\n> and", " and"))
  }
  assert.equal(calls, 1, "Moving a fence discarded a validated translation despite unchanged source and references.")
})

test("custom preserved terms complete and cache only as whole units while mixed prose is translated without custom masking", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body).replace("Read ", "阅读 ").replace("Feature", "功能"))
  const settings = {
    ...fixture.settings,
    preserveTerms: parsePreserveTerms(["Feature", "Unused", "sourceId"])
  }
  const local: TranslationInput = { units: [...inputOf(parseMarkdown("**Feature**")).units, { id: "code", start: 13, end: 23, text: "`sourceId`", format: "markdown" }] }
  const store = new TranslationStore()
  const events: TranslationEvent[] = []
  const translate = () =>
    store.translate(
      serviceIdentity(settings),
      local,
      (input, signal, completed, interests) =>
        fixture.service.request(settings, prepareInput(settings, input), signal, fixture.gate, completed, { details: false, emit: (event) => events.push(event) }, interests),
      new AbortController().signal
    )
  assert.deepEqual([...(await translate()).values()], ["**Feature**", "`sourceId`"])
  const finish = events.filter((event) => event.kind === "finish")
  assert.equal(finish.length, 1)
  assert.equal(finish[0].completed, 2)
  assert.equal(finish[0].changed, 0)
  assert.equal(finish[0].unchanged, 2)
  assert.equal(finish[0].httpRequests, 0)
  assert.equal(fixture.seen.length, 0)
  assert.deepEqual([...(await translate()).values()], ["**Feature**", "`sourceId`"])
  const prose = inputOf(parseMarkdown("Read Feature and `sourceId`."))
  const result = await requestTranslation(fixture.service, settings, prose, new AbortController().signal, fixture.gate)
  assert.equal(result[0].text, "阅读 功能 and `sourceId`.")
  assert.ok(!fixture.seen.at(-1)!.body.messages.some((message) => /Terminology:|→/u.test(message.content)))
  assert.ok(modelInput(fixture.seen.at(-1)!.body).includes("Feature"), "A custom preserved word inside prose was hidden from the model.")
  const changedSettings = { ...settings, preserveTerms: emptyPreserveTerms }
  const afterChange = await store.translate(
    serviceIdentity(changedSettings),
    local,
    (input, signal) => requestTranslation(fixture.service, changedSettings, input, signal, fixture.gate),
    new AbortController().signal
  )
  assert.equal(afterChange.get(local.units[0].id), "**功能**")
  assert.equal(fixture.seen.length, 2, "Removing a custom preserved term reused a local-only result without translating its prose.")
})

test("table and YAML references merge shared structure without duplicating ancestors or complete parent collections", () => {
  const table = "| Signal | Mode |\n| --- | --- |\n| Event | Garden |\n| Market | Industry |"
  const cells = inputOf(parseMarkdown(table)).units
  assert.equal(referenceText(cells), table)
  for (const newline of ["\n", "\r\n"]) {
    const yaml = "metadata:\n  availability: active\n  default_enabled: true\n  read_only: false\n  description: |\n    Read both lines.\n    Keep their meaning.".replaceAll("\n", newline)
    const fields = inputOf(parseMarkdown(["---", yaml, "---"].join(newline))).units
    const selected = fields.filter((unit) => ["availability", "active", "default_enabled", "read_only"].includes(unit.content!))
    assert.equal(referenceText(selected), ["metadata:", "  availability: active", "  default_enabled: true", "  read_only: false"].join(newline))
    assert.equal(referenceText(fields).replaceAll("\r\n", "\n"), yaml.replaceAll("\r\n", "\n"))
    const description = fields.find((unit) => unit.content?.includes("Read both lines."))!
    assert.ok(referenceText([description]).replaceAll("\r\n", "\n").includes("  description: |\n    Read both lines.\n    Keep their meaning."))
  }
  const nested = "metadata:\n  left:\n    label: Same\n  right:\n    label: Same"
  const labels = inputOf(parseMarkdown("---\n" + nested + "\n---")).units.filter((unit) => unit.content === "label")
  assert.equal(referenceText(labels), nested, "Identical field text under different parents was incorrectly deduplicated.")
  const tables = inputOf(parseMarkdown(table + "\n\n" + table)).units
  assert.equal(referenceText(tables), table + "\n\n" + table, "Different source tables were merged into one structure.")
})

test("shared cache ignores document offsets, isolates translation settings and maps current IDs", async () => {
  const store = new TranslationStore()
  let requests = 0
  const translate = async (batch: TranslationInput) => {
    requests++
    return batch.units.map((unit) => ({ id: unit.id, text: unit.text }))
  }
  const first = inputOf(parseMarkdown(source))
  const shifted = inputOf(parseMarkdown("\n\n" + source))
  await store.translate("profile-a", first, translate, new AbortController().signal)
  const result = await store.translate("profile-a", shifted, translate, new AbortController().signal)
  assert.equal(requests, 1)
  assert.notEqual(first.units[0].id, shifted.units[0].id)
  assert.equal(result.get(shifted.units[0].id), first.units[0].text)
  await store.translate("profile-b", shifted, translate, new AbortController().signal)
  assert.equal(requests, 2)
  store.clear()
})

test("shared in-flight work survives one cancelled consumer and caches only validated data", async () => {
  const store = new TranslationStore()
  const first = new AbortController()
  const second = new AbortController()
  let requests = 0
  let complete: (text: readonly TranslationItem[]) => void = () => {}
  let transportSignal: AbortSignal | undefined
  const translate = async (_batch: TranslationInput, signal: AbortSignal) => {
    requests++
    transportSignal = signal
    return new Promise<readonly TranslationItem[]>((resolve) => {
      complete = resolve
    })
  }
  const a = store.translate("shared", batch, translate, first.signal)
  const b = store.translate("shared", batch, translate, second.signal)
  await waitFor(() => requests === 1)
  first.abort()
  await assert.rejects(a)
  assert.equal(transportSignal?.aborted, false)
  complete(sessionResponse)
  assert.equal((await b).size, 2)
  await store.translate("shared", batch, translate, new AbortController().signal)
  assert.equal(requests, 1)
  store.clear()
})

test("forced shared requests cannot be overwritten by an older successful response", async () => {
  const store = new TranslationStore()
  const single = inputOf(parseMarkdown("Read one paragraph."))
  const complete: ((value: readonly TranslationItem[]) => void)[] = []
  const translate = async () => new Promise<readonly TranslationItem[]>((resolve) => complete.push(resolve))
  const old = store.translate("shared", single, translate, new AbortController().signal)
  const fresh = store.translate("shared", single, translate, new AbortController().signal, true)
  await waitFor(() => complete.length === 2)
  complete[1]([{ id: "t0", text: "新的译文。" }])
  await fresh
  complete[0]([{ id: "t0", text: "旧的译文。" }])
  await old
  const cached = await store.translate("shared", single, translate, new AbortController().signal)
  assert.equal(cached.get(single.units[0].id), "新的译文。")
  assert.equal(complete.length, 2)
  store.clear()
})

test("provider protocol cancels an active HTTP request and queued sibling items without bypassing the shared gate", async (t) => {
  let started = 0
  const server = createServer(() => {
    started++
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const settings = {
    ...limits,
    provider: "google",
    apiUrl: "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/translate",
    model: "",
    systemPrompt: defaultSystemPrompt,
    userPrompt: defaultUserPrompt,
    languageNames: defaultLanguageNames,
    apiKey: "",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    preserveTerms: emptyPreserveTerms,
    skipSameLanguage: false
  }
  const controller = new AbortController()
  const pending = requestTranslation(new TranslationService(), settings, batch, controller.signal, new RequestGate(100, 1))
  await waitFor(() => started === 1)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(started, 1)
  await assert.rejects(
    requestTranslation(
      new TranslationService(),
      {
        ...limits,
        ...settings,
        provider: "not-installed"
      },
      batch,
      new AbortController().signal,
      new RequestGate(100, 1)
    ),
    /service-provider-unknown/
  )
  assert.equal(started, 1)
})

test("shared HTTP transport reports connection failure with a diagnostic code instead of raw request data", async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  const settings = {
    ...limits,
    provider: "google",
    apiUrl: `http://127.0.0.1:${port}/private-path`,
    model: "",
    systemPrompt: defaultSystemPrompt,
    userPrompt: defaultUserPrompt,
    languageNames: defaultLanguageNames,
    apiKey: "",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    preserveTerms: emptyPreserveTerms,
    skipSameLanguage: false
  }
  await assert.rejects(requestTranslation(new TranslationService(), settings, batch, new AbortController().signal, new RequestGate(100, 1)), { message: "service-network-failed" })
})

test("unit interests cancel unused HTTP and queued units while preserving a shared hover target", async (t) => {
  const releases: (() => void)[] = []
  const fixture = await chatFixture(t, async (_body, items) => {
    if (items[0].includes("Original A")) await new Promise<void>((resolve) => releases.push(resolve))
    return items.join("\n%%\n")
  })
  t.after(() => releases.forEach((release) => release()))
  const settings = { ...fixture.settings, userPrompt: "${content}", maxItemsPerRequest: 1, maxConcurrentRequests: 1 }
  const input = prepareInput(settings, inputOf(parseMarkdown("Original A.\n\nOriginal B.\n\nOriginal C.")))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const events: TranslationEvent[] = []
  const action: Parameters<TranslationStore["translate"]>[2] = (batch, signal, completed, interests) =>
    fixture.service.request(settings, batch, signal, fixture.gate, completed, { details: true, emit: (event) => events.push(event) }, interests)
  const previewController = new AbortController()
  const preview = store.translate("interests", input, action, previewController.signal)
  void preview.catch(() => {})
  await waitFor(() => releases.length === 1)
  const hover = store.translate("interests", { units: [input.units[1]] }, action, new AbortController().signal)
  previewController.abort("preview-closed")
  await assert.rejects(preview)
  assert.equal((await hover).get(input.units[1].id), "Original B.")
  assert.deepEqual(
    fixture.seen.map(({ items }) => items[0]),
    ["Original A.", "Original B."]
  )
  const before = fixture.seen.length
  await store.translate("interests", { units: [input.units[1]] }, action, new AbortController().signal)
  assert.equal(fixture.seen.length, before, "The shared hover result was not cached.")
  await waitFor(() => events.some((event) => event.kind === "finish"))
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  log.configure("info", true)
  for (const event of events) log.record(event, logContext)
  const text = entries.join("\n")
  assert.ok(!text.includes("--- 原文与译文 ---"), "A cancelled consumer printed a source/translation section.")
  assert.ok(text.includes("译文预览已关闭") && text.includes("HTTP 已开始"), "A shared request lost the consumer's cancellation origin.")
  releases.forEach((release) => release())
})

test("detaching one browse unit preserves shared hover work and unrelated units in the same request", async () => {
  const store = new TranslationStore()
  const input = inputOf(parseMarkdown("Read first.\n\nRead second."))
  const target = input.units[0]
  const interest = new AbortController()
  let finish!: (items: readonly TranslationItem[]) => void
  let sharedSignal!: AbortSignal
  let targetSignal!: AbortSignal
  const seen: string[] = []
  const action: Parameters<TranslationStore["translate"]>[2] = (input, signal, _completed, interests) => {
    sharedSignal = signal
    targetSignal = interests.get(input.units[0].id)!
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const browse = store.translate("detach", input, action, new AbortController().signal, false, (item) => seen.push(item.id), undefined, new Map([[target.id, interest.signal]]))
  const hover = store.translate("detach", { units: [target] }, action, new AbortController().signal)
  await waitFor(() => !!finish)
  interest.abort("retranslation")
  assert.equal(sharedSignal.aborted, false)
  assert.equal(targetSignal.aborted, false, "Detaching browse aborted a target still needed by hover.")
  finish(input.units.map((unit, index) => ({ id: "t" + index, text: unit.text })))
  assert.deepEqual([...(await browse).keys()], [input.units[1].id])
  assert.deepEqual(seen, [input.units[1].id])
  assert.equal((await hover).get(target.id), target.text)
  const cached = await store.translate(
    "detach",
    input,
    async () => {
      throw Error("Expected cache")
    },
    new AbortController().signal
  )
  assert.equal(cached.size, 2)
  store.clear()
})

test("unit cancellation skips queued work without failing the remaining browse units", async (t) => {
  const releases: (() => void)[] = []
  const fixture = await chatFixture(t, async (_body, items) => {
    if (items[0].includes("Original A")) await new Promise<void>((resolve) => releases.push(resolve))
    return items.join("\n%%\n")
  })
  t.after(() => releases.forEach((release) => release()))
  const settings = { ...fixture.settings, userPrompt: "${content}", maxItemsPerRequest: 1, maxConcurrentRequests: 1 }
  const input = prepareInput(settings, inputOf(parseMarkdown("Original A.\n\nOriginal B.\n\nOriginal C.")))
  const controllers = input.units.map(() => new AbortController())
  const store = new TranslationStore()
  t.after(() => store.clear())
  const result = store.translate(
    "detach-queued",
    input,
    (batch, signal, completed, interests) => fixture.service.request(settings, batch, signal, fixture.gate, completed, undefined, interests),
    new AbortController().signal,
    false,
    undefined,
    undefined,
    new Map(input.units.map((unit, index) => [unit.id, controllers[index].signal]))
  )
  await waitFor(() => releases.length === 1)
  controllers[1].abort("retranslation")
  releases[0]()
  assert.deepEqual([...(await result).values()], ["Original A.", "Original C."])
  assert.deepEqual(
    fixture.seen.map(({ items }) => items[0]),
    ["Original A.", "Original C."]
  )
})

test("per-unit cancellation retains another same-content target and releases HTTP after its final target detaches", async () => {
  for (const sharedContent of [false, true]) {
    const store = new TranslationStore()
    const first = { id: "first", start: 0, end: 5, text: "Read.", format: "text" as const }
    const second = { ...first, id: "second", text: sharedContent ? first.text : "Keep." }
    const controllers = [new AbortController(), new AbortController()]
    let transportSignal!: AbortSignal
    let interests!: ReadonlyMap<string, AbortSignal>
    let finish!: (items: readonly TranslationItem[]) => void
    const result = store.translate(
      "detach-all",
      { units: [first, second] },
      (_input, signal, _completed, unitInterests) => {
        transportSignal = signal
        interests = unitInterests
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      new AbortController().signal,
      false,
      undefined,
      undefined,
      new Map([
        [first.id, controllers[0].signal],
        [second.id, controllers[1].signal]
      ])
    )
    await waitFor(() => !!finish)
    controllers[0].abort("retranslation")
    assert.equal(transportSignal.aborted, false)
    assert.equal(interests.get("t0")!.aborted, !sharedContent)
    controllers[1].abort("retranslation")
    assert.equal(transportSignal.aborted, true)
    assert.equal((await result).size, 0)
    finish([])
    store.clear()
  }
})

test("a superseded unit cannot invalidate newer cached or in-flight results when its old forced batch reaches the store late", async () => {
  for (const alreadyCached of [false, true]) {
    const store = new TranslationStore()
    const input = inputOf(parseMarkdown("Read first.\n\nRead second."))
    const target = input.units[0]
    let finish!: (items: readonly TranslationItem[]) => void
    const fresh = store.translate(
      "late-force",
      { units: [target] },
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      new AbortController().signal
    )
    await waitFor(() => !!finish)
    if (alreadyCached) {
      finish([{ id: "t0", text: "新译文。" }])
      await fresh
    }
    const stale = new AbortController()
    stale.abort("retranslation")
    await store.translate(
      "late-force",
      input,
      async (batch) => {
        assert.deepEqual(
          batch.units.map((unit) => unit.text),
          [input.units[1].text]
        )
        return batch.units.map((unit) => ({ id: unit.id, text: unit.text }))
      },
      new AbortController().signal,
      true,
      undefined,
      undefined,
      new Map([[target.id, stale.signal]])
    )
    if (!alreadyCached) {
      finish([{ id: "t0", text: "新译文。" }])
      await fresh
    }
    const cached = await store.translate(
      "late-force",
      { units: [target] },
      async () => {
        throw Error("The old batch invalidated its superseded target")
      },
      new AbortController().signal
    )
    assert.equal(cached.get(target.id), "新译文。")
    store.clear()
  }
})

test("parser reference positions never enter the cache identity after moving an unchanged table", async () => {
  const store = new TranslationStore()
  const table = "| Signal | Mode |\n| --- | --- |\n| Event | Garden |"
  let calls = 0
  const action: Parameters<TranslationStore["translate"]>[2] = async (input) => {
    calls++
    return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  }
  for (const prefix of ["", "\n\n\n"]) await store.translate("reference-position", inputOf(parseMarkdown(prefix + table)), action, new AbortController().signal)
  assert.equal(calls, 1, "Moving source ranges invalidated identical actual per-unit references.")
  store.clear()
})

test("actual request dispatch fills the configured concurrency window while the shared gate caps active HTTP", async (t) => {
  const releases: (() => void)[] = []
  let active = 0
  let peak = 0
  const fixture = await chatFixture(t, async (_body, items) => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return items.join("\n%%\n")
  })
  const controller = new AbortController()
  const pending = requestTranslation(fixture.service, { ...fixture.settings, maxItemsPerRequest: 1, maxConcurrentRequests: 2 }, listBatch(3), controller.signal, fixture.gate)
  void pending.catch(() => {})
  try {
    await waitFor(() => releases.length === 2)
    assert.equal(active, 2, "A full document was serialized despite two available request slots.")
    releases[0]()
    await waitFor(() => releases.length === 3)
    assert.equal(peak, 2)
    releases[1]()
    releases[2]()
    assert.equal((await pending).length, 3)
  } finally {
    controller.abort()
    for (const release of releases) release()
  }
})

test("unit cache survives changed grouping and positions but isolates changed actual references", async () => {
  const store = new TranslationStore()
  const units = listBatch(3).units
  const calls: TranslationInput[] = []
  const action = async (input: TranslationInput) => {
    calls.push(input)
    return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  }
  await store.translate("unit-cache", { units: units.slice(0, 2) }, action, new AbortController().signal)
  await store.translate("unit-cache", { units: units.slice(1) }, action, new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.deepEqual(
    calls[1].units.map((unit) => unit.text),
    [units[2].text]
  )
  await store.translate("unit-cache", { units: [{ ...units[1], id: "shifted", start: units[1].start + 100, end: units[1].end + 100 }] }, action, new AbortController().signal)
  assert.equal(calls.length, 2)
  await store.translate("unit-cache", { units: [{ ...units[1], reference: [{ kind: "Project", text: "Different context" }] }] }, action, new AbortController().signal)
  assert.equal(calls.length, 3)
})

test("unit cache keeps table cell validation distinct from plain paragraphs even when reference budget is zero", async () => {
  const store = new TranslationStore()
  const paragraph = { ...inputOf(parseMarkdown("Read text.")).units[0], reference: [] }
  const cell = { ...inputOf(parseMarkdown("| Read text. | Other |\n| --- | --- |")).units[0], reference: [] }
  assert.equal(paragraph.text, cell.text)
  assert.equal(validateTranslation(paragraph, "译文 | extra"), undefined)
  assert.ok(validateTranslation(cell, "译文 | extra") instanceof ModelRetry)
  let calls = 0
  const action = async (input: TranslationInput) => {
    calls++
    return input.units.map((unit) => ({ id: unit.id, text: unit.display ? "阅读文本。" : "译文 | extra" }))
  }
  await store.translate("roles", { units: [paragraph] }, action, new AbortController().signal)
  const result = await store.translate("roles", { units: [cell] }, action, new AbortController().signal)
  assert.equal(result.get(cell.id), "阅读文本。")
  assert.equal(calls, 2)
})

test("overlapping in-flight unit sets share existing work and cancellation retains the remaining consumer", async () => {
  const store = new TranslationStore()
  const units = listBatch(3).units
  const tasks: { input: TranslationInput; signal: AbortSignal; finish: (value: readonly TranslationItem[]) => void }[] = []
  const action = (input: TranslationInput, signal: AbortSignal) => new Promise<readonly TranslationItem[]>((finish) => tasks.push({ input, signal, finish }))
  const firstController = new AbortController()
  const first = store.translate("overlap", { units: units.slice(0, 2) }, action, firstController.signal)
  await waitFor(() => tasks.length === 1)
  const second = store.translate("overlap", { units: units.slice(1) }, action, new AbortController().signal)
  await waitFor(() => tasks.length === 2)
  assert.deepEqual(
    tasks[1].input.units.map((unit) => unit.text),
    [units[2].text]
  )
  firstController.abort()
  await assert.rejects(first)
  assert.equal(tasks[0].signal.aborted, false)
  for (const task of tasks) task.finish(task.input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  const result = await second
  assert.equal(result.get(units[1].id), units[1].text)
  assert.equal(result.get(units[2].id), units[2].text)
})

test("unchanged results stay completed and cached while representation noise is suppressed without hiding content changes", async (t) => {
  let returned = ""
  const fixture = await chatFixture(t, () => returned)
  const cases: { format: "markdown" | "yaml" | "text"; kind?: "string" | "comment"; content?: string; original: string; returned: string; unchanged: boolean }[] = [
    { format: "markdown", original: "AcmeSDK product name.", returned: "AcmeSDK product name.", unchanged: true },
    { format: "markdown", original: "AcmeSDK product name.", returned: "\r\nAcmeSDK product name.\r\n", unchanged: true },
    { format: "yaml", original: '"AcmeSDK"', content: "AcmeSDK", returned: "AcmeSDK", unchanged: true },
    { format: "yaml", original: ">-\n  AcmeSDK", content: "AcmeSDK", returned: "AcmeSDK", unchanged: true },
    { format: "text", original: "// AcmeSDK product name.", returned: "  // AcmeSDK product name.  ", unchanged: true },
    { format: "text", kind: "string", original: '"AcmeSDK "', returned: '"AcmeSDK"', unchanged: false },
    { format: "yaml", original: '"AcmeSDK "', content: "AcmeSDK ", returned: "AcmeSDK", unchanged: false },
    { format: "markdown", original: "AcmeSDK product name.", returned: "acmesdk product name.", unchanged: false },
    { format: "markdown", original: "AcmeSDK product name.", returned: "AcmeSDK product name!", unchanged: false },
    { format: "markdown", original: "AcmeSDK product name.", returned: "AcmeSDK  product name.", unchanged: true },
    { format: "markdown", original: "AcmeSDK product name.", returned: "AcmeSDKproductname.", unchanged: true },
    { format: "markdown", original: "AcmeSDK\tproduct\u00a0name.", returned: "AcmeSDK product name.", unchanged: true },
    { format: "markdown", original: "Read the guide.\r\nContinue reading.", returned: "Readtheguide. Continuereading.", unchanged: true },
    { format: "text", kind: "comment", original: "/**\n * Read the guide.\n * Continue reading.\n */", returned: "Readtheguide. Continuereading.", unchanged: true },
    { format: "markdown", original: "Read `a b` carefully.", returned: "Read `ab` carefully.", unchanged: false },
    { format: "markdown", original: "Read [the guide](https://example.com).", returned: "Read [theguide](https://example.com).", unchanged: true },
    { format: "text", kind: "string", original: '"AcmeSDK product"', returned: '"AcmeSDKproduct"', unchanged: false },
    { format: "yaml", original: '"AcmeSDK product"', content: "AcmeSDK product", returned: "AcmeSDKproduct", unchanged: false }
  ]
  for (const [index, item] of cases.entries()) {
    returned = item.returned
    const unit = { id: "one", start: 0, end: item.original.length, text: item.original, content: item.content, format: item.format, kind: item.kind }
    const input = { units: [unit] }
    const store = new TranslationStore()
    const action = (batch: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
      requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed)
    const before = fixture.seen.length
    const progress: string[] = []
    const result = await store.translate(String(index), input, action, new AbortController().signal, false, (item) => progress.push(item.text))
    const expected = item.unchanged ? item.original : item.format === "yaml" ? JSON.stringify(item.returned) : item.returned
    assert.equal(result.get(unit.id), expected, JSON.stringify(item))
    assert.deepEqual(progress, [expected])
    assert.equal((await store.translate(String(index), input, action, new AbortController().signal)).get(unit.id), expected)
    assert.equal(fixture.seen.length, before + 1, "An unchanged result triggered a retry or escaped the cache.")
    store.clear()
  }
})

test("translated retry diagnostics are rejected per unit and never cached as source translations", async (t) => {
  const diagnosticTranslation = 'Item 1: translation-item-invalid reason: "The model returned invalid content."'
  const fixture = await chatFixture(t, (_body, _items, call) => {
    if (call === 1) return "\n%%\n"
    if (call === 2) return "正确的相邻译文。\n%%\n" + diagnosticTranslation
    return "正确的目标译文。"
  })
  const settings = { ...fixture.settings, batchShrinkFactor: 1, maxTranslationAttempts: 4 }
  const input: TranslationInput = {
    units: [
      { id: "neighbour", text: "Read the neighbouring rule.", start: 0, end: 26, format: "text" },
      { id: "target", text: "If a reading room has no spare maps, collect a printed guide at the front desk.", start: 27, end: 103, format: "text" }
    ]
  }
  const events: TranslationEvent[] = []
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate(
      serviceIdentity(settings),
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed, { details: true, emit: (event) => events.push(event) }),
      new AbortController().signal
    )
  const result = await translate()
  assert.equal(result.get("target"), "正确的目标译文。", "A translated diagnostic was accepted as the target's result.")
  assert.equal(result.get("neighbour"), "正确的相邻译文。")
  assert.deepEqual(
    fixture.seen.map(({ items }) => items.length),
    [2, 2, 1],
    "A repaired neighbour was resubmitted after diagnostic leakage."
  )
  assert.ok(events.some((event) => event.kind === "request" && event.failures.some((failure) => failure.code === "translation-feedback-leaked")))
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, 3, "The corrected result was not cached.")
})

test("retry feedback carries only the latest failed-unit diagnostic and repaired results remain cacheable", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => {
    if (call === 1) return items[0].replace("Original", "译文") + "\n%%\n" + dropLastProtection(items[1])
    if (call === 2) return items[0] + "\n\nExtra paragraph."
    return items[0].replace("Keep", "保留")
  })
  const input = inputOf(parseMarkdown("Original neighbour.\n\nKeep `privateCode_abcdefghijklmnopqrstuvwxyz_123456789` unchanged."))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = () =>
    store.translate(
      serviceIdentity(fixture.settings),
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed),
      new AbortController().signal
    )
  const result = await translate()
  assert.equal(result.get(input.units[0].id), "译文 neighbour.")
  assert.equal(result.get(input.units[1].id), "保留 `privateCode_abcdefghijklmnopqrstuvwxyz_123456789` unchanged.")
  assert.equal(fixture.seen.length, 3)
  assert.deepEqual(
    fixture.seen.map(({ body }) => body.messages.map((message) => message.role)),
    [
      ["system", "user"],
      ["system", "user", "assistant", "user"],
      ["system", "user", "assistant", "user"]
    ]
  )
  const markerRetry = modelFeedback(fixture.seen[1].body)
  assert.ok(markerRetry.includes("<CTP...>") && markerRetry.includes("exactly once") && !/Item \d|Current request:|translation-marker-mismatch/.test(markerRetry))
  assert.ok(!markerRetry.includes("neighbour") && !markerRetry.includes("Item 2:"), "A validated neighbour leaked into retry feedback.")
  const structureRetry = modelFeedback(fixture.seen[2].body)
  assert.ok(structureRetry.includes("internal line break") && !structureRetry.includes("Extra paragraph."))
  assert.ok(!structureRetry.includes("exactly once"), "An earlier failure accumulated in the next request.")
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, 3, "Feedback changed the successful unit's cache identity.")
})

test("invalid units exhaust a finite budget while verified neighbours survive failure and offset changes in cache", async (t) => {
  let repair = false
  const fixture = await chatFixture(t, (_body, items) => items.map((text) => (!repair && text.includes("Keep") ? text + "\n\nExtra paragraph." : text)).join("\n\n%%\n\n"))
  const text = "1. Keep `code` unchanged.\n2. Retain the second paragraph.\n3. Retain the third paragraph."
  const original = inputOf(parseMarkdown(text))
  const store = new TranslationStore()
  const action = (input: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
    requestTranslation(fixture.service, fixture.settings, input, signal, fixture.gate, completed)
  const progress: string[] = []
  await assert.rejects(
    store.translate("same-profile", original, action, new AbortController().signal, false, (item) => progress.push(item.id)),
    /structure-invalid/
  )
  assert.deepEqual(new Set(progress), new Set(original.units.slice(1).map((unit) => unit.id)))
  assert.equal(fixture.seen.filter((call) => call.items.some((text) => text.includes("Keep"))).length, 3)
  assert.equal(fixture.seen.filter((call) => call.items.some((text) => text.includes("second"))).length, 1)
  repair = true
  const shifted = inputOf(parseMarkdown("\n\n" + text))
  const before = fixture.seen.length
  const result = await store.translate("same-profile", shifted, action, new AbortController().signal)
  assert.equal(fixture.seen.length, before + 1)
  assert.equal(fixture.seen.at(-1)!.items.length, 1)
  assert.deepEqual(
    shifted.units.map((unit) => result.get(unit.id)),
    shifted.units.map((unit) => unit.text)
  )
  await store.translate("same-profile", original, action, new AbortController().signal)
  assert.equal(fixture.seen.length, before + 1)
  store.clear()
})

test("Chinese script evidence handles short configuration comments without treating shared Han or mixed languages as Chinese", () => {
  const unit = (text: string) => ({ id: "language", text, start: 0, end: text.length, format: "text" as const })
  for (const text of ["默认展示 图书分类说明", "借阅时间统计 单位分钟", "图书借阅状态码", "图书借阅方式", "图书查询", "图书借阅 HTTP/2"])
    assert.equal(isTargetLanguage(unit(text), "zh-CN"), true, text)
  for (const text of [
    "图书借阅 API",
    "图书借阅 HTTP(S)",
    "你好",
    "使用方法",
    "設定項目",
    "将来計画",
    "与信管理",
    "图书借阅 dashboard",
    "图书借阅。設定項目",
    "图书借阅。これは日本語です。",
    "图书借阅 한국어"
  ])
    assert.equal(isTargetLanguage(unit(text), "zh-CN"), false, text)
  assert.equal(isTargetLanguage(unit("图书借阅方式"), "en"), false)
})

test("technical code values complete locally while ambiguous names remain translatable and cached results preserve the exact source", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => (item === "all" ? "全部" : item)).join("\n%%\n"))
  const values = [
    "借阅时间统计 单位分钟",
    "图书借阅状态码",
    "图书借阅方式",
    "12345678-1234-5678-9abc-123456789abc",
    "https://example.com/a?x=1&y=two",
    "sampleGroup",
    "SAMPLE_NOTICE_KEY_5XX",
    "GET",
    "POST",
    "4xx",
    "5xx",
    "all",
    "sampleword",
    "sample-library",
    "Read the original document."
  ]
  const input: TranslationInput = {
    units: values.map((value, index) => ({
      id: String(index),
      start: index * 100,
      end: index * 100 + value.length + 2,
      text: "'" + value + "'",
      format: "text",
      kind: "string",
      protected: [
        { start: 0, end: 1 },
        { start: value.length + 1, end: value.length + 2 }
      ]
    }))
  }
  const settings = { ...fixture.settings, skipSameLanguage: true }
  const events: TranslationEvent[] = []
  const store = new TranslationStore()
  t.after(() => store.clear())
  let taskFinished: Promise<readonly TranslationItem[]> | undefined
  const translate = () =>
    store.translate(
      serviceIdentity(settings),
      input,
      (batch, signal, completed) => {
        taskFinished = requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed, { details: true, emit: (event) => events.push(event) })
        return taskFinished
      },
      new AbortController().signal
    )
  const result = await translate()
  await taskFinished
  assert.deepEqual(
    fixture.seen.flatMap((request) => request.items),
    [...values.slice(5, 7), ...values.slice(11)]
  )
  assert.deepEqual(
    input.units.map((unit) => result.get(unit.id)),
    input.units.map((unit) => (unit.text === "'all'" ? "'全部'" : unit.text))
  )
  const finish = events.find((event) => event.kind === "finish")!
  assert.ok(finish.kind === "finish" && finish.skipped === 3 && finish.changed === 1 && finish.unchanged === 11 && !finish.failures.length)
  const calls = fixture.seen.length
  assert.deepEqual(await translate(), result)
  assert.equal(fixture.seen.length, calls, "A locally completed value bypassed the shared cache.")
})

test("target-language units avoid HTTP, preserve batch context and cache, and disabling the rule invalidates skip results", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body).replace("Read the original document.", "阅读原始文档。"))
  const chinese = "这是已经写好的中文说明，不需要再次请求翻译服务。"
  const input = inputOf(parseMarkdown(chinese + "\n\nRead the original document."))
  const settings = { ...fixture.settings, skipSameLanguage: true }
  const store = new TranslationStore()
  const action = (batch: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
    requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed)
  const result = await store.translate(serviceIdentity(settings), input, action, new AbortController().signal)
  assert.equal(result.get(input.units[0].id), chinese)
  assert.equal(result.get(input.units[1].id), "阅读原始文档。")
  assert.equal(fixture.seen.length, 1)
  assert.deepEqual(fixture.seen[0].items, ["Read the original document."])
  assert.equal(modelContext(fixture.seen[0].body), chinese + "\n\nRead the original document.", "Skipping translation removed the short target's preceding source context.")
  await store.translate(serviceIdentity(settings), input, action, new AbortController().signal)
  assert.equal(fixture.seen.length, 1)
  const onlyChinese = inputOf(parseMarkdown(chinese))
  await requestTranslation(fixture.service, settings, onlyChinese, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen.length, 1, "An all-target-language batch reached HTTP.")
  const disabled = { ...settings, skipSameLanguage: false }
  assert.notEqual(serviceIdentity(settings), serviceIdentity(disabled))
  await store.translate(
    serviceIdentity(disabled),
    onlyChinese,
    (batch, signal, accepted) => requestTranslation(fixture.service, disabled, batch, signal, fixture.gate, accepted),
    new AbortController().signal
  )
  assert.equal(fixture.seen.length, 2)
  assert.deepEqual(fixture.seen.at(-1)!.items, [chinese])
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(requestTranslation(fixture.service, settings, onlyChinese, cancelled.signal, fixture.gate))
  assert.equal(fixture.seen.length, 2)
  store.clear()
})

test("default logging shows a task lifecycle without successful request or cache-hit noise", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const entries: string[] = []
  const log = new TranslationLog((entry) => entries.push(entry))
  await requestTranslation(fixture.service, fixture.settings, listBatch(3), new AbortController().signal, fixture.gate, undefined, {
    details: false,
    emit: (event) => log.record(event, logContext)
  })
  assert.equal(entries.length, 2)
  assert.ok(entries.every((entry) => entry.includes("[T1]") && !entry.includes("/R") && !entry.includes("system=")))
  log.configure("info", true)
  log.reused({ kind: "cache", count: 3, total: 3 }, "sample.md", "")
  log.reused({ kind: "pending", count: 1, total: 3 }, "sample.md", "")
  assert.equal(entries.length, 2, "Details mode turned cache hits and shared work into repeated task logs.")
  log.reused({ kind: "cache", count: 1, total: 3 }, "sample.md", "")
  assert.equal(entries.length, 3)
  log.configure("warning", true)
  await requestTranslation(fixture.service, fixture.settings, listBatch(1), new AbortController().signal, fixture.gate, undefined, {
    details: true,
    emit: (event) => log.record(event, logContext)
  })
  assert.equal(entries.length, 3, "A suppressed request still emitted its system definition.")
})

test("YAML keys and values with identical text keep separate pending work and cached normalized results", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map(() => "标签：").join("\n%%\n"))
  const settings = { ...fixture.settings, maxContextCharacters: 0 }
  const input = prepareInput(settings, inputOf(parseMarkdown("---\nlabel: label\n---")))
  const [key, value] = input.units
  const store = new TranslationStore()
  const action = (batch: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
    requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed)
  const result = await store.translate(serviceIdentity(settings), input, action, new AbortController().signal)
  assert.equal(translationDisplayText(result.get(key.id)!, "yaml"), "标签")
  assert.equal(translationDisplayText(result.get(value.id)!, "yaml"), "标签：")
  const before = fixture.seen.length
  for (const unit of [value, key]) {
    const cached = await store.translate(serviceIdentity(settings), { units: [unit] }, action, new AbortController().signal)
    assert.equal(cached.get(unit.id), result.get(unit.id))
  }
  assert.equal(fixture.seen.length, before, "Validated normalized results were requested again.")
})

test("an aligned empty response retries only its missing item and caches the valid neighbour", async (t) => {
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? "\n%%\n" + items[1] : items.join("\n%%\n")))
  const input = listBatch(2)
  const store = new TranslationStore()
  const action = (batch: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
    requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed)
  const published: string[] = []
  const result = await store.translate("aligned-empty", input, action, new AbortController().signal, false, (item) => published.push(item.id))
  assert.equal(result.size, 2)
  assert.deepEqual(
    fixture.seen.map((call) => call.items.length),
    [2, 1]
  )
  assert.equal(published[0], input.units[1].id)
  await store.translate("aligned-empty", input, action, new AbortController().signal)
  assert.equal(fixture.seen.length, 2)
  store.clear()
})

test("joining partially completed work reports shared progress rather than repeated partial-cache refills", async () => {
  const store = new TranslationStore()
  const input = listBatch(2)
  const reuse: { kind: string; count: number; total: number }[] = []
  let finish: ((content: readonly TranslationItem[]) => void) | undefined
  let canonical: TranslationInput | undefined
  const first = store.translate(
    "shared-progress",
    input,
    async (batch, _signal, completed) => {
      canonical = batch
      completed({ id: batch.units[0].id, text: batch.units[0].text })
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    new AbortController().signal
  )
  await waitFor(() => !!finish)
  const second = store.translate(
    "shared-progress",
    input,
    async () => {
      throw Error("A joined consumer requested translation again.")
    },
    new AbortController().signal,
    false,
    undefined,
    (event) => reuse.push(event)
  )
  assert.deepEqual(reuse, [
    { kind: "cache", count: 1, total: 2 },
    { kind: "pending", count: 1, total: 2 }
  ])
  finish!(canonical!.units.map((unit) => ({ id: unit.id, text: unit.text })))
  assert.equal((await first).size, 2)
  assert.equal((await second).size, 2)
  const cached = await store.translate(
    "shared-progress",
    input,
    async () => {
      throw Error("A cache hit requested translation again.")
    },
    new AbortController().signal,
    false,
    undefined,
    (event) => reuse.push(event)
  )
  assert.equal(cached.size, 2)
  assert.deepEqual(reuse.at(-1), { kind: "cache", count: 2, total: 2 })
  store.clear()
})

test("changing a preserve regex or its flags isolates cached local completion", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => (item === "HTTP" ? "协议" : item)).join("\n%%\n"))
  const input = inputOf(parseMarkdown("HTTP"))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const translate = (pattern: string, flags: string) => {
    const settings = { ...fixture.settings, preserveTerms: parsePreserveTerms([{ pattern, flags }]), skipSameLanguage: false }
    return store.translate(serviceIdentity(settings), input, (batch, signal) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate), new AbortController().signal)
  }
  assert.equal((await translate("http", "i")).get(input.units[0].id), "HTTP")
  assert.equal((await translate("HTTP", "")).get(input.units[0].id), "HTTP")
  assert.equal(fixture.seen.length, 0)
  assert.equal((await translate("http", "")).get(input.units[0].id), "协议")
  assert.equal((await translate("https", "i")).get(input.units[0].id), "协议")
  assert.equal(fixture.seen.length, 2, "A regex pattern or flags change reused a previous identity.")
})
