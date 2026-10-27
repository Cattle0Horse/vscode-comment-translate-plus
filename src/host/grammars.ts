import type { IGrammar } from "vscode-textmate"
import * as vscode from "vscode"
import { Registry, parseRawGrammar } from "vscode-textmate"
import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma"

interface GrammarContribution {
  readonly language?: string
  readonly scopeName: string
  readonly path: string
  readonly injectTo?: readonly string[]
}

async function readBytes(uri: vscode.Uri): Promise<Uint8Array> {
  if (uri.scheme === "http" || uri.scheme === "https") {
    const response = await fetch(uri.toString())
    if (!response.ok) throw Error("language-grammar-unavailable")
    return new Uint8Array(await response.arrayBuffer())
  }
  return vscode.workspace.fs.readFile(uri)
}

export class GrammarExtractor implements vscode.Disposable {
  private readonly entries = new Map<string, { contribution: GrammarContribution; uri: vscode.Uri }>()
  private readonly languages = new Map<string, string>()
  private readonly aliases = new Map<string, string>()
  private readonly registry: Registry

  constructor(extensionUri: vscode.Uri) {
    for (const extension of vscode.extensions.all) {
      const manifest = extension.packageJSON as { contributes?: { grammars?: GrammarContribution[]; languages?: { id: string; aliases?: string[]; extensions?: string[] }[] } }
      for (const language of manifest.contributes?.languages ?? [])
        for (const name of [language.id, ...(language.aliases ?? []), ...(language.extensions ?? []).map((value) => value.replace(/^\./u, ""))])
          this.aliases.set(name.toLowerCase(), language.id)
      for (const contribution of manifest.contributes?.grammars ?? []) {
        this.entries.set(contribution.scopeName, { contribution, uri: vscode.Uri.joinPath(extension.extensionUri, contribution.path) })
        if (contribution.language) this.languages.set(contribution.language, contribution.scopeName)
      }
    }
    this.registry = new Registry({
      onigLib: readBytes(vscode.Uri.joinPath(extensionUri, "dist/onig.wasm"))
        .then((bytes) => loadWASM(bytes))
        .then(() => ({ createOnigScanner, createOnigString })),
      loadGrammar: async (scope) => {
        const entry = this.entries.get(scope)
        return entry ? parseRawGrammar(new TextDecoder().decode(await readBytes(entry.uri)), entry.uri.path) : null
      },
      getInjections: (scope) => [...this.entries.values()].filter((entry) => entry.contribution.injectTo?.includes(scope)).map((entry) => entry.contribution.scopeName)
    })
  }

  supports(language: string): boolean {
    return this.languages.has(language)
  }

  languageId(name: string): string {
    return this.aliases.get(name.toLowerCase()) ?? name.toLowerCase()
  }

  async load(language: string): Promise<IGrammar> {
    try {
      const scope = this.languages.get(language)
      const grammar = scope ? await this.registry.loadGrammar(scope) : null
      if (grammar) return grammar
    } catch {
      // Filesystem, WASM and grammar compilation failures share one bounded public diagnostic.
    }
    throw Error("language-grammar-unavailable")
  }

  dispose(): void {
    this.registry.dispose()
  }
}
