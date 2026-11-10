import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"
import { protectSensitiveText, redactSensitiveText, sensitiveValues } from "../src/documents/secrets.ts"
import { ModelRetry } from "../src/model/diagnostics.ts"
import { performance } from "node:perf_hooks"

test("HTTP requests hide short credentials in body and references, restore locally and reuse cache", async (t) => {
  const secret = "mock-only-river"
  const fixture = await chatFixture(t, (_body, items) => items.map((text) => text.replace("Read the guide", "阅读指南")).join("\n%%\n"))
  fixture.settings.apiKey = secret
  const input = await prepareInput(fixture.settings, inputOf(parseMarkdown('Read the guide with password="' + secret + '".')))
  const store = new TranslationStore()
  const run = () =>
    store.translate("secrets", input, (batch, signal, completed) => fixture.service.request(fixture.settings, batch, signal, fixture.gate, completed), new AbortController().signal)
  const result = await run()
  assert.ok(fixture.seen.length > 0)
  assert.ok(!JSON.stringify(fixture.seen).includes(secret), "The actual HTTP request exposed the credential.")
  assert.equal(result.get(input.units[0].id), '阅读指南 with password="' + secret + '".')
  const calls = fixture.seen.length
  assert.deepEqual(await run(), result)
  assert.equal(fixture.seen.length, calls)
  store.clear()
})

test("configured secrets in YAML scalars stay local even with context disabled", async (t) => {
  const secret = "mock tiny password"
  const fixture = await chatFixture(t, (_body, items) => items.join("\n%%\n"))
  const settings = { ...fixture.settings, includeContext: false, apiKey: secret }
  const input = inputOf(parseYaml('password: "' + secret + '"\ncaption: Read the guide'))
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.ok(!JSON.stringify(fixture.seen).includes(secret), "Disabling context lost the field's privacy classification.")
  assert.equal(result.find((item) => item.id === input.units.find((unit) => unit.content === secret)!.id)!.text, '"' + secret + '"')
})

test("missing sensitive markers exhaust bounded retries without publishing a display candidate", async (t) => {
  const fixture = await chatFixture(t, () => "阅读指南。")
  fixture.settings.apiKey = "mock-secret"
  const published: unknown[] = []
  await assert.rejects(
    requestTranslation(fixture.service, fixture.settings, inputOf(parseMarkdown('Read the guide with password="mock-secret".')), new AbortController().signal, fixture.gate, (item) =>
      published.push(item)
    )
  )
  assert.equal(published.length, 0)
  assert.equal(fixture.seen.length, fixture.settings.maxTranslationAttempts)
  assert.ok(!JSON.stringify(fixture.seen).includes("mock-secret"))
})

test("Secretlint reports supported credential ranges while ordinary prose stays unchanged", async () => {
  const samples = [
    "ghp_" + "Ab12".repeat(9),
    "sk-" + "Aa12".repeat(5) + "T3BlbkFJ" + "Bc23".repeat(5),
    "AKIA" + "X1".repeat(8),
    "-----BEGIN RSA PRIVATE KEY-----\nMI" + "Ab12".repeat(30) + "\n-----END RSA PRIVATE KEY-----",
    "https://visitor:fiction@example.test/guide"
  ]
  for (const value of samples) {
    const source = "Read the guide with " + value
    const known = await sensitiveValues([source])
    assert.ok(known.length > 0)
    const protection = protectSensitiveText(source, known)
    assert.ok(!protection.text.includes(value))
    assert.ok(!redactSensitiveText(source, known).includes(value))
    assert.equal(protection.restore(protection.text), source)
  }
  const ordinary = "Read the guide for API keys and password policies. SHA256 abcdef0123456789abcdef0123456789; version 1.2.3; HTTP 200."
  assert.deepEqual(await sensitiveValues([ordinary]), [])
  const token = "ghp_" + "Ab12".repeat(9)
  assert.ok((await sensitiveValues(["// secretlint-disable\n" + token])).includes(token), "Source content disabled the outbound scanner.")
  assert.equal(redactSensitiveText(ordinary), ordinary)
  assert.equal(redactSensitiveText(redactSensitiveText('password="fiction"', ["fiction"]), ["fiction"]), 'password="[REDACTED]"')
})

test("sensitive markers preserve repeated values, isolate namespaces and reject damage without guessing", () => {
  const source = "Keep <REDACTED0_0> and password=fiction, then repeat fiction."
  const first = protectSensitiveText(source, ["fiction"], "")
  const second = protectSensitiveText("Read password=another.", ["another"], first.text)
  assert.equal(first.restore(first.text.replace("Keep", "保留")), source.replace("Keep", "保留"))
  const markers = first.text.match(/<REDACTED1_\d+>/gu)!
  assert.equal(markers.length, 2)
  for (const damaged of [
    first.text.replace(markers[0], ""),
    first.text + markers[0],
    first.text.replace(markers[0], "<REDACTED1_99>"),
    first.text.replace(markers[0], markers[0].slice(0, -1)),
    first.text + second.text.match(/<REDACTED\d+_\d+>/u)![0]
  ])
    assert.throws(() => first.restore(damaged), ModelRetry)
  const short = protectSensitiveText("password=0", ["0"])
  assert.equal(short.restore(redactSensitiveText(short.text, ["0"])), "password=0")
})

