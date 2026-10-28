import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import type { TranslationItem } from "../src/model/translation.ts"
import { BrowseSession } from "../src/features/browse/session.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { renderPrompt } from "../src/translation/providers/prompts.ts"
import { embeddedMarkdown, requestTranslation, source, sessionResponse, sessionFor, waitFor, settled, modelInput, chatFixture, listBatch } from "./support/fixtures.ts"

test("editing keeps completed neighbours visible through debounce and reparsing without loading them again", async () => {
  let source = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
  const requested: TranslationInput[] = []
  const snapshots: ReturnType<BrowseSession["inspect"]>[] = []
  const session = new BrowseSession(
    async (input) => {
      requested.push(input)
      return new Map(input.units.map((unit) => [unit.id, "译文：" + unit.text]))
    },
    () => snapshots.push(session.inspect())
  )
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await settled(session)
  snapshots.length = 0
  for (const [index, edit] of [
    { rangeOffset: source.indexOf("Second") + 2, rangeLength: 0, text: "x" },
    { rangeOffset: 0, rangeLength: 0, text: "\n\n" }
  ].entries()) {
    // The edit event carries the offsets of its immediately preceding version.
    session.invalidate(index + 2, [edit])
    source = source.slice(0, edit.rangeOffset) + edit.text + source.slice(edit.rangeOffset + edit.rangeLength)
    session.setVisibleRanges([{ start: 0, end: source.length }])
    assert.deepEqual(
      session.inspect().units.map((unit) => source.slice(unit.start, unit.end)),
      ["First paragraph.", "Third paragraph."]
    )
    assert.equal(session.inspect().loading.length, 0)
    assert.equal(requested.length, 1, "Viewport refresh bypassed the edit debounce.")
  }
  session.update(parseMarkdown(source), 3)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  assert.deepEqual(
    session.inspect().loading.map((unit) => unit.text),
    ["Sexcond paragraph."]
  )
  assert.ok(
    snapshots.every((snapshot) => snapshot.units.length >= 2),
    "An edit or reparse temporarily removed unchanged translation rows."
  )
  await settled(session)
  assert.equal(session.inspect().units.length, 3)
  session.dispose()
})

test("editing cancels old work and reparsing rejects retained results whose syntax role changed", async () => {
  const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.")
  let complete!: (result: ReadonlyMap<string, string>) => void
  let publish!: (item: TranslationItem) => void
  const session = new BrowseSession(
    (_input, _signal, _force, completed) =>
      new Promise((resolve) => {
        complete = resolve
        publish = (item) => completed?.(item)
      }),
    () => {}
  )
  session.update(parsed, 1)
  session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
  const [first, second] = parsed.groups.flatMap((group) => group.units)
  publish({ id: first.id, text: "第一段。" })
  session.invalidate(2, [{ rangeOffset: parsed.source.length, rangeLength: 0, text: "\n" }])
  assert.equal(session.inspect().units.length, 1)
  assert.equal(session.inspect().loading.length, 0)
  publish({ id: second.id, text: "旧版本迟到结果。" })
  complete(
    new Map([
      [first.id, "第一段。"],
      [second.id, "旧版本迟到结果。"]
    ])
  )
  await delay(0)
  assert.equal(session.inspect().units.length, 1)
  session.update({ ...parsed, groups: [{ start: first.start, end: first.end, units: [{ ...first, kind: "comment" }] }] }, 2)
  assert.equal(session.inspect().units.length, 0, "Reparsing promoted a result into a different syntax role.")
  session.dispose()
})

test("typing at prose boundaries and deleting paragraph separators invalidates affected translations immediately", async () => {
  const source = "First paragraph.\n\nSecond paragraph."
  const parsed = parseMarkdown(source)
  const [first, second] = parsed.groups.flatMap((group) => group.units)
  for (const edit of [
    { rangeOffset: first.start, rangeLength: 0, text: "x" },
    { rangeOffset: first.end, rangeLength: 0, text: "x" },
    { rangeOffset: first.end, rangeLength: second.start - first.end, text: "" }
  ]) {
    const session = sessionFor(async (input) => input.units.map((unit) => ({ id: unit.id, text: "译文：" + unit.text })))
    session.update(parsed, 1)
    session.setVisibleRanges([{ start: 0, end: source.length }])
    await settled(session)
    session.invalidate(2, [edit])
    assert.deepEqual(
      session.inspect().units.map((unit) => unit.text),
      edit.rangeLength ? [] : [second.text]
    )
    assert.equal(session.inspect().loading.length, 0)
    session.dispose()
  }
})

