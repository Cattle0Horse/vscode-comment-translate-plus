import { ModelRetry, TranslationFailure } from "../model/diagnostics.ts"
import { lintSource } from "@secretlint/core"
import { rules } from "@secretlint/secretlint-rule-preset-recommend"
import { secretLintProfiler } from "@secretlint/profiler"

secretLintProfiler.setEnabled(false)

// Source text cannot opt out of outbound protection with secretlint-disable.
const scannerRules = rules
  .filter((rule) => rule.meta.id !== "@secretlint/secretlint-rule-filter-comments")
  .map((rule) => ({ id: rule.meta.id, rule, options: rule.meta.id === "@secretlint/secretlint-rule-aws" ? { enableIDScanRule: true } : {} }))

/** Consume reported credential data locally; diagnostics never leave this adapter. */
export async function sensitiveValues(texts: readonly string[], known: readonly string[] = []): Promise<readonly string[]> {
  const values = new Set(known.filter(Boolean))
  for (const content of new Set(texts.filter(Boolean))) {
    const result = await lintSource({
      source: { content, contentType: "text", filePath: "translation.txt" },
      options: { noPhysicFilePath: true, maskSecrets: false, config: { rules: scannerRules } }
    }).catch(() => {
      throw new TranslationFailure("service-secret-scan-failed", false, { reason: "本地敏感内容检测未能完成，未发送请求。" })
    })
    for (const message of result.messages) {
      const [start, end] = message.range
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) throw Error("service-secret-scan-failed")
      // Some rules report a range starting at the assignment but data containing
      // only its credential. Prefer that exact reported value to avoid masking
      // the prefix while leaving the end of the credential readable.
      const reported = Object.values(message.data ?? {}).filter((value): value is string => typeof value === "string" && value.length > 0 && content.includes(value))
      for (const value of reported.length ? reported : [content.slice(start, end)]) values.add(value)
    }
  }
  for (const value of values) {
    try {
      const decoded: unknown = JSON.parse('"' + value + '"')
      if (typeof decoded === "string" && decoded) values.add(decoded)
    } catch {
      // A reported source span is usually already decoded, not a JSON literal.
    }
  }
  return [...new Set([...values].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length)
}

function valuePattern(values: readonly string[]): RegExp | undefined {
  return values.length
    ? new RegExp("<REDACTED\\d+_\\d+>|<CTP(?:\\d+_)?\\d+>|\\[REDACTED\\]|(" + values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|") + ")", "gu")
    : undefined
}

/** References, diagnostics and rendered prompts have no values to restore. */
export function redactSensitiveText(text: string, known: readonly string[] = []): string {
  const pattern = valuePattern(known.filter(Boolean))
  return pattern ? text.replace(pattern, (value, secret: string | undefined) => (secret === undefined ? value : "[REDACTED]")) : text
}

/** This namespace is independent from the size-based CTP data optimization. */
export function protectSensitiveText(text: string, known: readonly string[], collisions = "") {
  let namespace = 0
  let prefix = "<REDACTED" + namespace + "_"
  while ((text + collisions).includes(prefix)) prefix = "<REDACTED" + ++namespace + "_"
  const markers = new Map<string, string>()
  const pattern = valuePattern(known.filter(Boolean))
  const masked = pattern
    ? text.replace(pattern, (value, secret: string | undefined) => {
        if (secret === undefined) return value
        const marker = prefix + markers.size + ">"
        markers.set(marker, value)
        return marker
      })
    : text
  const markerPattern = new RegExp(prefix + "\\d+>", "gu")
  return {
    text: masked,
    hasSecrets: markers.size > 0,
    restore(translated: string): string {
      if (!markers.size) return translated
      const matches = translated.match(markerPattern) ?? []
      const counts = new Map<string, number>()
      for (const marker of matches) counts.set(marker, (counts.get(marker) ?? 0) + 1)
      if (
        (translated.match(/<REDACTED[\w]*(?:>|(?=\s|$))/gu) ?? []).some((marker) => !markers.has(marker) && !text.includes(marker)) ||
        matches.some((marker) => !markers.has(marker)) ||
        translated.replace(markerPattern, "").includes(prefix) ||
        [...markers.keys()].some((marker) => counts.get(marker) !== 1)
      )
        throw new ModelRetry(
          {
            reason: "Sensitive-content placeholders were missing, changed, duplicated or unknown.",
            instruction: "Keep every <REDACTED...> placeholder exactly once in its own item, unchanged. Never replace it with a value or omit it."
          },
          { code: "translation-marker-mismatch", difference: { reason: "敏感内容占位符不完整，未还原或采用译文。" } }
        )
      return translated.replace(markerPattern, (marker) => markers.get(marker)!)
    }
  }
}
