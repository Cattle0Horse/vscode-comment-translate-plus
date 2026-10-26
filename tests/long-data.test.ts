import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { validateTranslation } from "../src/documents/validation.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"
import { splitTranslations } from "../src/translation/providers/prompts.ts"
import { serviceIdentity, validateService } from "../src/translation/settings.ts"
import { TranslationStore } from "../src/translation/store.ts"

test("logged command reference accepts an exact expanded marker on the first request and caches both items", async (t) => {
  const source =
    "# Command Reference\n\nThis is the retained general-purpose command surface. Use `agent-browser <command> --help` for version-specific options or commands outside this reference."
  const output = "命令参考\n\n%%\n\n这是保留的通用命令界面。如需了解此参考范围之外的特定版本选项或命令，请使用 `agent-browser <command> --help`。"
  const fixture = await chatFixture(t, () => output)
  const settings = { ...fixture.settings, batchBySemanticScope: false }
  const input = inputOf(parseMarkdown(source))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = () =>
    store.translate(
      "expanded-command",
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed),
      new AbortController().signal
    )
  const result = await run()
  assert.equal(result.get(input.units[0].id), "# 命令参考")
  assert.equal(result.get(input.units[1].id), output.split("\n\n%%\n\n")[1])
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, 1, "An exact expanded source fragment consumed retries or did not enter the shared cache.")
})

test("expanded fragments preserve exact contents and multiplicity alongside markers", () => {
  const command = "`agent-browser <command> --help`"
  const url = "https://example.com/a-long-source-resource"
  const source = "Read " + command + " twice: " + command + ", then [guide](" + url + ")."
  const unit = inputOf(parseMarkdown(source)).units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  for (const output of [
    "阅读 " + command + " 两次：" + command + "，然后[指南](" + url + ")。",
    "阅读 <CTP1> 两次：" + command + "，然后[指南](<CTP2>)。",
    "阅读 <CTP0> 两次：<CTP1>，然后[指南](<CTP2>)。"
  ]) {
    const restored = prepared.restore(output)
    assert.equal(validateTranslation(unit, restored), undefined)
    assert.equal(restored.split(command).length - 1, 2)
    assert.ok(restored.includes(url))
  }
  assert.equal(prepared.restore(source), source, "Expanded echoes must remain successful unchanged results.")
  for (const output of [
    prepared.text.replace("<CTP0>", command.replace("--help", "--Help")),
    prepared.text.replace("<CTP0>", command.replace(" --help", "  --help")),
    prepared.text.replace("<CTP0>", command.replace("--help", "--帮助")),
    prepared.text.replace("<CTP0>", ""),
    prepared.text + command,
    source + command,
    source + "<CTP9>",
    source + "<CTP0"
  ])
    assert.throws(() => prepared.restore(output), /marker-mismatch/u)
  assert.ok(validateTranslation(unit, prepared.restore(source.replace("[guide](", "[guide]"))), "Expansion must not bypass link structure validation.")
})

test("expanded source data stays literal across namespace collisions, overlapping values and Python ordering", () => {
  const code = "`agent-browser <CTP0> --help .*$&`"
  const source = "Keep <CTP1_0> beside " + code + "."
  const unit = inputOf(parseMarkdown(source)).units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.restore(source.replace("Keep", "保留")), source.replace("Keep", "保留"))

  const short = "https://example.com/a-long-resource"
  const long = short + "/more-data"
  const text = "Read " + short + " and " + long
  const python = { id: "ordered", text, start: 0, end: text.length, format: "text" as const, kind: "string" as const, language: "python" }
  const ordered = prepareTranslation(python, emptyPreserveTerms, 32)
  assert.equal(ordered.restore(text.replace("Read", "阅读")), text.replace("Read", "阅读"))
  assert.throws(() => ordered.restore("阅读 " + long), /marker-mismatch/u, "A containing fragment cannot also supply the missing shorter fragment.")
  assert.throws(() => ordered.restore("阅读 " + long + " and " + short), /structure-invalid/u)
})

test("response boundaries preserve native CRLF syntax inside each item and retain aligned empty items", () => {
  const first = 'Skill {name} in this "\r\n        "session.'
  const second = "Read `first\r\nsecond`."
  assert.deepEqual(splitTranslations(first, "%%", 1), [first])
  assert.deepEqual(splitTranslations(first + "\r\n\r\n%%\r\n\r\n" + second, "%%", 2), [first, second])
  assert.deepEqual(splitTranslations("%%\r\n" + first, "%%", 2), ["", first])
  assert.deepEqual(splitTranslations(first + "\r\n%%\r\n", "%%", 2), [first, ""])
  const unit = inputOf(parseMarkdown("Keep `sourceId` unchanged.")).units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  const restored = prepared.restore("\r\n" + prepared.text + "\r\n")
  assert.equal(validateTranslation(unit, restored), undefined, "Boundary CRLF shifted a native code span during validation.")
})

