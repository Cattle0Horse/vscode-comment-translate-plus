export interface TextUnit {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly text: string
  readonly format: "markdown" | "yaml" | "text"
  readonly content?: string
  readonly yamlKey?: boolean
  readonly display?: { readonly start: number; readonly end: number }
  readonly protected?: readonly { readonly start: number; readonly end: number }[]
  readonly kind?: "comment" | "string"
  readonly reference?: readonly ReferenceBlock[]
  readonly scope?: string
  readonly language?: string
  /** Normalized Markdown definition keys, including definitions outside this unit. */
  readonly linkLabels?: readonly string[]
  readonly embedding?: { readonly unit: TextUnit; readonly prefixes: readonly string[] }
  /** Python prose is parsed in decoded coordinates; literal syntax stays local. */
  readonly pythonString?: {
    readonly unit: TextUnit
    readonly prefix: string
    readonly continuation: string
    readonly quote: string
    readonly raw: boolean
    readonly formatted: boolean
    readonly expressions: readonly string[]
  }
}

export interface TextGroup {
  readonly start: number
  readonly end: number
  readonly units: readonly TextUnit[]
}

export interface ParsedDocument {
  readonly source: string
  readonly groups: readonly TextGroup[]
  readonly errors: readonly string[]
  readonly codeBlocks?: readonly EmbeddedCode[]
  readonly linkLabels?: readonly string[]
}

export interface EmbeddedCode {
  readonly start: number
  readonly end: number
  readonly language: string
  readonly source: string
  readonly pieces: readonly { readonly from: number; readonly to: number; readonly offset: number }[]
  readonly parsed?: ParsedDocument
  readonly reference?: readonly ReferenceBlock[]
}

export interface ProtectedFragment {
  readonly kind: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly pair?: string
  readonly side?: "open" | "close"
}

export interface TranslationDifference {
  readonly reason: string
  /** English reason for model-correctable failures; human-only diagnostics may omit it. */
  readonly modelReason?: string
  readonly expected?: string
  readonly actual?: string
}

export interface ReferenceBlock {
  readonly kind: string
  readonly text: string
  readonly range?: { readonly start: number; readonly end: number; readonly container: number }
  /** Parser-owned atomic group, scoped to this unit's reference candidates. */
  readonly group?: number
  /** Ordered alternatives: keep the first complete candidate that fits. */
  readonly alternative?: number
}
