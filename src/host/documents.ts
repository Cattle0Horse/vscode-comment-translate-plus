import { extractCode } from "../documents/code.ts"
import * as vscode from "vscode"
import { isMarkdownDocument, isYamlDocument } from "./configuration.ts"
import { GrammarExtractor } from "./grammars.ts"
import { parseMarkdownWithCode } from "../documents/markdown.ts"
import { parseYaml } from "../documents/yaml.ts"
import type { ParsedDocument } from "../model/document.ts"
import { sourceReferences } from "../documents/references.ts"

export class DocumentReader implements vscode.Disposable {
  readonly grammar: GrammarExtractor
  private readonly parsed = new Map<string, { version: number; promise: Promise<ParsedDocument> }>()
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

  async parseSource(source: string, language: string, checkCurrent: () => void = () => {}): Promise<ParsedDocument> {
    checkCurrent()
    language = this.grammar.languageId(language)
    if (["markdown", "md", "skill", "prompt", "instructions", "chatagent"].includes(language))
      return parseMarkdownWithCode(
        source,
        (text, language) => this.parseSource(text, language, checkCurrent),
        (language) => this.grammar.languageId(language)
      )
    const parsed = language === "yaml" || language === "yml" ? parseYaml(source) : undefined
    if (parsed?.errors.length || !this.grammar.supports(language)) return parsed ?? { source, groups: [], errors: [] }
    const units = (await extractCode(source, language, await this.grammar.load(language), checkCurrent)).filter((unit) => !parsed || unit.kind === "comment")
    return { source, groups: [...(parsed?.groups ?? []), ...units.map((unit) => ({ start: unit.start, end: unit.end, units: [unit] }))].sort((a, b) => a.start - b.start), errors: [] }
  }

  async parse(document: vscode.TextDocument, allCode = false): Promise<ParsedDocument> {
    const id = document.uri.toString()
    const version = document.version
    let existing = this.parsed.get(id)
    if (existing?.version !== version) {
      const checkCurrent = () => {
        if (document.isClosed || document.version !== version) throw Error("document-stale")
      }
      const promise = this.parseSource(document.getText(), isMarkdownDocument(document) ? "markdown" : document.languageId, checkCurrent).then((parsed) => {
        checkCurrent()
        return parsed
      })
      existing = { version, promise }
      this.parsed.set(id, existing)
    }
    const parsed = await existing.promise
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
    return {
      id: "selection",
      start,
      end,
      text: document.getText(range),
      format: isMarkdownDocument(document) ? ("markdown" as const) : ("text" as const),
      reference: sourceReferences(document.getText(), { start, end }, document.languageId)
    }
  }

  invalidate(uri: vscode.Uri): Promise<ParsedDocument | undefined> | undefined {
    const id = uri.toString()
    const previous = this.parsed.get(id)
    this.parsed.delete(id)
    return previous?.promise.catch(() => undefined)
  }

  clear(): void {
    this.parsed.clear()
  }

  dispose(): void {
    this.parsed.clear()
    this.grammar.dispose()
  }
}