test("block retranslation refreshes only the target, preserves neighbours and caches an unchanged result", async () => {
  const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.")
  const units = parsed.groups.flatMap((group) => group.units)
  const requested: TranslationInput[] = []
  const session = sessionFor(async (input) => {
    requested.push(input)
    return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
  })
  try {
    session.update(parsed, 1)
    session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
    await settled(session)
    assert.equal(session.retranslate({ start: units[1].start + 2, end: units[1].start + 5 }), true)
    assert.deepEqual(
      session.inspect().units.map((unit) => unit.id),
      [units[0].id, units[2].id]
    )
    assert.deepEqual(
      session.inspect().loading.map((unit) => unit.id),
      [units[1].id]
    )
    await settled(session)
    assert.equal(requested.length, 2)
    assert.deepEqual(
      requested[1].units.map((unit) => unit.text),
      [units[1].text]
    )
    session.cancel()
    assert.equal(session.retranslate({ start: units[1].start, end: units[1].end }), true)
    await settled(session)
    assert.equal(requested.length, 3)
    assert.equal(session.inspect().units.length, 1, "Retranslating after cancellation resumed unrelated blocks.")
    session.restart()
    await settled(session)
    assert.equal(requested.length, 3, "A successful unchanged retranslation was not cached.")
    assert.equal(session.inspect().units.length, 3)
  } finally {
    session.dispose()
  }
})

test("manual blocks accumulate without viewport translation, retry only selected units and expand explicitly to document browse", async () => {
  const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.")
  const units = parsed.groups.flatMap((group) => group.units)
  const requested: string[][] = []
  const session = new BrowseSession(
    async (input) => {
      requested.push(input.units.map((unit) => unit.id))
      return new Map(input.units.map((unit) => [unit.id, "译文：" + unit.text]))
    },
    () => {},
    undefined,
    "blocks"
  )
  try {
    session.update(parsed, 1)
    session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
    assert.equal(requested.length, 0)
    assert.equal(session.retranslate({ start: units[1].start, end: units[1].start }), true)
    await settled(session)
    const first = session.inspect().units[0]
    session.setVisibleRanges([])
    session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
    assert.deepEqual(requested, [[units[1].id]])
    session.retranslate({ start: units[0].start, end: units[0].end })
    await settled(session)
    assert.equal(session.inspect().units[1], first)
    assert.equal(session.inspect().scope, "blocks")
    assert.equal(session.inspect().total, 2)
    session.cancel()
    session.restart()
    await settled(session)
    assert.deepEqual(requested[2], [units[0].id, units[1].id])
    session.enableBrowse()
    await settled(session)
    assert.deepEqual(requested[3], [units[2].id])
    assert.equal(session.inspect().scope, "document")
    assert.equal(session.inspect().units.length, 3)
  } finally {
    session.dispose()
  }
})

test("editing a manual block session clears obsolete targets and never guesses their new positions", async () => {
  const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.")
  let calls = 0
  const session = new BrowseSession(
    async (input) => {
      calls++
      return new Map(input.units.map((unit) => [unit.id, unit.text]))
    },
    () => {},
    undefined,
    "blocks"
  )
  try {
    session.update(parsed, 1)
    session.retranslate({ start: 0, end: 0 })
    await settled(session)
    session.update(parseMarkdown("New heading.\n\n" + parsed.source), 2)
    session.setVisibleRanges([{ start: 0, end: 1000 }])
    session.restart(true)
    assert.equal(calls, 1)
    assert.equal(session.inspect().total, 0)
    assert.equal(session.inspect().units.length, 0)
  } finally {
    session.dispose()
  }
})

