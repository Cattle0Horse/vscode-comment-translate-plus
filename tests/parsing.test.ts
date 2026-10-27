import assert from "node:assert/strict"
import { test } from "node:test"
import type { IGrammar, StateStack } from "vscode-textmate"
import { extractCode } from "../src/documents/code.ts"
import { CodeTokenizer } from "../src/documents/tokenization.ts"
import { SourceMap } from "../src/documents/sourceMap.ts"
import { ParseFailure } from "../src/model/diagnostics.ts"
import { parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { parseYaml } from "../src/documents/yaml.ts"
import { prepareTranslation } from "../src/documents/terms.ts"

class QuoteState implements StateStack {
  readonly _stackElementBrand = undefined
  readonly depth: number

  constructor(readonly quoted: boolean) {
    this.depth = quoted ? 2 : 1
  }

  clone(): StateStack {
    return this
  }

  equals(other: StateStack): boolean {
    return other instanceof QuoteState && other.quoted === this.quoted
  }
}

// TextMate's public state/token protocol models a multiline string that changes later comment ownership.
const grammar = {
  tokenizeLine(line: string, state: StateStack) {
    let quoted = state instanceof QuoteState && state.quoted
    let cursor = 0
    const tokens: { startIndex: number; endIndex: number; scopes: string[] }[] = []
    const emit = (end: number, scopes: string[]) => {
      if (end > cursor) tokens.push({ startIndex: cursor, endIndex: end, scopes })
      cursor = end
    }
    while (cursor < line.length) {
      const quote = line.indexOf('"""', cursor)
      const comment = quoted ? -1 : line.indexOf("#", cursor)
      if (comment >= 0 && (quote < 0 || comment < quote)) {
        emit(comment, ["source.fixture"])
        emit(comment + 1, ["comment.line.fixture", "punctuation.definition.comment.fixture"])
        emit(line.length, ["comment.line.fixture"])
      } else if (quote >= 0) {
        emit(quote, [quoted ? "string.quoted.multi.fixture" : "source.fixture"])
        emit(quote + 3, ["string.quoted.multi.fixture", "punctuation.definition.string.fixture"])
        quoted = !quoted
      } else emit(line.length, [quoted ? "string.quoted.multi.fixture" : "source.fixture"])
    }
    return { tokens, fonts: [], ruleStack: new QuoteState(quoted), stoppedEarly: line.includes("TOKENIZATION_TIMEOUT") }
  }
} as unknown as IGrammar

test("incremental parsing equals fresh parsing when edits change multiline state, line count and newline spelling", async () => {
  const tokenizer = new CodeTokenizer(grammar)
  const versions = [
    '# Read the catalog.\nnotice = """Read the original notice.\n# This belongs to the string.\n"""\n# Keep the ticket.',
    '# Read the catalog.\nnotice = """Read the updated notice.\n# This belongs to the string.\n"""\n# Keep the ticket.',
    '# Read the catalog.\nnotice = """Read the updated notice.\n"""\n# This is now a comment.\n# Keep the ticket.',
    "# Read the catalog.\nnotice = Read the updated notice.\n# This is now a comment.\n# Keep the ticket.",
    '# Inserted introduction.\r\n# Read the catalog.\r\nnotice = """Read the original notice.\r\n# This belongs to the string.\r\n"""\r\n# Keep the ticket.',
    "",
    "# Keep the final notice."
  ]
  for (const source of versions) {
    const incremental = await extractCode(source, "fixture", tokenizer, () => {})
    const fresh = await extractCode(source, "fixture", new CodeTokenizer(grammar), () => {})
    assert.deepEqual(incremental, fresh)
    for (const unit of incremental) {
      assert.equal(unit.text, source.slice(unit.start, unit.end))
      const prepared = prepareTranslation(unit, 32)
      assert.equal(prepared.restore(prepared.text), unit.text)
    }
  }
})

test("timeout and cancelled scans never publish incomplete regions or poison the next document version", async () => {
  const tokenizer = new CodeTokenizer(grammar)
  const original = Array.from({ length: 250 }, (_, index) => "# Read catalog section " + index).join("\r\n")
  await tokenizer.tokenize(original, "fixture", () => {})
  const timeout = "# Changed first line.\r\nTOKENIZATION_TIMEOUT\r\n# Keep the source."
  await assert.rejects(
    tokenizer.tokenize(timeout, "fixture", () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ParseFailure)
      assert.equal(error.diagnostic.kind, "timeout")
      assert.equal(timeout.slice(error.diagnostic.range.start, error.diagnostic.range.end), "TOKENIZATION_TIMEOUT")
      return true
    }
  )
  let cancelled = false
  const changed = original.replaceAll("section", "revised section")
  const pending = tokenizer.tokenize(changed, "fixture", () => {
    if (cancelled) throw Error("document-stale")
  })
  cancelled = true
  await assert.rejects(pending, /document-stale/u)
  const source = original.replace("section 249", "section final")
  assert.deepEqual(await extractCode(source, "fixture", tokenizer, () => {}), await extractCode(source, "fixture", new CodeTokenizer(grammar), () => {}))
})

