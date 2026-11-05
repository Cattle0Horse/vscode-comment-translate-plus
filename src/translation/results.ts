import type { TranslationInput, TranslationValue } from "../model/translation.ts"
import type { TextUnit } from "../model/document.ts"
import { validateTranslation, validateTranslationText } from "../documents/validation.ts"

export function validateTranslationValue(unit: TextUnit, value: TranslationValue) {
  if (typeof value === "string") return validateTranslation(unit, value)
  if (!value || value.kind !== "candidate" || typeof value.text !== "string" || !Number.isInteger(value.attempt) || value.attempt < 1 || !/^translation-[a-z-]+$/u.test(value.code))
    throw Error("translation-item-invalid")
  return validateTranslationText(value.text)
}

export function validateTranslations(batch: TranslationInput, parsed: unknown): Map<string, TranslationValue> {
  if (!Array.isArray(parsed) || parsed.length !== batch.units.length) throw Error("translation-items-mismatch")
  const expected = new Map(batch.units.map((unit) => [unit.id, unit]))
  const translations = new Map<string, TranslationValue>()
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("text" in item)) throw Error("translation-item-invalid")
    const unit = expected.get(item.id)
    if (!unit || translations.has(item.id)) throw Error("translation-structure-invalid")
    const value = item.text as TranslationValue
    const failure = validateTranslationValue(unit, value)
    if (failure) throw failure
    translations.set(item.id, value)
  }
  return translations
}
