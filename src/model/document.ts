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
  /** TextMate-owned line-comment delimiter; continuation layout stays local. */
  readonly commentPrefix?: string
  readonly reference?: readonly ReferenceBlock[]
  readonly scope?: string
  readonly language?: string
  /** Normalized Markdown definition keys, including definitions outside this unit. */
  readonly linkLabels?: readonly string[]
  readonly projection?: UnitProjection
}

/** Syntax owners expose prose conversion, never their AST or language-specific state. */
export type UnitProjection =
  | { readonly kind: "container"; readonly unit: TextUnit; readonly prefixes: readonly string[] }
  | {
      readonly kind: "literal"
      readonly unit: TextUnit
      readonly codec: {
        readonly identity: string
        readonly invalid: { readonly reason: string; readonly instruction: string; readonly difference: TranslationDifference }
        restore(text: string): string
        content(text: string): string
        display(text: string): string
      }
    }

/** Half-open UTF-16 ranges in logical text and its immediate source text. */
export interface SourcePiece {
  readonly from: number
  readonly to: number
  readonly start: number
  readonly end: number
}

export interface TextGroup {
  readonly start: number
  readonly end: number
  readonly units: readonly TextUnit[]
}

export interface ParsedDocument {
  readonly source: string
  readonly groups: readonly TextGroup[]
  readonly errors: readonly ParseDiagnostic[]
  readonly codeBlocks?: readonly EmbeddedCode[]
  readonly linkLabels?: readonly string[]
}

export interface ParseDiagnostic {
  readonly code: "frontmatter-incomplete" | "frontmatter-invalid" | "yaml-invalid" | "language-grammar-unavailable" | "language-tokenization-timeout"
  readonly kind: "syntax" | "grammar" | "timeout"
  readonly language: string
  readonly range: { readonly start: number; readonly end: number }
}

export interface EmbeddedCode {
  readonly start: number
  readonly end: number
  readonly language: string
  readonly source: string
  readonly pieces: readonly SourcePiece[]
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
