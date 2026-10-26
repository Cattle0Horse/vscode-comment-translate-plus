import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMarkdown } from "../src/documents/markdown.ts"
import { translatedMarkdown } from "../src/documents/presentation.ts"
import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { TranslationStore } from "../src/translation/store.ts"
import { chatFixture, inputOf, requestTranslation } from "./support/fixtures.ts"

test("translations that omit inline emphasis complete on the first attempt and share cached preview results", async (t) => {
  const cases = [
    {
      source:
        "Authoritative source of HIX's **official** Agent Skills. Each top-level directory is one self-contained Skill package; the General Agent loads these at runtime from S3 (after they are uploaded and synced), so this repository is where the official Skill content is authored, reviewed, and versioned.",
      output:
        "这是 HIX 官方代理技能的来源。每个顶级目录都构成一个独立的技能包；在运行时，General Agent 会从 S3 下载这些技能包（在它们被上传并同步之后）。因此，这个仓库就是存储官方技能内容、进行内容审核以及版本管理的地方。"
    },
    {
      source:
        "- A root `SKILL.md` is **required**: UTF-8 text, YAML frontmatter carrying a non-empty `name`, `description`, and the complete catalog `metadata` mapping, followed by the markdown guide body.",
      output: "需要有一个根目录文件 `SKILL.md`：该文件必须为 UTF-8 格式文本，且包含非空的 `name`、`description` 以及完整的 `metadata` 映射信息，随后是 Markdown 格式的指南内容。"
    },
    { source: "Read *carefully* now.", output: "现在仔细阅读。" },
    { source: "Read _carefully_ now.", output: "现在仔细阅读。" }
  ]
  for (const { source, output } of cases) {
    const fixture = await chatFixture(t, () => output)
    const document = parseMarkdown(source)
    const input = inputOf(document)
    const store = new TranslationStore()
    t.after(() => store.clear())
    const events: TranslationEvent[] = []
    const run = () =>
      store.translate(
        "optional-bold",
        input,
        (request, signal) => requestTranslation(fixture.service, fixture.settings, request, signal, fixture.gate, undefined, { details: false, emit: (event) => events.push(event) }),
        new AbortController().signal
      )
    const result = await run()
    const expected = (source.startsWith("- ") ? "- " : "") + output
    assert.equal(result.get(input.units[0].id), expected)
    assert.equal(translatedMarkdown(document, result), expected)
    assert.ok(events.some((event) => event.kind === "finish" && event.status === "complete" && event.failures.length === 0))
    assert.ok(events.every((event) => event.kind !== "request" || event.failures.length === 0))
    assert.deepEqual(await run(), result)
    assert.equal(fixture.seen.length, 1, "Omitted bold triggered recovery or bypassed the shared cache.")
    assert.equal(document.source, source)
  }
})

test("inline emphasis is model-owned across nested markup, lists, headings and tables", () => {
  for (const [source, output] of [
    ["Read carefully.", "**仔细**阅读。"],
    ["Read **carefully** now.", "**现在**仔细阅读。"],
    ["Read __carefully__ now.", "现在仔细阅读。"],
    ["Read *carefully* now.", "现在仔细阅读。"],
    ["Read _carefully_ now.", "现在仔细阅读。"],
    ["Read carefully.", "*仔细*阅读。"],
    ["Read ***very carefully*** now.", "现在非常仔细地阅读。"],
    ["Read **very *carefully***.", "非常*仔细*地阅读。"],
    ["Read [**guide**](https://example.com).", "阅读**[指南](https://example.com)**。"],
    ["Read [*guide*](https://example.com).", "阅读*[指南](https://example.com)*。"],
    ["# Read **carefully** now.", "# 现在仔细阅读。"],
    ["- Read **carefully** now.", "- 现在仔细阅读。"],
    ["| Read **carefully** now. |\n| --- |", "| 现在仔细阅读。 |\n| --- |"]
  ]) {
    const document = parseMarkdown(source)
    const unit = inputOf(document).units[0]
    const translated = inputOf(parseMarkdown(output)).units[0].text
    assert.equal(validateTranslation(unit, translated), undefined, source)
    assert.equal(translatedMarkdown(document, new Map([[unit.id, translated]])), output)
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.restore(prepareTranslation({ ...unit, text: translated }, emptyPreserveTerms, 32).text), translated)
  }
})

test("optional emphasis cannot hide damaged links, block structure or other required inline syntax", () => {
  for (const [source, output] of [
    ["Read **[guide](https://example.com)**.", "阅读[指南](https://other.example)。"],
    ["Read **~~obsolete~~** text.", "阅读过时的文本。"],
    ["Read **carefully**.", "## 仔细阅读。"],
    ["Read **carefully**.", "仔细阅读。\n\n额外段落。"],
    ["| **Read carefully.** |\n| --- |", "仔细阅读。 | 新列"]
  ]) {
    const document = parseMarkdown(source)
    const unit = inputOf(document).units[0]
    assert.ok(validateTranslation(unit, output), source)
    assert.throws(() => translatedMarkdown(document, new Map([[unit.id, output]])), /translation-structure-invalid/)
  }
})
