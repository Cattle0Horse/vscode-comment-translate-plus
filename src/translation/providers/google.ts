import type { TranslationProvider } from "./protocol.ts"

function language(value: string): string {
  if (value.toLowerCase() === "zh-cn") return "zh-CN"
  if (value.toLowerCase() === "zh-tw") return "zh-TW"
  return value
}

export const google: TranslationProvider = {
  id: "google",
  defaultApiUrl: "https://translate.googleapis.com/translate_a/single",
  prepare({ settings, items }) {
    return {
      characters: items.reduce((sum, item) => sum + item.text.length, 0),
      referenceCharacters: 0,
      async send(context) {
        await Promise.all(
          items.map(async (item) => {
            if (item.text.length > 5000) throw Error("service-text-too-large")
            const url = new URL(settings.apiUrl)
            url.search = new URLSearchParams({ client: "dict-chrome-ex", sl: language(settings.sourceLanguage), tl: language(settings.targetLanguage), dt: "t", q: item.text }).toString()
            const response = await context.request(url.href, { redirect: "error" }, item.id)
            const body: unknown = JSON.parse(response.text)
            if (!Array.isArray(body) || !Array.isArray(body[0]) || body[0].some((part: unknown) => !Array.isArray(part) || typeof part[0] !== "string"))
              throw Error("service-response-invalid")
            const text = body[0].map((part: string[]) => part[0]).join("")
            if (!text.trim()) throw Error("service-response-invalid")
            const result = { id: item.id, text }
            context.accept(result)
          })
        )
      }
    }
  }
}
