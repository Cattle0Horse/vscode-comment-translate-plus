import type { TextUnit, ReferenceBlock } from "./document.ts"

export interface PreserveTerms {
  readonly literals: ReadonlySet<string>
  readonly expressions: readonly RegExp[]
  readonly identity: string
}

export interface TranslationInput {
  readonly units: readonly TextUnit[]
}

export interface PreparedInput {
  readonly units: readonly (TextUnit & { readonly reference: readonly ReferenceBlock[]; readonly preserved?: true })[]
}

export interface TranslationItem {
  readonly id: string
  readonly text: string
}

export interface PersistentTranslations {
  get(key: string): Promise<string | undefined>
  set(key: string, text: string): void
  remove(key: string): void
  touch(key: string): void
}
