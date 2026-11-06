import assert from "node:assert/strict"
import { test } from "node:test"
import { identifierUnit, identifierWords } from "../src/documents/identifiers.ts"
import { prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation, translationIsUnchanged } from "../src/documents/validation.ts"
import type { SourceToken } from "../src/documents/tokenization.ts"
import { chatFixture, requestTranslation, unitReferences } from "./support/fixtures.ts"
import { emptyPreserveTerms } from "../src/documents/terms.ts"
import { prepareInput } from "../src/translation/prepare.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { modelRequest } from "../src/translation/providers/prompts.ts"

test("identifier targets retain exact UTF-16 source ranges and exclude non-name tokens", () => {
  const source = "// 展品😀\r\nconst getHTTPResponse = archive.get_user_profile()"
  const name = "getHTTPResponse"
  const start = source.indexOf(name)
  const token: SourceToken = { start, end: start + name.length, scopes: ["source.ts", "variable.other.readwrite.ts"] }
  for (let offset = start; offset < token.end; offset++) {
    const unit = identifierUnit(source, offset, "typescript", [token])!
    assert.equal(unit.text, source.slice(unit.start, unit.end))
    assert.equal(unit.text, name)
    assert.equal(unit.reference![0].text, source.slice(source.indexOf("const")))
  }
  for (const scope of ["keyword.control.ts", "storage.type.ts", "comment.line.ts", "string.quoted.ts", "constant.numeric.ts", "constant.language.ts", "punctuation.accessor.ts"])
    assert.equal(identifierUnit(source, start, "typescript", [{ ...token, scopes: ["source.ts", scope] }]), undefined)
  assert.equal(identifierUnit(source, token.end, "typescript", [token]), undefined)
  assert.equal(identifierUnit("ordinary", 2, "plaintext", [{ start: 0, end: 8, scopes: ["text.plain"] }]), undefined)
  const call = "client.fetchUser()"
  assert.equal(identifierUnit(call, 10, "typescript", [{ start: 0, end: call.length, scopes: ["source.ts"] }])?.text, "fetchUser")
})

test("identifier words translate as a phrase without inventing acronym expansions or source edits", () => {
  for (const [name, words] of [
    ["getUserProfile", "get User Profile"],
    ["HTTPResponse", "HTTP Response"],
    ["_get_user_profile", "get user profile"],
    ["MAX_RETRIES", "MAX RETRIES"],
    ["ctx", "ctx"],
    ["i", "i"],
    ["$userName", "user Name"]
  ]) {
    assert.equal(identifierWords(name), words)
    const unit = identifierUnit(name, 0, "typescript", [{ start: 0, end: name.length, scopes: ["source.ts", "variable.other.ts"] }])!
    const prepared = prepareTranslation(unit, 32)
    assert.equal(prepared.text, words)
    assert.equal(prepared.needsTranslation, true)
    assert.equal(prepared.restore(words), name)
    assert.equal(prepared.restore(name), name)
    const output = prepared.restore("用户资料")
    assert.equal(output, "用户资料")
    assert.equal(validateTranslation(unit, output), undefined)
    assert.equal(translationIsUnchanged(unit, name), true)
    assert.throws(() => prepared.restore("用户\n资料"))
  }
})

test("identifier extraction omits oversized source references and rejects partial tokens", () => {
  const source = " ".repeat(2100) + "userName"
  const token = { start: 2100, end: source.length, scopes: ["source.ts"] }
  assert.deepEqual(identifierUnit(source, 2101, "typescript", [token])!.reference, [])
  assert.equal(identifierUnit("123bad", 4, "typescript", [{ start: 0, end: 6, scopes: ["source.ts"] }]), undefined)
})

test("name translation uses bounded raw context and caches distinct meanings independently", async (t) => {
  const fixture = await chatFixture(t, (body, items) => {
    assert.deepEqual(items, ["get User Profile"])
    return body.messages.some((message) => message.content.includes("AccountProfile")) ? "获取账户资料" : "获取游客资料"
  })
  const settings = { ...fixture.settings, preserveTerms: emptyPreserveTerms }
  const store = new TranslationStore()
  const run = (type: string) => {
    const source = "function getUserProfile(): " + type + " {}"
    const start = source.indexOf("getUserProfile")
    const unit = identifierUnit(source, start, "typescript", [{ start, end: start + 14, scopes: ["source.ts", "entity.name.function.ts"] }])!
    assert.deepEqual(unitReferences(unit, 30), [], "An oversized source block was truncated or leaked past the reference budget.")
    return store.translate(
      "name-fixture",
      prepareInput(settings, { units: [unit] }),
      (input, signal) => requestTranslation(fixture.service, settings, input, signal, fixture.gate),
      new AbortController().signal
    )
  }
  assert.deepEqual([...(await run("AccountProfile")).values()], ["获取账户资料"])
  assert.deepEqual([...(await run("VisitorProfile")).values()], ["获取游客资料"])
  assert.deepEqual([...(await run("AccountProfile")).values()], ["获取账户资料"])
  assert.equal(fixture.seen.length, 2, "Repeated name hover failed to reuse its context-specific cached meaning.")
})

test("custom name prompts control both messages and expose identifier conditions without parsing inserted code", async (t) => {
  const fixture = await chatFixture(t, () => "unused")
  const request = {
    settings: { ...fixture.settings, systemPrompt: "{{#if isIdentifier}}name:${contentType}{{/if}}", userPrompt: "${content}\n${context}" },
    context: "const ctx = '${isIdentifier} {{#if context}}';",
    items: [{ id: "name", text: "ctx", format: "text" as const, kind: "identifier" as const }]
  }
  assert.deepEqual(modelRequest(request).payload.messages, [
    { role: "system", content: "name:identifier" },
    { role: "user", content: "ctx\nconst ctx = '${isIdentifier} {{#if context}}';" }
  ])
  assert.equal(modelRequest({ ...request, items: [{ ...request.items[0], kind: undefined }] }).payload.messages[0].role, "user")
})
