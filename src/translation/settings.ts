import type { ProviderSettings } from "./providers/protocol.ts"
import { getProvider } from "./providers/index.ts"
import manifest from "../../package.json" with { type: "json" }

const configuration = manifest.contributes.configuration.properties

export const requestPolicySchema = {
  minimumMarkerCharacters: configuration["commentTranslatePlus.minimumMarkerCharacters"],
  maxItemsPerRequest: configuration["commentTranslatePlus.maxItemsPerRequest"],
  maxRequestCharacters: configuration["commentTranslatePlus.maxRequestCharacters"],
  maxContextCharacters: configuration["commentTranslatePlus.maxContextCharacters"],
  maxUnitContextCharacters: configuration["commentTranslatePlus.maxUnitContextCharacters"],
  adaptiveBatching: configuration["commentTranslatePlus.adaptiveBatching"],
  batchBySemanticScope: configuration["commentTranslatePlus.batchBySemanticScope"],
  initialItemsPerRequest: configuration["commentTranslatePlus.initialItemsPerRequest"],
  initialRequestCharacters: configuration["commentTranslatePlus.initialRequestCharacters"],
  batchGrowthSuccesses: configuration["commentTranslatePlus.batchGrowthSuccesses"],
  batchGrowthItems: configuration["commentTranslatePlus.batchGrowthItems"],
  batchGrowthFactor: configuration["commentTranslatePlus.batchGrowthFactor"],
  batchShrinkFactor: configuration["commentTranslatePlus.batchShrinkFactor"],
  maxTranslationAttempts: configuration["commentTranslatePlus.maxTranslationAttempts"]
}

type RequestPolicy = { readonly [K in keyof typeof requestPolicySchema]: (typeof requestPolicySchema)[K]["default"] }

function validPolicyValue(schema: (typeof requestPolicySchema)[keyof RequestPolicy], value: unknown): boolean {
  if (!("minimum" in schema)) return typeof value === "boolean"
  return typeof value === "number" && (schema.type === "integer" ? Number.isInteger(value) : Number.isFinite(value)) && value >= schema.minimum && value <= schema.maximum
}

/** Native settings and direct service callers use the same manifest constraints. */
export function readRequestPolicy(read: (key: keyof RequestPolicy, fallback: number | boolean) => unknown): RequestPolicy {
  return Object.fromEntries(
    Object.entries(requestPolicySchema).map(([key, schema]) => {
      const value = read(key as keyof RequestPolicy, schema.default)
      if (!validPolicyValue(schema, value)) {
        if (schema.type === "boolean") throw Error(key + " 必须是布尔值。")
        if (schema.type === "integer") throw Error("请求限制必须是设置范围内的整数。")
        throw Error(key + " 必须是设置范围内的数值。")
      }
      return [key, value]
    })
  ) as RequestPolicy
}

export interface ServiceSettings extends ProviderSettings, RequestPolicy {
  readonly provider: string
  readonly skipSameLanguage: boolean
  readonly maxConcurrentRequests: number
}

export function serviceIdentity(settings: ServiceSettings): string {
  return JSON.stringify([
    settings.provider,
    settings.apiUrl,
    settings.model,
    settings.systemPrompt,
    settings.userPrompt,
    settings.languageNames,
    settings.sourceLanguage.trim() || "auto",
    settings.targetLanguage,
    settings.preserveTerms.map((term) => (typeof term === "string" ? term : { pattern: term.source, flags: term.flags })),
    settings.skipSameLanguage,
    settings.minimumMarkerCharacters
  ])
}

export function validateService(settings: ServiceSettings): void {
  const url = new URL(settings.apiUrl)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error("api-url-invalid")
  if (!settings.targetLanguage.trim() || settings.targetLanguage.trim() === "auto") throw Error("service-settings-incomplete")
  if (
    Object.entries(requestPolicySchema).some(([key, schema]) => !validPolicyValue(schema, settings[key as keyof RequestPolicy])) ||
    !Number.isInteger(settings.maxConcurrentRequests) ||
    settings.maxConcurrentRequests < 1 ||
    settings.maxConcurrentRequests > 20
  )
    throw Error("service-settings-incomplete")
  getProvider(settings.provider).validate?.(settings)
}

/** Scheduling changes start fresh learning and invalidate captured replacement actions. */
export function requestPolicyIdentity(settings: ServiceSettings): string {
  return JSON.stringify([serviceIdentity(settings), ...Object.keys(requestPolicySchema).map((key) => settings[key as keyof RequestPolicy])])
}
