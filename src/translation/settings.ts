import type { ProviderSettings } from "./providers/protocol.ts"
import { getProvider } from "./providers/index.ts"
import { transportPolicySchema, transportConfigurationKeys } from "./transport.ts"
import manifest from "../../package.json" with { type: "json" }

const configuration = manifest.contributes.configuration.properties

export const requestPolicySchema = {
  ...transportPolicySchema,
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

export const requestPolicyConfigurationKeys = [...transportConfigurationKeys, ...Object.keys(requestPolicySchema).filter((key) => !(key in transportPolicySchema))]

function schedulingValue(group: unknown, field: string, fallback: number | boolean): unknown {
  if (group === undefined) return fallback
  if (!group || typeof group !== "object" || Array.isArray(group)) throw Error("requestScheduling 及其分组必须是对象。")
  const value = (group as Record<string, unknown>)[field]
  return value === undefined ? fallback : value
}

function validPolicyValue(schema: (typeof requestPolicySchema)[keyof RequestPolicy], value: unknown): boolean {
  if (!("minimum" in schema)) return typeof value === "boolean"
  return typeof value === "number" && (schema.type === "integer" ? Number.isInteger(value) : Number.isFinite(value)) && value >= schema.minimum && value <= schema.maximum
}

/** Native settings and direct service callers use the same manifest constraints. */
export function readRequestPolicy(read: (key: string, fallback: unknown) => unknown): RequestPolicy {
  const scheduling = Object.fromEntries(transportConfigurationKeys.map((key) => [key.slice("requestScheduling.".length), read(key, {})]))
  return Object.fromEntries(
    Object.entries(requestPolicySchema).map(([key, schema]) => {
      const value = "path" in schema ? schedulingValue(scheduling[schema.path[0]], schema.path[1], schema.default) : read(key, schema.default)
      if (!validPolicyValue(schema, value)) {
        const name = "path" in schema ? "requestScheduling." + schema.path.join(".") : key
        if (schema.type === "boolean") throw Error(name + " 必须是布尔值。")
        if (schema.type === "integer") throw Error(name + " 必须是设置范围内的整数。")
        throw Error(name + " 必须是设置范围内的数值。")
      }
      return [key, value]
    })
  ) as RequestPolicy
}

export interface ServiceSettings extends ProviderSettings, RequestPolicy {
  readonly provider: string
  readonly skipSameLanguage: boolean
}

export function serviceIdentity(settings: ServiceSettings): string {
  return JSON.stringify([
    settings.provider,
    settings.apiUrl,
    settings.model,
    settings.systemPrompt,
    settings.userPrompt,
    [settings.languageNames[settings.sourceLanguage.trim() || "auto"], settings.languageNames[settings.targetLanguage]],
    settings.sourceLanguage.trim() || "auto",
    settings.targetLanguage,
    settings.skipSameLanguage,
    settings.minimumMarkerCharacters
  ])
}

export function validateService(settings: ServiceSettings): void {
  const url = new URL(settings.apiUrl)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error("api-url-invalid")
  if (!settings.targetLanguage.trim() || settings.targetLanguage.trim() === "auto") throw Error("service-settings-incomplete")
  if (Object.entries(requestPolicySchema).some(([key, schema]) => !validPolicyValue(schema, settings[key as keyof RequestPolicy]))) throw Error("service-settings-incomplete")
  getProvider(settings.provider).validate?.(settings)
}

/** Scheduling changes start fresh learning and invalidate captured replacement actions. */
export function requestPolicyIdentity(settings: ServiceSettings): string {
  return JSON.stringify([serviceIdentity(settings), settings.preserveTerms.identity, ...Object.keys(requestPolicySchema).map((key) => settings[key as keyof RequestPolicy])])
}
