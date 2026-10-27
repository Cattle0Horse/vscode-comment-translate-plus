import { detectAll, validateISO2 } from "tinyld"
import { protectedFragments } from "./protection.ts"
import type { TextUnit } from "../model/document.ts"

/** Negative evidence is advisory; failure to confirm the target language is not enough. */
export function unlikelyTargetLanguage(text: string, target: string): { language: string; score: number; targetScore: number } | undefined {
  const language = target.toLowerCase().split(/[-_]/, 1)[0]
  if (!validateISO2(language) || text.length > 4096) return
  // Inspect the prepared output: protected values and source-owned syntax are still masked,
  // so their original offsets cannot accidentally hide translated prose.
  text = text.replace(/<CTP(?:\d+_)?\d+>/g, " ").trim()
  const letters = text.match(/\p{L}/gu) ?? []
  const eastern = letters.filter((letter) => /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u.test(letter)).length
  if (eastern && eastern !== letters.length) return
  if (letters.length < (eastern ? 20 : 80) || (!eastern && (text.match(/\p{L}+/gu)?.length ?? 0) < 12)) return
  const scores = detectAll(text)
  const [first, second] = scores
  const targetScore = scores.find((candidate) => candidate.lang === language)?.accuracy ?? 0
  const minimum = ["zh", "ja", "ko"].includes(language) && !eastern ? 0.3 : 0.6
  if (!first || first.lang === language || first.accuracy < minimum || first.accuracy - (second?.accuracy ?? 0) < 0.25 || targetScore > 0.1) return
  return { language: first.lang, score: first.accuracy, targetScore }
}

export function isTargetLanguage(unit: TextUnit, target: string): boolean {
  if (unit.pythonString) unit = unit.pythonString.unit
  if (unit.content !== undefined) unit = { ...unit, text: unit.content, format: "text", protected: undefined }
  if (unit.text.length > 4096) return false
  let text = ""
  let cursor = 0
  const ranges = [...(unit.protected ?? []), ...protectedFragments(unit)].sort((a, b) => a.start - b.start)
  for (const range of ranges) {
    if (range.end <= cursor) continue
    text += unit.text.slice(cursor, Math.max(cursor, range.start)) + " "
    cursor = range.end
  }
  text += unit.text.slice(cursor)
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>]+/g, " ").trim()
  if (!text) return false
  const language = target.toLowerCase().split(/[-_]/, 1)[0]
  const letters = text.match(/\p{L}/gu) ?? []
  const cjk = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u
  const cjkCount = letters.filter((letter) => cjk.test(letter)).length
  if (cjkCount && cjkCount !== letters.length) return false
  const chinese = language === "zh" && letters.every((letter) => /\p{Script=Han}/u.test(letter))
  if (letters.length < (chinese ? 4 : cjkCount ? 8 : 20)) return false
  if (!cjkCount && ((text.match(/\p{L}+/gu)?.length ?? 0) < 3 || new Set(letters.map((letter) => letter.toLowerCase())).size < 4)) return false
  const parts = text.split(/[\r\n.!?。！？；;]+/).filter((part) => /\p{L}/u.test(part))
  for (const part of [text, ...parts]) {
    if ((part.match(/\p{L}/gu)?.length ?? 0) < 4) return false
    // These simplified forms provide positive evidence; shared Han characters alone do not establish Chinese.
    if (chinese && /[这说话语读译请让为从对该页监态码显设载档览缓错删选项标识链]/u.test(part)) continue
    const [first, second] = detectAll(part)
    if (!first || first.lang !== language || first.accuracy < 0.9 || first.accuracy - (second?.accuracy ?? 0) < 0.25) return false
  }
  return true
}
