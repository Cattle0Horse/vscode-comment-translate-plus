import { extractCode } from "../documents/code.ts"
import * as vscode from "vscode"
import { isMarkdownDocument, isYamlDocument } from "./configuration.ts"
import { GrammarExtractor } from "./grammars.ts"
import { parseMarkdownWithCode } from "../documents/markdown.ts"
import { parseYaml } from "../documents/yaml.ts"
import type { ParsedDocument } from "../model/document.ts"
import { prepareSelection } from "../documents/selection.ts"
import { CodeTokenizer } from "../documents/tokenization.ts"
import { ParseFailure } from "../model/diagnostics.ts"

interface TokenizationContext {
  readonly previous: ReadonlyMap<string, CodeTokenizer>
  readonly next: Map<string, CodeTokenizer>
}

export class DocumentReader implements vscode.Disposable {
  readonly grammar: GrammarExtractor
  private readonly parsed = new Map<string, { version: number; promise: Promise<ParsedDocument> }>()
  private readonly tokenized = new Map<string, ReadonlyMap<string, CodeTokenizer>>()
  constructor(
    extensionUri: vscode.Uri,
    private readonly outputPrefix: string
  ) {
    this.grammar = new GrammarExtractor(extensionUri)
  }

  supports(document: vscode.TextDocument): boolean {
    return !this.isOwnOutput(document) && (isMarkdownDocument(document) || isYamlDocument(document) || this.grammar.supports(document.languageId))
  }

  isOwnOutput(document: vscode.TextDocument): boolean {
    return document.uri.scheme === "output" && document.uri.path.startsWith(this.outputPrefix)
  }

  async parseSource(
    source: string,
    language: string,
    checkCurrent: () => void = () => {},
    tokenization: TokenizationContext = { previous: new Map(), next: new Map() },
    path = "root"
  ): Promise<ParsedDocument> {
    checkCurrent()
    language = this.grammar.languageId(language)
    if (["markdown", "md", "skill", "prompt", "instructions", "chatagent"].includes(language)) {
      let fence = 0
      return parseMarkdownWithCode(
        source,
        (text, language) => this.parseSource(text, language, checkCurrent, tokenization, path + "/" + fence++),
        (language) => this.grammar.languageId(language)
      )
    }
    const parsed = language === "yaml" || language === "yml" ? parseYaml(source) : undefined
    if (parsed?.errors.length || !this.grammar.supports(language)) return parsed ?? { source, groups: [], errors: [] }
    try {
      const grammar = await this.grammar.load(language)
      checkCurrent()
      const key = path + ":" + language
      const previous = tokenization.previous.get(key)
      const tokenizer = previous?.grammar === grammar ? previous : new CodeTokenizer(grammar)
      const units = (await extractCode(source, language, tokenizer, checkCurrent)).filter((unit) => !parsed || unit.kind === "comment")
      tokenization.next.set(key, tokenizer)
      return { source, groups: [...(parsed?.groups ?? []), ...units.map((unit) => ({ start: unit.start, end: unit.end, units: [unit] }))].sort((a, b) => a.start - b.start), errors: [] }
    } catch (error) {
      checkCurrent()
      if (error instanceof ParseFailure) return { source, groups: parsed?.groups ?? [], errors: [error.diagnostic] }
      if (error instanceof Error && error.message === "language-grammar-unavailable")
        return { source, groups: parsed?.groups ?? [], errors: [{ code: "language-grammar-unavailable", kind: "grammar", language, range: { start: 0, end: source.length } }] }
      throw error
    }
  }

  async parse(document: vscode.TextDocument, allCode = false, options?: { readonly cache: boolean; readonly signal: AbortSignal }): Promise<ParsedDocument> {
    let parsed: ParsedDocument
    if (options?.cache === false) {
      const version = document.version
      const checkCurrent = () => {
        options.signal.throwIfAborted()
        if (document.isClosed || document.version !== version) throw Error("document-stale")
      }
      parsed = await this.parseSource(document.getText(), isMarkdownDocument(document) ? "markdown" : document.languageId, checkCurrent)
      checkCurrent()
    } else {
      const id = document.uri.toString()
      const version = document.version
      let existing = this.parsed.get(id)
      if (existing?.version !== version) {
        const checkCurrent = () => {
          if (document.isClosed || document.version !== version || this.parsed.get(id)?.promise !== promise) throw Error("document-stale")
        }
        const tokenization = { previous: this.tokenized.get(id) ?? new Map<string, CodeTokenizer>(), next: new Map<string, CodeTokenizer>() }
        const source = document.getText()
        const language = isMarkdownDocument(document) ? "markdown" : document.languageId
        const promise = Promise.resolve()
          .then(() => this.parseSource(source, language, checkCurrent, tokenization))
          .then((parsed) => {
            checkCurrent()
            this.tokenized.set(id, tokenization.next)
            return parsed
          })
        existing = { version, promise }
        this.parsed.set(id, existing)
      }
      parsed = await existing.promise
      if (this.parsed.get(id) !== existing || document.isClosed || document.version !== version) throw Error("document-stale")
    }
    if (allCode) return parsed
    const config = vscode.workspace.getConfiguration("commentTranslatePlus", document.uri)
    return {
      ...parsed,
      groups: parsed.groups
        .map((group) => ({
          ...group,
          units: group.units.filter((unit) => !unit.kind || config.get<boolean>("browse." + (unit.kind === "comment" ? "comments" : "strings"), unit.kind === "comment"))
        }))
        .filter((group) => group.units.length)
    }
  }

  async target(document: vscode.TextDocument, offset: number) {
    if (!this.supports(document)) return
    const parsed = await this.parse(document, true)
    if (isYamlDocument(document) && parsed.errors.length) return
    return parsed.groups.flatMap((group) => group.units).find((unit) => unit.start <= offset && offset < unit.end)
  }

  selection(document: vscode.TextDocument, range: vscode.Range) {
    const start = document.offsetAt(range.start)
    const end = document.offsetAt(range.end)
    return prepareSelection(document.getText(), start, end, isMarkdownDocument(document) ? "markdown" : "text", document.languageId)
  }

  invalidate(uri: vscode.Uri, options?: { readonly retainTokenization: boolean }): Promise<ParsedDocument | undefined> | undefined {
    const id = uri.toString()
    const previous = this.parsed.get(id)
    this.parsed.delete(id)
    if (!options?.retainTokenization) this.tokenized.delete(id)
    return previous?.promise.catch(() => undefined)
  }

  clear(): void {
    this.parsed.clear()
    this.tokenized.clear()
  }

  dispose(): void {
    this.clear()
    this.grammar.dispose()
  }
}
