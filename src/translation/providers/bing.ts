import type { TranslationProvider } from "./protocol.ts"

function language(value: string): string {
  if (value.toLowerCase() === "zh-cn") return "zh-Hans"
  if (value.toLowerCase() === "zh-tw") return "zh-Hant"
  return value === "auto" ? "auto-detect" : value
}

export const bing: TranslationProvider = {
  id: "bing",
  defaultApiUrl: "https://www.bing.com/translator",
  prepare({ settings, items }) {
    return {
      characters: items.reduce((sum, item) => sum + item.text.length, 0),
      referenceCharacters: 0,
      async send(context) {
        // Bing rejects some native fetch agents; keep the session's client identity consistent.
        const headers = { "User-Agent": "CommentTranslatePlus" }
        const bootstrap = await context.request(settings.apiUrl, { headers, redirect: "follow", credentials: "include" })
        const ig = bootstrap.text.match(/IG:"([^"]+)"/)?.[1]
        const iid = bootstrap.text.match(/data-iid="([^"]+)"/)?.[1]
        const parameters = bootstrap.text.match(/params_AbusePreventionHelper\s*=\s*(\[[^\]]+\])/)?.[1]
        const values: unknown = parameters ? JSON.parse(parameters) : undefined
        if (!ig || !iid || !Array.isArray(values) || typeof values[0] !== "number" || typeof values[1] !== "string") throw Error("service-bing-auth-invalid")
        const url = new URL(bootstrap.url)
        if (!/\/translator\/?$/.test(url.pathname)) throw Error("service-bing-auth-invalid")
        url.pathname = url.pathname.replace(/\/translator\/?$/, "/ttranslatev3")
        url.search = new URLSearchParams({ isVertical: "1", IG: ig, IID: iid }).toString()
        const token = values[1]
        const key = String(values[0])
        await Promise.all(
          items.map(async (item) => {
            if (item.text.length > 5000) throw Error("service-text-too-large")
            const response = await context.request(url.href, {
              method: "POST",
              redirect: "error",
              credentials: "include",
              headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", ...(bootstrap.cookies ? { Cookie: bootstrap.cookies } : {}) },
              body: new URLSearchParams({ fromLang: language(settings.sourceLanguage), to: language(settings.targetLanguage), text: item.text, token, key }).toString()
            })
            const body = JSON.parse(response.text) as { translations?: { text?: unknown }[] }[]
            const text = Array.isArray(body) ? body[0]?.translations?.[0]?.text : undefined
            if (typeof text !== "string" || !text.trim()) throw Error("service-response-invalid")
            const result = { id: item.id, text }
            context.accept(result)
          })
        )
      }
    }
  }
}
