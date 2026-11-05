import assert from "node:assert/strict"
import type { TranslationValue } from "../../src/model/translation.ts"

/** Paths expecting source-compatible output must reject display candidates as well as missing results. */
export function validatedText(value: TranslationValue | undefined): string {
  assert.ok(typeof value === "string", "Expected a validated translation, not a display candidate or missing result.")
  return value
}