test("block targets follow display rows for tables, YAML fields and embedded YAML, with half-open selection boundaries", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const cases = [
      { parsed: parseMarkdown(["| Name | Detail |", "| --- | --- |", "| Read | Keep |", "| Other | More |"].join(newline)), target: "Read", count: 2 },
      { parsed: parseYaml(["name: Read", "description: |-", "  Keep", "  going", "enabled: true"].join(newline)), target: "name:", count: 2 },
      { parsed: parseYaml(["name: Read", "description: |-", "  Keep", "  going", "enabled: true"].join(newline)), target: "  going", count: 2 },
      {
        parsed: await embeddedMarkdown(["> ```yaml", "> name: Read", "> enabled: true", "> ```"].join(newline)),
        target: "name:",
        count: 2
      }
    ]
    for (const { parsed, target, count } of cases) {
      let requested: TranslationInput | undefined
      const session = new BrowseSession(
        async (input, _signal, force) => {
          assert.equal(force, true)
          requested = input
          return new Map(input.units.map((unit) => [unit.id, unit.text]))
        },
        () => {}
      )
      try {
        session.update(parsed, 1)
        const offset = parsed.source.indexOf(target)
        assert.equal(session.retranslate({ start: offset, end: offset }), true)
        assert.equal(requested!.units.length, count)
        assert.ok(requested!.units.every((unit) => unit.display?.start === requested!.units[0].display?.start && unit.display?.end === requested!.units[0].display?.end))
        await settled(session)
      } finally {
        session.dispose()
      }
    }
    const parsed = parseMarkdown(["First paragraph.", "", "Second paragraph."].join(newline))
    const session = sessionFor(async (input) => input.units.map((unit) => ({ id: unit.id, text: unit.text })))
    session.update(parsed, 1)
    assert.equal(session.retranslate({ start: 0, end: parsed.groups[1].start }), true)
    assert.equal(session.inspect().loading.length, 1, "A selection ending at the next block start also selected that block.")
    await settled(session)
    assert.equal(session.retranslate({ start: parsed.groups[0].end, end: parsed.groups[0].end }), false, "Whitespace guessed a nearby block.")
    session.dispose()
  }
})

test("retranslating an in-flight block rejects stale success and failure without aborting a pending neighbour", async () => {
  for (const staleFailure of [false, true]) {
    const tasks: { input: TranslationInput; signal: AbortSignal; resolve(value: readonly TranslationItem[]): void; reject(error: Error): void }[] = []
    const session = sessionFor((input, signal) => new Promise((resolve, reject) => tasks.push({ input, signal, resolve, reject })))
    const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.")
    const target = parsed.groups[0].units[0]
    try {
      session.update(parsed, 1)
      session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
      await waitFor(() => tasks.length === 1)
      session.retranslate({ start: target.start, end: target.start })
      await waitFor(() => tasks.length === 2)
      assert.equal(tasks[0].signal.aborted, false, "The target aborted its unrelated pending neighbour.")
      assert.equal(session.inspect().loading.length, 2, "The stale target remained in loading state alongside its replacement.")
      session.retranslate({ start: target.start, end: target.start })
      await waitFor(() => tasks[1].signal.aborted)
      tasks[1].resolve(tasks[1].input.units.map((unit) => ({ id: unit.id, text: "过期译文。" })))
      await waitFor(() => tasks.length === 3)
      tasks[2].resolve(tasks[2].input.units.map((unit) => ({ id: unit.id, text: "最新译文。" })))
      await waitFor(() => session.inspect().units.some((unit) => unit.translation === "最新译文。"))
      if (staleFailure) tasks[0].reject(Error("service-http-500"))
      else tasks[0].resolve(tasks[0].input.units.map((unit) => ({ id: unit.id, text: "旧请求译文。" })))
      await settled(session)
      assert.equal(session.inspect().units.find((unit) => unit.id === target.id)?.translation, "最新译文。")
      assert.deepEqual(
        session.inspect().failedUnits.map(({ unit }) => unit.id),
        staleFailure ? [parsed.groups[1].units[0].id] : []
      )
      if (!staleFailure) {
        session.cancel()
        session.restart()
        await settled(session)
        assert.equal(session.inspect().units.find((unit) => unit.id === target.id)?.translation, "最新译文。", "A late response overwrote the refreshed cache.")
        assert.equal(tasks.length, 3)
      }
    } finally {
      session.dispose()
    }
  }
})

