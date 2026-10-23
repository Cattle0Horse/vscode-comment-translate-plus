import { emptyPreserveTerms, parsePreserveTerms, prepareTranslation } from "../../src/documents/terms.ts"
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { parseMarkdown, parseMarkdownWithCode } from "../../src/documents/markdown.ts"
import { parseYaml } from "../../src/documents/yaml.ts"
import type { TranslationItem } from "../../src/model/translation.ts"
import { RequestGate } from "../../src/translation/requestGate.ts"
import { BrowseSession } from "../../src/features/browse/session.ts"
import { TranslationStore } from "../../src/translation/store.ts"
import type { TranslationInput } from "../../src/model/translation.ts"
import { prepareInput } from "../../src/translation/prepare.ts"
import { TranslationService } from "../../src/translation/engine.ts"
import { defaultSystemPrompt, defaultUserPrompt, defaultLanguageNames } from "../../src/translation/providers/prompts.ts"
import type { ParsedDocument } from "../../src/model/document.ts"
import { referenceText as mergeReferences } from "../../src/documents/references.ts"
import { protectedFragments } from "../../src/documents/protection.ts"

export const defaultPreserveTerms = parsePreserveTerms(JSON.parse(readFileSync("resources/preserve-terms.json", "utf8")))

export async function embeddedMarkdown(source: string): Promise<ParsedDocument> {
  return parseMarkdownWithCode(source, async (text, language) => {
    if (language === "md" || language === "markdown") return embeddedMarkdown(text)
    if (language === "yaml" || language === "yml") return parseYaml(text)
    return { source: text, groups: [], errors: [] }
  })
}

export const limits = {
  minimumMarkerCharacters: 32,
  maxItemsPerRequest: 20,
  maxRequestCharacters: 12000,
  maxContextCharacters: 2000,
  maxUnitContextCharacters: 1000,
  adaptiveBatching: true,
  batchBySemanticScope: true,
  initialItemsPerRequest: 4,
  initialRequestCharacters: 6000,
  batchGrowthSuccesses: 3,
  batchGrowthItems: 1,
  batchGrowthFactor: 1.25,
  batchShrinkFactor: 0.5,
  maxTranslationAttempts: 3,
  maxConcurrentRequests: 2
}

export async function requestTranslation(
  service: TranslationService,
  settings: Parameters<TranslationService["request"]>[0],
  input: TranslationInput,
  signal: AbortSignal,
  gate: RequestGate,
  completed?: Parameters<TranslationService["request"]>[4],
  trace?: Parameters<TranslationService["request"]>[5]
) {
  return service.request(settings, prepareInput(settings, input), signal, gate, completed, trace)
}

export function inputOf(parsed: ParsedDocument): TranslationInput {
  return { units: parsed.groups.flatMap((group) => group.units) }
}

export function referenceText(units: TranslationInput["units"]): string {
  return mergeReferences(units.map((source) => ({ source, hasMarkers: prepareTranslation(source, emptyPreserveTerms, 32).hasMarkers })))
}

export function unitReferences(unit: TranslationInput["units"][number], budget: number) {
  return prepareInput(
    {
      ...limits,
      maxContextCharacters: budget,
      provider: "openai",
      apiUrl: "http://fixture.invalid/v1/chat/completions",
      apiKey: "",
      model: "fixture",
      systemPrompt: defaultSystemPrompt,
      userPrompt: defaultUserPrompt,
      languageNames: defaultLanguageNames,
      preserveTerms: emptyPreserveTerms,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      skipSameLanguage: false
    },
    { units: [unit] }
  ).units[0].reference
}

export const source = "1. First item with `code`.\n2. Second item with [guide](https://example.com)."

export const batch = inputOf(parseMarkdown(source))

export const response = [
  { id: batch.units[1].id, text: "2. 第二项带有[指南](https://example.com)。" },
  { id: batch.units[0].id, text: "1. 第一项包含 `code`。" }
]

