import type { TranslationRequest } from "./protocol.ts"
import { ModelRetry } from "../../model/diagnostics.ts"
import manifest from "../../../package.json" with { type: "json" }

const defaults = manifest.contributes.configuration.properties["commentTranslatePlus.profiles"].items.properties

export const defaultLanguageNames: Readonly<Record<string, string>> = defaults.languageNames.default

export const defaultSystemPrompt = defaults.systemPrompt.default

export const defaultUserPrompt = defaults.userPrompt.default

export function batchSeparator(request: TranslationRequest): string {
  let separator = "%%"
  const input =
    request.items.map((item) => item.text).join("\n") +
    "\n" +
    request.context +
    "\n" +
    (request.retryFeedback?.flatMap((feedback) => [feedback.reason, feedback.instruction]).join("\n") ?? "") +
    "\n" +
    (typeof request.previousOutput === "string" ? "" : (request.previousOutput?.join("\n") ?? ""))
  const lines = new Set(input.split(/\r?\n/).map((line) => line.trim()))
  let index = 0
  while (lines.has(separator)) separator = "%%" + ++index
  return separator
}

export function renderPrompt(template: string, request: TranslationRequest, separator: string, contextInserted?: (characters: number) => void): string {
  const { settings, items } = request
  const sourceLanguage = settings.sourceLanguage.trim() || "auto"
  const targetLanguage = settings.targetLanguage.trim()
  if (!targetLanguage || targetLanguage === "auto") throw Error("service-settings-incomplete")
  const values: Readonly<Record<string, string>> = {
    content: items.map((item) => item.text).join("\n\n" + separator + "\n\n"),
    sourceLang: Object.hasOwn(settings.languageNames, sourceLanguage) ? settings.languageNames[sourceLanguage] : sourceLanguage,
    targetLang: Object.hasOwn(settings.languageNames, targetLanguage) ? settings.languageNames[targetLanguage] : targetLanguage,
    sourceLangCode: sourceLanguage === "auto" ? "" : sourceLanguage,
    targetLangCode: targetLanguage,
    context: request.context,
    hasProtectedMarkers: items.some((item) => item.hasMarkers) ? "true" : "",
    separator,
    itemCount: String(items.length),
    isBatch: items.length > 1 ? "true" : "",
    contentType: [...new Set(items.map((item) => item.kind ?? item.format))].join(", ")
  }
  const visible = [true]
  const output: string[] = []
  let cursor = 0
  for (const token of template.matchAll(/\$\{([A-Za-z][A-Za-z0-9]*)\}|\{\{(?:#if|\/if)\b[^{}]*(?:\}\}|(?=[{}])|$)/g)) {
    if (visible.at(-1)) output.push(template.slice(cursor, token.index))
    const condition = token[0].match(/^\{\{#if\s+([A-Za-z][A-Za-z0-9]*)\s*\}\}$/)
    if (condition) {
      const name = condition[1]
      if (!Object.hasOwn(values, name)) throw Error("prompt-template-invalid")
      visible.push(visible.at(-1)! && !!values[name].trim())
    } else if (token[0] === "{{/if}}") {
      if (visible.length === 1) throw Error("prompt-template-invalid")
      visible.pop()
    } else if (token[1] !== undefined) {
      if (visible.at(-1)) {
        output.push(Object.hasOwn(values, token[1]) ? values[token[1]] : token[0])
        if (token[1] === "context") contextInserted?.(values.context.length)
      }
    } else throw Error("prompt-template-invalid")
    cursor = token.index + token[0].length
  }
  if (visible.length !== 1) throw Error("prompt-template-invalid")
  if (visible[0]) output.push(template.slice(cursor))
  return output.join("")
}

export function modelRequest(request: TranslationRequest): {
  readonly separator: string
  readonly referenceCharacters: number
  readonly payload: { model: string; stream: false; messages: { role: string; content: string }[] }
} {
  const separator = batchSeparator(request)
  let referenceCharacters = 0
  const count = (characters: number): void => {
    referenceCharacters += characters
  }
  const system = renderPrompt(request.settings.systemPrompt, request, separator, count)
  const user = renderPrompt(request.settings.userPrompt, request, separator, count)
  const messages = system ? [{ role: "system", content: system }] : []
  messages.push({ role: "user", content: user })
  if (request.retryFeedback?.length) {
    if (request.previousOutput !== undefined)
      messages.push({ role: "assistant", content: typeof request.previousOutput === "string" ? request.previousOutput : request.previousOutput.join("\n\n" + separator + "\n\n") })
    messages.push({
      role: "user",
      content:
        request.retryFeedback
          .map((feedback) => {
            const item = request.items.length > 1 ? "Item " + (feedback.index + 1) + ": " : ""
            return "Previous response errors: " + item + feedback.reason + "\nCorrection: " + item + feedback.instruction
          })
          .join("\n\n") +
        "\n\n" +
        (request.items.length > 1 ? `Current request: ${request.items.length} item(s); separator: ${separator} on its own line.\n\n` : "") +
        renderPrompt("Based on the error response, re-translate the following text into ${targetLang}:\n\n${content}", request, separator)
    })
  }
  return {
    separator,
    referenceCharacters,
    payload: { model: request.settings.model, stream: false, messages }
  }
}

export function splitTranslations(content: string, separator: string, count: number): string[] {
  // Keep each line's original terminator: native string syntax may contain CRLF.
  let lines = content.split(/(?<=\n)/u)
  let boundaries = lines.flatMap((line, index) => (line.trim() === separator ? [index] : []))
  // Only redundant outer delimiters are disposable. Trailing empty items remain
  // empty, and an ambiguous internal count must still fail alignment.
  if (boundaries.length > count - 1) {
    let start = 0
    let end = lines.length
    while (start < end && (!lines[start].trim() || lines[start].trim() === separator)) start++
    while (end > start && (!lines[end - 1].trim() || lines[end - 1].trim() === separator)) end--
    const candidate = lines.slice(start, end)
    const inner = candidate.flatMap((line, index) => (line.trim() === separator ? [index] : []))
    if (inner.length === count - 1 && candidate.length) {
      candidate[candidate.length - 1] = candidate.at(-1)!.replace(/\r?\n$/u, "")
      lines = candidate
      boundaries = inner
    }
  }
  if (boundaries.length !== count - 1)
    throw new ModelRetry(
      {
        reason: "The response item boundaries do not match the source items.",
        instruction: "Return exactly one translation per source item, in the original order."
      },
      {
        code: "translation-items-mismatch",
        difference: {
          reason: "返回的分隔数量不符，无法可靠对应原文条目。",
          expected: count + " 项（" + (count - 1) + " 个分隔符）",
          actual: boundaries.length + " 个分隔符"
        }
      }
    )
  let start = 0
  const translations = [...boundaries, lines.length].map((end) => {
    let text = lines.slice(start, end).join("")
    if (end < lines.length) text = text.replace(/\r?\n$/u, "")
    if (start > 0) text = text.replace(/^\r?\n/u, "")
    if (end < lines.length) text = text.replace(/\r?\n$/u, "")
    start = end + 1
    return text
  })
  const firstEmpty = translations.findIndex((text) => !text.trim())
  if (firstEmpty >= 0 && translations.slice(firstEmpty + 1).some((text) => text.trim()))
    throw new ModelRetry(
      {
        reason: "An empty slot precedes non-empty translations; their source ownership is ambiguous.",
        instruction: "Translate every source item in its original order. Do not shift translations into empty slots or omit items."
      },
      {
        code: "translation-items-mismatch",
        difference: { reason: "空项之后仍有译文，无法可靠确认条目归属。", expected: count + " 项按原序逐项对应", actual: "第 " + (firstEmpty + 1) + " 项为空，后续项非空" }
      }
    )
  return translations
}