test("rendered templates, original CTP references and retry history are sanitized before HTTP", async (t) => {
  const secret = "sk-" + "Aa12".repeat(5) + "T3BlbkFJ" + "Bc23".repeat(5)
  const generated = "ghp_" + "Y2".repeat(18)
  const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? generated + "\nUnexpected explanation" : items[0].replace("Read the guide", "阅读指南")))
  const settings = { ...fixture.settings, apiKey: "mock-configured-key", systemPrompt: fixture.settings.systemPrompt + ' Configuration mock-configured-key. Password="' + generated + '".' }
  const input = inputOf(parseMarkdown("Read the guide with `" + secret + "`."))
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen.length, 2)
  const sent = JSON.stringify(fixture.seen)
  for (const value of [secret, generated, settings.apiKey]) assert.ok(!sent.includes(value))
  assert.ok(fixture.seen[1].body.messages.some((message) => message.role === "assistant"))
  assert.ok(fixture.seen[0].items[0].includes("<CTP"), "The case did not exercise a CTP Original reference.")
})

test("JSON escapes are protected in both decoded scalar text and its source reference", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read the guide", "阅读指南")).join("\n%%\n"))
  const secret = 'mock"quoted\\pass'
  fixture.settings.apiKey = secret
  const source = "Read the guide password=" + JSON.stringify(secret) + "."
  const input = inputOf(parseMarkdown(source))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.ok(!JSON.stringify(fixture.seen).includes("mock"))
  assert.equal(result[0].text, source.replace("Read the guide", "阅读指南"))
})

test("credential-shaped identifiers remain local before identifier word splitting", async (t) => {
  const fixture = await chatFixture(t, () => assert.fail("A credential identifier must not be sent in split form."))
  const text = "ghp_" + "Ab12".repeat(9)
  const input = { units: [{ id: "credential", text, start: 0, end: text.length, format: "text" as const, kind: "identifier" as const }] }
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(result, [{ id: "credential", text }])
  assert.equal(fixture.seen.length, 0)
})

test("sensitivity changes invalidate scalar cache identity even when references are disabled", async (t) => {
  const fixture = await chatFixture(t, () => "虚构值")
  const settings = { ...fixture.settings, includeContext: false, maxTranslationAttempts: 1 }
  const text = "Fictional value."
  const unit = { id: "scalar", text, start: 0, end: text.length, format: "text" as const }
  const ordinary = await prepareInput(settings, { units: [unit] })
  const sensitive = await prepareInput({ ...settings, apiKey: text }, { units: [unit] })
  const store = new TranslationStore()
  const execute = (input: typeof ordinary) =>
    store.translate("sensitive-cache", input, (batch, signal, completed) => fixture.service.request(settings, batch, signal, fixture.gate, completed), new AbortController().signal)
  assert.equal((await execute(ordinary)).get(unit.id), "虚构值")
  assert.equal(fixture.seen.length, 1)
  assert.equal((await execute(sensitive)).get(unit.id), text, "A password value reused a prose translation instead of retaining its original value.")
  assert.equal(fixture.seen.length, 1, "A bare credential should complete locally.")
  store.clear()
})

test("repeated library scans do not retain performance marks in the extension host", async () => {
  const before = performance.getEntriesByType("mark").length
  for (let index = 0; index < 20; index++) await sensitiveValues(["Read the guide " + index])
  assert.equal(performance.getEntriesByType("mark").length, before)
})

test("library assignment findings hide the complete credential in prose and detached YAML values", async (t) => {
  const secret = "Ab12".repeat(10)
  const fixture = await chatFixture(t, (_body, items) => items.map((item) => item.replace("Read the guide", "阅读指南")).join("\n%%\n"))
  const settings = { ...fixture.settings, includeContext: false, minimumMarkerCharacters: 1000 }
  const assignment = 'AWS_SECRET_ACCESS_KEY: "' + secret + '"'
  const known = await sensitiveValues([assignment])
  assert.equal(redactSensitiveText(assignment, known), 'AWS_SECRET_ACCESS_KEY: "[REDACTED]"')
  const input = inputOf(parseYaml(assignment + "\ncaption: Read the guide"))
  const result = await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.equal(result.find((item) => item.id === input.units.find((unit) => unit.content === secret)!.id)!.text, '"' + secret + '"')
  const prose = inputOf(parseMarkdown("Read the guide with " + assignment))
  assert.equal((await requestTranslation(fixture.service, settings, prose, new AbortController().signal, fixture.gate))[0].text, "阅读指南 with " + assignment)
  const sent = JSON.stringify(fixture.seen)
  assert.ok(!sent.includes(secret.slice(0, 16)) && !sent.includes(secret.slice(-16)), "A reported assignment range leaked a credential prefix or suffix.")
})
