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
    // Masked source may hide literal tags. In that case keep the response intact
    // rather than guessing whether a context envelope belongs to source content.
    const recoverContext =
      referenceCharacters > 0 &&
      payload.messages.some((message) => message.role !== "assistant" && message.content.includes("<context>") && message.content.includes("</context>")) &&
      !items.some((item) => item.hasMarkers || /<\/?context\b/iu.test(item.text))
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
        let content = choice.message.content
        // Reject copied request controls before positional splitting can turn their
        // source-text tails into apparently successful unchanged translations.
        const controls = [
          ...payload.messages.filter((message) => message.role !== "assistant").map((message) => message.content.trim()),
          ...(request.retryFeedback?.flatMap((feedback) => [feedback.reason, feedback.instruction]) ?? [])
        ].map((control) => control.replace(/\r\n/gu, "\n"))
        const source = items
          .map((item) => item.text)
          .join("\n\n" + separator + "\n\n")
          .replace(/\r\n/gu, "\n")
        const responseText = content.replace(/\r\n/gu, "\n")
        if (controls.some((control) => control && responseText.includes(control) && !source.includes(control)))
          throw new ModelRetry(
            {
              reason: "The response copied request instructions or retry feedback absent from the source items.",
              instruction: "Return only the translation of each source item. Exclude request instructions, retry feedback, context and explanations."
            },
            {
              code: "translation-feedback-leaked",
              difference: { reason: "模型回显了请求指令或重试诊断，整批条目归属不可靠。", expected: "仅返回各项译文，不包含请求指令或重试诊断。" }
            }
          )
        if (recoverContext) {
          const tags = content.match(/<\/?context\b[^>]*>/giu) ?? []
          const trailing = content.trimEnd()
          let candidate = content
          if (tags.length === 1 && tags[0] === "</context>" && trailing.endsWith("</context>")) candidate = trailing.slice(0, -"</context>".length).trimEnd()
          else if (tags.length === 2 && tags[0] === "<context>" && tags[1] === "</context>") {
            if (content.trimStart().startsWith("<context>")) candidate = content.slice(content.indexOf("</context>") + "</context>".length).trimStart()
            else if (trailing.endsWith("</context>")) candidate = content.slice(0, content.indexOf("<context>")).trimEnd()
          }
          // Alignment, per-unit restoration, syntax and language checks still own
          // acceptance. Raw response traces above retain the removed envelope.
          // A caption introducing the block or a now-empty final batch slot is
          // not evidence of a remaining translation. Preserve the original error.
          const boundary = candidate.trimEnd()
          if (boundary && !boundary.endsWith(separator) && !/[:：]$/u.test(boundary)) content = candidate
        }
        for (const [index, text] of splitTranslations(content, separator, items.length).entries()) context.accept({ id: items[index].id, text })
      }
    }
  }
}
