import type { TranslationInput, TranslationValue } from "../model/translation.ts"
import type { TextUnit } from "../model/document.ts"
import { translationIsUnchanged, validateTranslation, validateTranslationText } from "../documents/validation.ts"

/** Every accepted source-compatible result has one representation before it reaches caches or consumers. */
export function finalizeTranslation(unit: TextUnit, value: string): string

export function finalizeTranslation(unit: TextUnit, value: TranslationValue): TranslationValue

export function finalizeTranslation(unit: TextUnit, value: TranslationValue): TranslationValue {
  if (typeof value === "string") {
    const failure = validateTranslation(unit, value)
    if (failure) throw failure
    return translationIsUnchanged(unit, value) ? unit.text : value
  }
  if (!value || value.kind !== "candidate" || typeof value.text !== "string" || !Number.isInteger(value.attempt) || value.attempt < 1 || !/^translation-[a-z-]+$/u.test(value.code))
    throw Error("translation-item-invalid")
  const failure = validateTranslationText(value.text)
  if (failure) throw failure
  return value
}

export function validateTranslations(batch: TranslationInput, parsed: unknown): Map<string, TranslationValue> {
  if (!Array.isArray(parsed) || parsed.length !== batch.units.length) throw Error("translation-items-mismatch")
  const expected = new Map(batch.units.map((unit) => [unit.id, unit]))
  const translations = new Map<string, TranslationValue>()
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("text" in item)) throw Error("translation-item-invalid")
    const unit = expected.get(item.id)
    if (!unit || translations.has(item.id)) throw Error("translation-structure-invalid")
    translations.set(item.id, finalizeTranslation(unit, item.text as TranslationValue))
  }
  return translations
}
