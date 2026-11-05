import type { TextUnit, ReferenceBlock } from "./document.ts"

export interface PreserveTerms {
  readonly literals: ReadonlySet<string>
  readonly expressions: readonly RegExp[]
  readonly phrases: ReadonlyMap<string, readonly PreservePhrase[]>
  readonly identity: string
}

/** Phrase tails are indexed by their first word; each following word owns its preceding whitespace. */
export type PreservePhrase = readonly { readonly word: string; readonly gap: string }[]

export interface TranslationInput {
  readonly units: readonly TextUnit[]
}

export interface PreparedInput {
  readonly units: readonly (TextUnit & { readonly reference: readonly ReferenceBlock[]; readonly preserved?: true })[]
}

export interface TranslationItem {
  readonly id: string
  readonly text: TranslationValue
}

/** A candidate is display text, never serialized source or a persistent validated result. */
export interface TranslationCandidate {
  readonly kind: "candidate"
  readonly text: string
  readonly attempt: number
  readonly code: string
}

export type TranslationValue = string | TranslationCandidate

export function translationText(value: TranslationValue): string {
  return typeof value === "string" ? value : value.text
}

export interface PersistentTranslations {
  get(key: string): Promise<string | undefined>
  set(key: string, text: string, allowEviction?: boolean): boolean | undefined
  remove(key: string): void
  touch(key: string): void
  reserve(units: readonly { readonly key: string; readonly text: string }[], allowEviction: boolean): "reserved" | "disabled" | "full"
  releaseReservation(key: string): void
}