export const sessionResponse = response.map((item) => ({ ...item, id: item.id === batch.units[0].id ? "t0" : "t1" }))

export function sessionFor(transport: (batch: TranslationInput, signal: AbortSignal) => Promise<readonly TranslationItem[]>): BrowseSession {
  const store = new TranslationStore()
  const gate = new RequestGate(100, 2)
  return new BrowseSession(
    (batch, signal, force, completed, interests) =>
      store.translate("test", batch, (canonical, shared) => gate.run(() => transport(canonical, shared), shared), signal, force, completed, undefined, interests),
    () => {}
  )
}

export async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw Error("transport did not start")
    await delay(1)
  }
}

export async function settled(session: BrowseSession): Promise<void> {
  const deadline = Date.now() + 3000
  while (session.inspect().pending) {
    if (Date.now() > deadline) throw Error("session did not settle")
    await delay(5)
  }
}

export interface ChatBody {
  model: string
  messages: { role: string; content: string }[]
  response_format?: unknown
}

export function modelInput(body: ChatBody): string {
  const content = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? ""
  if (content.startsWith("Target language:")) return content.slice(content.indexOf("Source items:\n") + "Source items:\n".length)
  const instruction = /(?:^|\r?\n)Translate (?:the following text into|to) [^\r\n]+:\r?\n\r?\n/.exec(content)
  return instruction ? content.slice(instruction.index + instruction[0].length) : content
}

export function modelFeedback(body: Pick<ChatBody, "messages">): string {
  const users = body.messages.filter((message) => message.role === "user")
  return users.length > 1 ? users[1].content.split(/\n\nTranslate the following text into [^\r\n]+:\r?\n\r?\n/, 1)[0] : ""
}

export function modelContext(body: ChatBody): string {
  return (
    body.messages
      .map((message) => message.content)
      .join("\n")
      .match(/<(?:context|reference)>\n([\s\S]*?)\n<\/(?:context|reference)>/)?.[1] ?? ""
  )
}

export function dropLastProtection(text: string): string {
  const fragment = text.match(/<CTP(?:\d+_)?\d+>/g)?.at(-1) ?? protectedFragments({ id: "fault", start: 0, end: text.length, text, format: "markdown" }).at(-1)?.text
  assert.ok(fragment, "The fault fixture contains no protected content.")
  return text.replace(fragment, "")
}

type ChatReply = string | { readonly disconnect: true } | { readonly status: number }

export async function chatFixture(t: TestContext, respond: (body: ChatBody, items: string[], call: number) => ChatReply | Promise<ChatReply>) {
  const seen: { body: ChatBody; items: string[] }[] = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody
    const input = modelInput(body)
    const items = input.split(/\r?\n[ \t]*%%[ \t]*\r?\n/).map((text) => text.replace(/^\r?\n/, "").replace(/\r?\n$/, ""))
    seen.push({ body, items })
    const content = await respond(body, items, seen.length)
    if (typeof content !== "string") {
      if ("disconnect" in content) request.socket.destroy()
      else response.writeHead(content.status).end()
      return
    }
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const settings = {
    ...limits,
    provider: "openai",
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    model: "plain-text-model",
    apiKey: "",
    systemPrompt: defaultSystemPrompt,
    userPrompt: defaultUserPrompt,
    languageNames: defaultLanguageNames,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    preserveTerms: defaultPreserveTerms,
    skipSameLanguage: false
  }
  return { seen, settings, service: new TranslationService(), gate: new RequestGate(100, 4) }
}

export function listBatch(count: number): TranslationInput {
  return inputOf(parseMarkdown(Array.from({ length: count }, (_, index) => `${index + 1}. Original paragraph ${index + 1}.`).join("\n")))
}

export const logContext = { file: "sample.md", name: "fixture", model: "fixture-model", targetLanguage: "zh-CN", apiKey: "", position: (offset: number) => "sample.md:1:" + (offset + 1) }