test("failed block retranslation preserves neighbours and editing invalidates its late completion", async () => {
  const tasks: { input: TranslationInput; publish(item: TranslationItem): void; resolve(value: ReadonlyMap<string, string>): void; reject(error: Error): void }[] = []
  const session = new BrowseSession(
    (input, _signal, _force, completed) => new Promise((resolve, reject) => tasks.push({ input, publish: (item) => completed?.(item), resolve, reject })),
    () => {}
  )
  const parsed = parseMarkdown("First paragraph.\n\nSecond paragraph.")
  const target = parsed.groups[0].units[0]
  try {
    session.update(parsed, 1)
    session.setVisibleRanges([{ start: 0, end: parsed.source.length }])
    tasks[0].resolve(new Map(tasks[0].input.units.map((unit) => [unit.id, unit.text])))
    await settled(session)
    session.retranslate({ start: target.start, end: target.start })
    tasks[1].reject(Error("service-http-500"))
    await settled(session)
    assert.deepEqual(
      session.inspect().failedUnits.map(({ unit }) => unit.id),
      [target.id]
    )
    assert.deepEqual(
      session.inspect().units.map((unit) => unit.id),
      [parsed.groups[1].units[0].id]
    )
    session.retranslate({ start: target.start, end: target.start })
    assert.deepEqual(session.inspect().failedUnits, [])
    session.update(parseMarkdown("Edited document."), 2)
    tasks[2].publish({ id: target.id, text: "过期译文。" })
    tasks[2].resolve(new Map([[target.id, "过期译文。"]]))
    await delay(0)
    assert.equal(session.inspect().version, 2)
    assert.deepEqual(session.inspect().units, [])
  } finally {
    session.dispose()
  }
})

test("editing, cancellation and close reject a late response even if the transport ignores abort", async () => {
  let finish: (text: readonly TranslationItem[]) => void = () => {}
  const session = sessionFor(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await delay(5)
  session.update(parseMarkdown("New document text."), 2)
  finish(sessionResponse)
  await delay(5)
  assert.equal(session.inspect().version, 2)
  assert.equal(session.inspect().units.length, 0)
  session.cancel()
  session.setVisibleRanges([{ start: 0, end: 100 }])
  assert.equal(session.inspect().status, "cancelled")
  session.dispose()
  assert.equal(session.inspect().units.length, 0)
})

test("repeated visibility reuses pending units and extending the viewport requests only the newly visible unit", async () => {
  const tasks: { input: TranslationInput; finish: (value: readonly TranslationItem[]) => void }[] = []
  const session = sessionFor((input) => new Promise((finish) => tasks.push({ input, finish })))
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: 5 }])
  session.setVisibleRanges([{ start: 0, end: 10 }])
  await waitFor(() => tasks.length === 1)
  assert.equal(tasks[0].input.units.length, 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await waitFor(() => tasks.length === 2)
  assert.equal(tasks[1].input.units.length, 1)
  assert.notEqual(tasks[0].input.units[0].text, tasks[1].input.units[0].text)
  for (const task of tasks) task.finish(task.input.units.map((unit) => ({ id: unit.id, text: unit.text })))
  await settled(session)
  assert.equal(session.inspect().units.length, 2)
  session.dispose()
})

