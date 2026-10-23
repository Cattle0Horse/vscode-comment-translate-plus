import type { TextUnit, ReferenceBlock } from "./document.ts"

export type PreserveTerm = string | RegExp

export interface TranslationInput {
  readonly units: readonly TextUnit[]
}

export interface PreparedInput {
  readonly units: readonly (TextUnit & { readonly reference: readonly ReferenceBlock[] })[]
}

export interface TranslationItem {
  readonly id: string
  readonly text: string
}
