import type { TranslationInput } from "../model/translation.ts"
import { validateTranslation } from "../documents/validation.ts"

export function validateTranslations(batch: TranslationInput, parsed: unknown): Map<string, string> {
  if (!Array.isArray(parsed) || parsed.length !== batch.units.length) throw Error("translation-items-mismatch")
  const expected = new Map(batch.units.map((unit) => [unit.id, unit]))
  const translations = new Map<string, string>()
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("text" in item) || typeof item.text !== "string") throw Error("translation-item-invalid")
    const unit = expected.get(item.id)
    if (!unit || translations.has(item.id) || validateTranslation(unit, item.text) !== undefined) throw Error("translation-structure-invalid")
    translations.set(item.id, item.text)
  }
  return translations
}