test("copy-only fragments cross the length threshold without masking ordinary names or style boundaries", () => {
  for (const size of [31, 32, 33, 128, 2048]) {
    const url = "https://example.com/" + "a".repeat(size - 20)
    assert.equal(url.length, size)
    const unit = inputOf(parseMarkdown("Read **sourceId** at [guide](" + url + ").")).units[0]
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.hasMarkers, size >= 32)
    assert.ok(prepared.text.includes("**sourceId**"))
    assert.ok(prepared.text.includes(size >= 32 ? "[guide](<CTP0>)" : "[guide](" + url + ")"))
    const restored = prepared.restore(prepared.text.replace("Read", "阅读").replace("sourceId", "来源标识").replace("guide", "指南"))
    assert.equal(validateTranslation(unit, restored), undefined)
    assert.ok(restored.includes(url))
    if (size >= 32) {
      assert.ok("<CTP0>".length * 4 <= url.length)
      for (const output of [prepared.text.replace("<CTP0>", ""), prepared.text + "<CTP0>", prepared.text.replace("<CTP0>", "<CTP9>"), prepared.text.replace("<CTP0>", "<CTP0")])
        assert.throws(() => prepared.restore(output), /marker-mismatch/u)
    } else assert.throws(() => prepared.restore(prepared.text.replace(url, "https://other.example")), /structure-invalid/u)
  }
  const name = "runtime_context_snapshot_".repeat(20)
  const unit = { id: "name", text: "Read <" + name + "> and sourceId.", start: 0, end: name.length + 22, format: "text" as const, kind: "string" as const }
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.hasMarkers, false)
  assert.equal(prepared.restore("阅读 <运行时上下文快照> 和 来源标识。"), "阅读 <运行时上下文快照> 和 来源标识。")
})

test("long numeric and mixed data stay exact without an address or hash type registry", () => {
  for (const value of [
    ...[32, 40, 64, 96, 128].map((size) => "0123456789abcdef".repeat(size / 16).padEnd(size, "a")),
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "2001:0db8:0000:0000:0000:0000:192.0.2.1",
    "fe80:0000:0000:0000:0000:0000:0000:0001%eth0",
    "012432242..3".repeat(5),
    "0933.0sf0....ds".repeat(5),
    "2001:0db8:85a3:0000:0000:8a2e:0370:zzzz"
  ]) {
    const text = "Read " + value + " now."
    const unit = { id: "data", text, start: 0, end: text.length, format: "text" as const, kind: "string" as const }
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, "Read <CTP0> now.", value)
    assert.equal(prepared.restore("阅读 <CTP0> now."), "阅读 " + value + " now.")
  }
  for (const value of ["::1", "2001:db8::1", "sourceId", "runtime_context_snapshot", "word1", "a1"]) {
    const text = "Read " + value + " now."
    assert.equal(prepareTranslation({ id: "short", text, start: 0, end: text.length, format: "text", kind: "string" }, emptyPreserveTerms, 32).text, text)
  }
})

test("configured marker thresholds isolate cached and in-flight translations and validate before HTTP", async (t) => {
  const data = "0933.0sf0....ds".repeat(5)
  const source = "Read " + data + " now."
  const input = { units: [{ id: "mixed", text: source, start: 0, end: source.length, format: "text" as const, kind: "string" as const }] }
  const fixture = await chatFixture(t, (_body, items) => items[0].replace("Read", "阅读"))
  const store = new TranslationStore()
  t.after(() => store.clear())
  const run = (minimumMarkerCharacters: number) => {
    const settings = { ...fixture.settings, minimumMarkerCharacters }
    return store.translate(
      serviceIdentity(settings),
      input,
      (batch, signal, completed) => requestTranslation(fixture.service, settings, batch, signal, fixture.gate, completed),
      new AbortController().signal
    )
  }
  const [compressed, native] = await Promise.all([run(32), run(128)])
  assert.equal(compressed.get("mixed"), source.replace("Read", "阅读"))
  assert.deepEqual(native, compressed)
  assert.equal(fixture.seen.length, 2, "Different thresholds shared an in-flight request.")
  assert.deepEqual(new Set(fixture.seen.flatMap((request) => request.items)), new Set(["Read <CTP0> now.", source]))
  assert.deepEqual(await run(32), compressed)
  assert.deepEqual(await run(128), native)
  assert.equal(fixture.seen.length, 2, "A threshold change discarded its previous cache.")
  for (const minimumMarkerCharacters of [0, -1, 1.5, NaN, Infinity, 200001])
    assert.throws(() => validateService({ ...fixture.settings, minimumMarkerCharacters }), /service-settings-incomplete/u)
  const short = { ...input.units[0], text: "Read 0933.0sf0....ds now." }
  assert.equal(prepareTranslation(short, emptyPreserveTerms, 1).hasMarkers, false, "Lowering the threshold bypassed the minimum copying benefit.")
})

test("decoded JSON content translates labels without exposing serialization escapes or hiding This", async (t) => {
  const content =
    "<runtime_context_snapshot>\nThis is the complete application runtime context locked at run start.\n<user_timezone>\nAsia/Riyadh\n</user_timezone>\n<utc_date>2026-10-23</utc_date>\n</runtime_context_snapshot>"
  const text = JSON.stringify(content)
  const unit = { id: "json", text, content, start: 0, end: text.length, format: "text" as const, kind: "string" as const, language: "json" }
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.hasMarkers, false)
  assert.ok(prepared.text.includes("This is"))
  assert.ok(!prepared.text.includes("\\n"))
  assert.equal(prepared.restore(prepared.text), text)
  const output = prepared.text
    .replaceAll("runtime_context_snapshot", "运行时上下文快照")
    .replace("This is the complete application runtime context locked at run start.", "这是运行开始时锁定的完整应用运行时上下文。")
  const fixture = await chatFixture(t, () => output)
  const results = await requestTranslation(fixture.service, fixture.settings, { units: [unit] }, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen.length, 1)
  assert.equal(validateTranslation(unit, results[0].text), undefined)
  assert.ok(JSON.parse(results[0].text).includes("<运行时上下文快照>"))
  assert.ok(JSON.parse(results[0].text).includes("Asia/Riyadh"))
})
