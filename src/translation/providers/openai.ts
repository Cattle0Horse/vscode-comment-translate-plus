import type { TranslationProvider } from "./protocol.ts"
import { modelRequest, splitTranslations, defaultSystemPrompt, defaultUserPrompt } from "./prompts.ts"
import { ModelRetry, RequestRetry } from "../../model/diagnostics.ts"

export const openai: TranslationProvider = {
  id: "openai",
  defaultApiUrl: "",
  adaptive: true,
  defaultPrompts: { system: defaultSystemPrompt, user: defaultUserPrompt },
  validate(settings) {
    if (!settings.model.trim()) throw Error("service-settings-incomplete")
  },
  prepare(request) {
    const { settings, items } = request
    const { separator, payload, referenceCharacters } = modelRequest(request)
    return {
      characters: payload.messages.reduce((sum, message) => sum + message.content.length, 0),
      referenceCharacters,
      async send(context) {
        context.trace({ kind: "model-request", payload })
        const response = await context.request(settings.apiUrl, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", ...(settings.apiKey ? { Authorization: "Bearer " + settings.apiKey } : {}) },
          body: JSON.stringify(payload)
        })
        context.trace({ kind: "model-response", payload: response.text })
        let body: { choices?: { finish_reason?: string; message?: { content?: unknown } }[] }
        try {
          body = JSON.parse(response.text)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          throw new RequestRetry("service-response-invalid", false, { reason: "接口响应不是有效的 JSON 信封。" })
        }
        const choice = body?.choices?.[0]
        if (typeof choice?.finish_reason !== "string")
          throw new RequestRetry("service-response-incomplete", false, { reason: "接口响应缺少生成结束状态。", expected: "finish_reason", actual: "缺失" })
        if (typeof choice.message?.content === "string") context.output(choice.message.content)
        if (choice?.finish_reason !== "stop")
          throw new ModelRetry(
            { reason: `Generation ended with finish_reason=${choice.finish_reason}, expected stop.`, instruction: "Provide a complete translation for every source item." },
            {
              code: "service-response-incomplete",
              difference: {
                reason: "模型没有正常结束生成。",
                expected: "finish_reason=stop",
                actual: "finish_reason=" + (choice?.finish_reason ?? "（缺失）")
              }
            }
          )
        if (typeof choice.message?.content !== "string")
          throw new RequestRetry("service-response-incomplete", false, {
            reason: "接口没有返回文本译文。",
            expected: "message.content 为字符串",
            actual: typeof choice.message?.content
          })
        for (const [index, text] of splitTranslations(choice.message.content, separator, items.length).entries()) context.accept({ id: items[index].id, text })
      }
    }
  }
}
