import { emptyPreserveTerms } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { TranslationService } from "../src/translation/engine.ts"
import { RequestGate } from "../src/translation/requestGate.ts"
import { defaultLanguageNames, defaultSystemPrompt, defaultUserPrompt } from "../src/translation/providers/prompts.ts"
import { inputOf, limits, requestTranslation } from "./support/fixtures.ts"

for (const provider of ["google", "bing"] as const) {
  test(provider + " translates without an API key when the service rejects the default HTTP client", async (t) => {
    let bootstrapAgent: string | undefined
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost")
      if (url.pathname === "/google") {
        if (url.searchParams.get("client") !== "dict-chrome-ex") {
          response.writeHead(429).end()
          return
        }
        assert.equal(request.headers.authorization, undefined)
        assert.equal(url.searchParams.get("sl"), "auto")
        assert.equal(url.searchParams.get("tl"), "zh-CN")
        response.end(JSON.stringify([[[url.searchParams.get("q")!.replace("Hello world", "你好世界")]]]))
        return
      }
      if (url.pathname === "/bing/translator") {
        bootstrapAgent = request.headers["user-agent"]
        response.setHeader("Set-Cookie", "fixture=session; Path=/bing; HttpOnly")
        response.end('IG:"probe" data-iid="translator.1" params_AbusePreventionHelper = [123456,"fixture-token",600000];')
        return
      }
      if (!request.headers["user-agent"] || /^(?:node|undici)/i.test(request.headers["user-agent"])) {
        response.writeHead(401).end(JSON.stringify({ ShowCaptcha: false }))
        return
      }
      const parts = []
      for await (const part of request) parts.push(part)
      const form = new URLSearchParams(Buffer.concat(parts).toString())
      assert.equal(request.headers["user-agent"], bootstrapAgent)
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.headers.cookie, "fixture=session")
      assert.equal(form.get("fromLang"), "auto-detect")
      assert.equal(form.get("to"), "zh-Hans")
      assert.equal(form.get("token"), "fixture-token")
      assert.equal(form.get("key"), "123456")
      response.end(JSON.stringify([{ translations: [{ text: form.get("text")!.replace("Hello world", "你好世界"), to: "zh-Hans" }] }]))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port
    const settings = {
      ...limits,
      provider,
      apiUrl: origin + (provider === "google" ? "/google" : "/bing/translator"),
      model: "",
      apiKey: "",
      systemPrompt: defaultSystemPrompt,
      userPrompt: defaultUserPrompt,
      languageNames: defaultLanguageNames,
      preserveTerms: emptyPreserveTerms,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      skipSameLanguage: false
    }
    const input = inputOf(parseMarkdown("Hello world with `sourceId`."))
    const results = await requestTranslation(new TranslationService(), settings, input, new AbortController().signal, new RequestGate(100, 2))
    assert.deepEqual(results, [{ id: input.units[0].id, text: "你好世界 with `sourceId`." }])
  })
}