test("source ranges preserve contractions, surrogate pairs and removed literal boundaries without guessing offsets", () => {
  const source = 'A\\U0001F600B"  "C'
  const map = new SourceMap()
  map.append(1, 0, 1)
  map.append(2, 1, 11)
  map.append(1, 11, 12)
  map.append(1, source.indexOf("C"), source.length)
  const emoji = map.range(1, 3)
  assert.equal(source.slice(emoji.start, emoji.end), "\\U0001F600")
  assert.equal(map.offset(4, true), source.indexOf('"'))
  assert.equal(map.offset(4), source.indexOf("C"))
  assert.equal(map.logical(6), undefined)
  assert.equal(map.logical(source.indexOf('"') + 1), undefined)
  assert.throws(() => map.offset(6), /translation-structure-invalid/u)
  assert.throws(() => map.offset(-1), /translation-structure-invalid/u)
})

test("nested fenced syntax diagnostics map to outer CRLF source while valid neighbours remain translatable", async () => {
  const source = ["Read the catalog.", "", "> ~~~~markdown", "> ```yaml", "> title: [broken", "> ```", "> ~~~~", "", "Keep the ticket."].join("\r\n")
  const parse = (text: string): ReturnType<typeof parseMarkdownWithCode> => parseMarkdownWithCode(text, async (inner, language) => (language === "yaml" ? parseYaml(inner) : parse(inner)))
  const document = await parse(source)
  assert.equal(document.errors.length, 1)
  const diagnostic = document.errors[0]
  assert.equal(diagnostic.code, "yaml-invalid")
  assert.equal(diagnostic.language, "yaml")
  // YAML reports EOF: the logical cursor is before the closing fence, after the outer quote prefix.
  const eof = source.indexOf("> ```", source.indexOf("title:")) + 2
  assert.deepEqual(diagnostic.range, { start: eof, end: eof })
  assert.deepEqual(
    document.groups.flatMap((group) => group.units).map((unit) => unit.text),
    ["Read the catalog.", "Keep the ticket."]
  )
})

test("zero-width diagnostics at a stripped container boundary retain one exact source position", async () => {
  const source = ["> ```fixture", "> Read the catalog.", "> Keep the ticket.", "> ```"].join("\r\n")
  const document = await parseMarkdownWithCode(source, async (text, language) => {
    const point = text.indexOf("Keep")
    return { source: text, groups: [], errors: [{ code: "language-tokenization-timeout", kind: "timeout", language, range: { start: point, end: point } }] }
  })
  assert.deepEqual(document.errors[0].range, { start: source.indexOf("Keep"), end: source.indexOf("Keep") })
})
