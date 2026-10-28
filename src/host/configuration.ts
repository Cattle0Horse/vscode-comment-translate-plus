import * as vscode from "vscode"
import { validateService, serviceIdentity, readRequestPolicy } from "../translation/settings.ts"
import { getProvider } from "../translation/providers/index.ts"
import { defaultLanguageNames } from "../translation/providers/prompts.ts"
import type { ServiceSettings } from "../translation/settings.ts"
import type { PreserveTerms } from "../model/translation.ts"

export interface TranslationProfile {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly apiUrl: string
  readonly model: string
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly languageNames: Readonly<Record<string, string>>
  readonly apiKey: string
}

export interface TranslationSettings extends ServiceSettings {
  readonly profileId: string
  readonly name: string
  readonly identity: string
  readonly maxConcurrentRequests: number
  readonly rate: number
}

export function profiles(uri?: vscode.Uri): TranslationProfile[] {
  const values = vscode.workspace.getConfiguration("commentTranslatePlus", uri).get<unknown>("profiles", [])
  if (!Array.isArray(values)) throw Error("profiles 必须是翻译配置数组。")
  const ids = new Set<string>()
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw Error("翻译配置必须是对象。")
    const input = value as Record<string, unknown>
    const id = typeof input.id === "string" ? input.id.trim() : ""
    if (!id || ids.has(id)) throw Error("翻译配置 ID 必须非空且唯一。")
    ids.add(id)
    const provider = input.provider
    if (typeof provider !== "string") throw Error("翻译服务必须是有效的适配器 ID。")
    const adapter = getProvider(provider)
    const apiUrl = input.apiUrl === undefined ? adapter.defaultApiUrl : input.apiUrl
    if (
      typeof apiUrl !== "string" ||
      (input.model !== undefined && typeof input.model !== "string") ||
      (input.systemPrompt !== undefined && typeof input.systemPrompt !== "string") ||
      (input.userPrompt !== undefined && typeof input.userPrompt !== "string") ||
      (input.name !== undefined && typeof input.name !== "string") ||
      (input.apiKey !== undefined && typeof input.apiKey !== "string")
    )
      throw Error("翻译地址、模型、提示词、名称和密钥必须是字符串。")
    const names = input.languageNames === undefined ? {} : input.languageNames
    if (!names || typeof names !== "object" || Array.isArray(names) || Object.entries(names).some(([code, name]) => !code.trim() || typeof name !== "string" || !name.trim()))
      throw Error("languageNames 必须是非空语言代码到名称的映射。")
    const languageNames = Object.fromEntries(Object.entries({ ...defaultLanguageNames, ...names }).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>
    return {
      id,
      name: typeof input.name === "string" ? input.name : id,
      provider,
      apiUrl: apiUrl.trim(),
      model: typeof input.model === "string" ? input.model.trim() : "",
      systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : (adapter.defaultPrompts?.system ?? ""),
      userPrompt: typeof input.userPrompt === "string" ? input.userPrompt : (adapter.defaultPrompts?.user ?? ""),
      languageNames,
      apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : ""
    }
  })
}

export function getTranslationSettings(uri: vscode.Uri | undefined, preserveTerms: PreserveTerms): TranslationSettings {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", uri)
  const list = profiles(uri)
  const active = config.get<string>("activeProfile", "") || list[0]?.id
  const profile = list.find((item) => item.id === active)
  if (!profile) throw Error("请配置 commentTranslatePlus.profiles，并选择有效的 activeProfile。")

  function text(key: string, fallback: string): string {
    const value = config.get<unknown>(key, fallback)
    if (typeof value !== "string") throw Error("语言设置必须是字符串。")
    return value.trim()
  }

  function integer(key: string, fallback: number, min: number, max: number): number {
    const value = config.get<number>(key, fallback)
    if (!Number.isInteger(value) || value < min || value > max) throw Error("请求限制必须是设置范围内的整数。")
    return value
  }

  const skipSameLanguage = config.get<unknown>("skipSameLanguage", true)
  if (typeof skipSameLanguage !== "boolean") throw Error("skipSameLanguage 必须是布尔值。")
  const settings = {
    ...profile,
    profileId: profile.id,
    sourceLanguage: text("sourceLanguage", "auto") || "auto",
    targetLanguage: text("targetLanguage", "") || vscode.env.language,
    preserveTerms,
    skipSameLanguage,
    ...readRequestPolicy((key, fallback) => config.get<unknown>(key, fallback)),
    rate: integer("maxRequestsPerSecond", 2, 1, 100),
    maxConcurrentRequests: integer("maxConcurrentRequests", 2, 1, 20)
  }
  try {
    validateService(settings)
  } catch {
    throw Error("翻译配置无效，请检查完整 HTTP/HTTPS 地址、模型和语言。")
  }
  return {
    ...settings,
    identity: serviceIdentity(settings)
  }
}

export function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return ["markdown", "skill", "prompt", "instructions", "chatagent"].includes(document.languageId) || /(?:^|\/)SKILL\.md$/i.test(document.uri.path)
}

export function isYamlDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "yaml"
}

export function displayMode(uri?: vscode.Uri): "contrast" | "inplace" {
  return vscode.workspace.getConfiguration("commentTranslatePlus", uri).get<string>("displayMode", "contrast") === "inplace" ? "inplace" : "contrast"
}

export function automatic(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration("commentTranslatePlus", document.uri)
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!config.get<boolean>("auto.enabled", false) || !folder) return false
  const include = config.get<string[]>("auto.include", ["**/*"])
  const exclude = config.get<string[]>("auto.exclude", [])
  const matches = (pattern: string) => vscode.languages.match({ pattern: new vscode.RelativePattern(folder, pattern) }, document) > 0
  return include.some(matches) && !exclude.some(matches)
}
