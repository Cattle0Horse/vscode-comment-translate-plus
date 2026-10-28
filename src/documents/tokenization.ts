import { INITIAL } from "vscode-textmate"
import type { IGrammar, IToken, StateStack } from "vscode-textmate"
import { ParseFailure } from "../model/diagnostics.ts"

export interface TokenLine {
  readonly text: string
  readonly tokens: readonly IToken[]
  readonly state: StateStack
}

/** One document/fence owns one immutable grammar's last complete tokenization. */
export class CodeTokenizer {
  private lines: readonly TokenLine[] = []

  constructor(readonly grammar: IGrammar) {}

  async tokenize(source: string, language: string, checkCurrent: () => void): Promise<readonly TokenLine[]> {
    checkCurrent()
    const text = source.split(/\r?\n/u)
    const previous = this.lines
    let prefix = 0
    while (prefix < text.length && prefix < previous.length && text[prefix] === previous[prefix].text) prefix++
    let suffix = 0
    while (suffix < text.length - prefix && suffix < previous.length - prefix && text[text.length - suffix - 1] === previous[previous.length - suffix - 1].text) suffix++
    const lines: TokenLine[] = previous.slice(0, prefix)
    let state = lines.at(-1)?.state ?? INITIAL
    let offset = 0
    for (let index = 0; index < prefix; index++) offset += text[index].length + (source.startsWith("\r\n", offset + text[index].length) ? 2 : 1)
    for (let index = prefix; index < text.length; index++) {
      if (index > prefix && (index - prefix) % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        checkCurrent()
      }
      const current = text[index]
      const old = index + previous.length - text.length
      const before = old > 0 ? previous[old - 1]?.state : INITIAL
      if (index >= text.length - suffix && before && state.equals(before)) {
        for (let remaining = old; remaining < previous.length; remaining++) lines.push(previous[remaining])
        break
      }
      const result = this.grammar.tokenizeLine(current, state, 100)
      if (result.stoppedEarly) throw new ParseFailure({ code: "language-tokenization-timeout", kind: "timeout", language, range: { start: offset, end: offset + current.length } })
      state = result.ruleStack
      lines.push({ text: current, tokens: result.tokens, state })
      offset += current.length + (source.startsWith("\r\n", offset + current.length) ? 2 : 1)
    }
    checkCurrent()
    this.lines = lines
    return lines
  }
}

export interface SourceToken {
  readonly start: number
  readonly end: number
  readonly scopes: readonly string[]
}

export interface RegionToken extends SourceToken {
  readonly scope: string
  readonly kind: "comment" | "string"
  readonly multiline: boolean
  readonly protected: boolean
  readonly complete?: boolean
  readonly depth?: number
}

export interface CodeSpan {
  start: number
  end: number
  readonly kind: "comment" | "string"
  readonly scope: string
  readonly multiline: boolean
  readonly depth?: number
  readonly protected: { start: number; end: number }[]
  complete?: boolean
  commentPrefix?: string
  indent?: string
}

export function* sourceTokens(source: string, lines: readonly TokenLine[]): Iterable<SourceToken> {
  let offset = 0
  for (const line of lines) {
    for (const token of line.tokens) {
      const end = offset + Math.min(token.endIndex, line.text.length)
      const start = offset + token.startIndex
      if (end > start) yield { start, end, scopes: token.scopes }
    }
    offset += line.text.length + (source.startsWith("\r\n", offset + line.text.length) ? 2 : 1)
  }
}

export function regionToken(token: SourceToken, scope = token.scopes.find((value) => value.startsWith("comment.") || value.startsWith("string."))): RegionToken | undefined {
  if (!scope) return
  return {
    ...token,
    scope,
    kind: scope.startsWith("comment.") ? "comment" : "string",
    multiline: scope.startsWith("comment.block") || token.scopes.some((value) => value.startsWith("string.quoted.") && value.includes(".multi.")) || scope.startsWith("string.template"),
    protected: token.scopes.some(
      (value) =>
        value.startsWith("punctuation.definition.comment") ||
        value.startsWith("punctuation.definition.string") ||
        value.startsWith("constant.character.escape") ||
        value.startsWith("meta.template.expression") ||
        value.startsWith("meta.interpolation")
    )
  }
}