test("scrolling away keeps submitted units alive and returning reuses pending and completed translations", async () => {
  const tasks: { input: TranslationInput; signal: AbortSignal; finish: (value: readonly TranslationItem[]) => void }[] = []
  const session = sessionFor((input, signal) => new Promise((finish) => tasks.push({ input, signal, finish })))
  try {
    session.update(parseMarkdown(source), 1)
    session.setVisibleRanges([{ start: 0, end: 5 }])
    await waitFor(() => tasks.length === 1)
    session.setVisibleRanges([{ start: source.length - 5, end: source.length }])
    await waitFor(() => tasks.length === 2)
    assert.ok(
      tasks.every((task) => !task.signal.aborted),
      "Scrolling aborted a submitted translation."
    )
    assert.equal(session.inspect().loading.length, 2)
    session.setVisibleRanges([])
    session.setVisibleRanges([{ start: 0, end: 5 }])
    assert.equal(session.inspect().pending, 2, "Returning to a pending unit submitted it again.")
    session.setVisibleRanges([])
    for (const task of tasks) task.finish(task.input.units.map((unit) => ({ id: unit.id, text: unit.text })))
    await settled(session)
    assert.equal(session.inspect().status, "ready")
    assert.equal(session.inspect().units.length, 2, "Offscreen results were discarded.")
    assert.equal(session.inspect().loading.length, 0)
    session.setVisibleRanges([{ start: 0, end: source.length }])
    assert.equal(session.inspect().pending, 0)
    assert.equal(tasks.length, 2, "Returning to completed units repeated translation.")
    session.cancel()
    session.restart()
    await settled(session)
    assert.equal(tasks.length, 2, "Offscreen results were not cached.")
    assert.equal(session.inspect().units.length, 2)
  } finally {
    session.dispose()
  }
})

test("forced retranslation edition an in-flight response", async () => {
  const complete: ((value: readonly TranslationItem[]) => void)[] = []
  const session = sessionFor(
    () =>
      new Promise((resolve) => {
        complete.push(resolve)
      })
  )
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await waitFor(() => complete.length === 1)
  session.restart(true)
  await waitFor(() => complete.length === 2)
  assert.equal(complete.length, 2)
  complete[0]([])
  complete[1](sessionResponse)
  await settled(session)
  assert.equal(session.inspect().status, "ready")
  assert.equal(session.inspect().units.length, 2)
  session.dispose()
})

test("visible units, shared cache and forced retranslation operate on validated results", async () => {
  let requests = 0
  const session = sessionFor(async () => {
    requests++
    return sessionResponse
  })
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await settled(session)
  assert.equal(session.inspect().units.length, 2)
  session.cancel()
  session.restart()
  await settled(session)
  assert.equal(requests, 1)
  session.restart(true)
  await settled(session)
  assert.equal(requests, 2)
  session.dispose()
})

test("unit cache evicts old large results instead of growing with each edited document version", async () => {
  let requests = 0
  const session = sessionFor(async (item) => {
    requests++
    return item.units.map((unit) => ({ id: unit.id, text: unit.text }))
  })
  const content = (version: number) => `Document number ${version}. ` + "payload ".repeat(1800)
  for (let version = 1; version <= 66; version++) {
    session.update(parseMarkdown(content(version)), version)
    session.setVisibleRanges([{ start: 0, end: 100 }])
    await settled(session)
  }
  session.update(parseMarkdown(content(66)), 67)
  session.setVisibleRanges([{ start: 0, end: 100 }])
  await settled(session)
  assert.equal(requests, 66)
  session.update(parseMarkdown(content(1)), 68)
  session.setVisibleRanges([{ start: 0, end: 100 }])
  await settled(session)
  assert.equal(requests, 67)
  session.dispose()
})

test("bad responses leave source units untranslated until the user retries", async () => {
  let invalid = true
  const session = sessionFor(async () => (invalid ? [] : sessionResponse))
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await settled(session)
  assert.equal(session.inspect().status, "error")
  assert.equal(session.inspect().units.length, 0)
  invalid = false
  session.restart()
  await settled(session)
  assert.equal(session.inspect().units.length, 2)
  session.dispose()
})

