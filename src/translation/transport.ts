import type { ServiceSettings } from "./settings.ts"
import manifest from "../../package.json" with { type: "json" }

const configuration = manifest.contributes.configuration.properties
const scheduling = {
  slowStart: configuration["commentTranslatePlus.requestScheduling.slowStart"],
  retry: configuration["commentTranslatePlus.requestScheduling.retry"],
  recovery: configuration["commentTranslatePlus.requestScheduling.recovery"]
}

export const transportPolicySchema = {
  slowStart: { ...scheduling.slowStart.properties.enabled, path: ["slowStart", "enabled"] as const },
  slowStartInitialConcurrency: { ...scheduling.slowStart.properties.initialConcurrency, path: ["slowStart", "initialConcurrency"] as const },
  slowStartGrowthFactor: { ...scheduling.slowStart.properties.growthFactor, path: ["slowStart", "growthFactor"] as const },
  respectRetryAfter: { ...scheduling.retry.properties.respectRetryAfter, path: ["retry", "respectRetryAfter"] as const },
  retryHttp429: { ...scheduling.retry.properties.http429, path: ["retry", "http429"] as const },
  retryHttp503: { ...scheduling.retry.properties.http503, path: ["retry", "http503"] as const },
  retryBackoffInitialMs: { ...scheduling.retry.properties.initialDelayMs, path: ["retry", "initialDelayMs"] as const },
  retryBackoffMaxMs: { ...scheduling.retry.properties.maxDelayMs, path: ["retry", "maxDelayMs"] as const },
  retryBackoffMultiplier: { ...scheduling.retry.properties.multiplier, path: ["retry", "multiplier"] as const },
  retryJitterRatio: { ...scheduling.retry.properties.jitterRatio, path: ["retry", "jitterRatio"] as const },
  sharedRequestCooldown: { ...scheduling.retry.properties.sharedCooldown, path: ["retry", "sharedCooldown"] as const },
  requestRecovery: { ...scheduling.recovery.properties.enabled, path: ["recovery", "enabled"] as const },
  recoveryMinConcurrency: { ...scheduling.recovery.properties.minConcurrency, path: ["recovery", "minConcurrency"] as const },
  recoverySuccesses: { ...scheduling.recovery.properties.successes, path: ["recovery", "successes"] as const },
  recoveryConcurrencyStep: { ...scheduling.recovery.properties.concurrencyStep, path: ["recovery", "concurrencyStep"] as const },
  recoveryDecreaseFactor: { ...scheduling.recovery.properties.decreaseFactor, path: ["recovery", "decreaseFactor"] as const },
  recoveryIntervalMs: { ...scheduling.recovery.properties.intervalMs, path: ["recovery", "intervalMs"] as const },
  networkFailureWindowMs: { ...scheduling.recovery.properties.networkFailureWindowMs, path: ["recovery", "networkFailureWindowMs"] as const },
  networkFailureThreshold: { ...scheduling.recovery.properties.networkFailureThreshold, path: ["recovery", "networkFailureThreshold"] as const }
}

export const transportConfigurationKeys = [...new Set(Object.values(transportPolicySchema).map((schema) => "requestScheduling." + schema.path[0]))]

export function requestScope(settings: ServiceSettings): string {
  return JSON.stringify([settings.provider, settings.apiUrl, settings.apiKey])
}

/** Retry-After is either integer seconds or an HTTP date, never a fractional delay. */
export function retryAfterDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return
  value = value.trim()
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000
    return Number.isSafeInteger(delay) ? delay : undefined
  }
  if (!/^[A-Za-z]/.test(value)) return
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - now)
}

export function retryDelay(settings: ServiceSettings, failures: number, random = Math.random()): number {
  if (!settings.retryBackoffInitialMs) return 0
  const base = Math.min(settings.retryBackoffMaxMs, settings.retryBackoffInitialMs * settings.retryBackoffMultiplier ** Math.max(0, failures - 1))
  return Math.min(settings.retryBackoffMaxMs, Math.round(base * (1 - settings.retryJitterRatio + 2 * settings.retryJitterRatio * random)))
}