test("conditional prompt blocks omit related instructions, nest safely and never interpret inserted source", async (t) => {
  const source = "Original {{#if context}}${targetLang}{{/if}} and $&."
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const request = { settings: fixture.settings, context: " \n\t", items: [{ id: "one", text: source, format: "text" as const }] }
  const template = "before{{#if context}}REFERENCE: ${context}{{#if isBatch}} BATCH=${itemCount}{{/if}}{{/if}}{{#if hasProtectedMarkers}} MARKERS{{/if}}after\n${content}"
  assert.equal(renderPrompt(template, request, "%%"), "beforeafter\n" + source)
  const withContext = { ...request, context: "Read the full context.", items: [{ ...request.items[0], hasMarkers: true }] }
  assert.equal(renderPrompt(template, withContext, "%%"), "beforeREFERENCE: Read the full context. MARKERSafter\n" + source)
  assert.equal(renderPrompt(template, { ...withContext, context: "" }, "%%"), "before MARKERSafter\n" + source)
  assert.equal(
    renderPrompt(template, { ...withContext, items: [...withContext.items, { ...withContext.items[0], id: "two" }] }, "%%"),
    "beforeREFERENCE: Read the full context. BATCH=2 MARKERSafter\n" + source + "\n\n%%\n\n" + source
  )
  assert.throws(() => renderPrompt("{{#if context}}unclosed", request, "%%"), /prompt-template-invalid/)
  assert.throws(() => renderPrompt("{{#if context}", request, "%%"), /prompt-template-invalid/)
  assert.throws(() => renderPrompt("{{#if}}", request, "%%"), /prompt-template-invalid/)
  assert.throws(() => renderPrompt("{{/if}}", request, "%%"), /prompt-template-invalid/)
  assert.throws(() => renderPrompt("{{#if context.length}}expression{{/if}}", request, "%%"), /prompt-template-invalid/)
  const input = listBatch(1)
  await assert.rejects(
    requestTranslation(fixture.service, { ...fixture.settings, systemPrompt: "{{#if unknown}}invalid{{/if}}" }, input, new AbortController().signal, fixture.gate),
    /prompt-template-invalid/
  )
  assert.equal(fixture.seen.length, 0, "Invalid conditional syntax sent a request.")
  const session = sessionFor((batch, signal) => requestTranslation(fixture.service, { ...fixture.settings, systemPrompt: "{{#if unknown}}invalid{{/if}}" }, batch, signal, fixture.gate))
  session.update(parseMarkdown(source), 1)
  session.setVisibleRanges([{ start: 0, end: source.length }])
  await settled(session)
  assert.deepEqual(session.inspect().errors, ["prompt-template-invalid"], "Browse hid the actionable template diagnostic.")
  assert.equal(fixture.seen.length, 0)
  session.dispose()
})

test("loading units follow actual in-flight work, partial completion, failure, retry, cancellation and invalidation", async () => {
  const tasks: { resolve(result: ReadonlyMap<string, string>): void; reject(reason: Error): void; publish(item: { id: string; text: string }): void; batch: TranslationInput }[] = []
  const session = new BrowseSession(
    (batch, _signal, _force, completed) => new Promise((resolve, reject) => tasks.push({ resolve, reject, publish: (item) => completed?.(item), batch })),
    () => {}
  )
  const input = parseMarkdown("First paragraph.\n\nSecond paragraph.")
  session.update(input, 1)
  session.setVisibleRanges([{ start: 0, end: input.source.length }])
  assert.equal(session.inspect().loading.length, 2)
  const first = tasks[0].batch.units[0]
  tasks[0].publish({ id: first.id, text: "第一段。" })
  assert.deepEqual(
    session.inspect().loading.map((unit) => unit.id),
    [tasks[0].batch.units[1].id]
  )
  tasks[0].reject(Error("service-http-500"))
  await settled(session)
  assert.equal(session.inspect().loading.length, 0)
  assert.equal(session.inspect().units.length, 1)
  session.restart()
  assert.equal(session.inspect().loading.length, 1, "Retry marked an already accepted neighbour as pending.")
  session.cancel()
  assert.equal(session.inspect().loading.length, 0)
  tasks[1].publish({ id: first.id, text: "Late translation" })
  tasks[1].resolve(new Map(tasks[1].batch.units.map((unit) => [unit.id, unit.text])))
  await delay(0)
  assert.equal(session.inspect().loading.length, 0)
  assert.equal(session.inspect().units.length, 0)
  session.restart()
  assert.equal(session.inspect().loading.length, 2)
  session.update(parseMarkdown("Changed source."), 2)
  assert.equal(session.inspect().loading.length, 0)
  tasks[2].resolve(new Map(tasks[2].batch.units.map((unit) => [unit.id, unit.text])))
  await delay(0)
  assert.equal(session.inspect().units.length, 0)
  session.dispose()
})
