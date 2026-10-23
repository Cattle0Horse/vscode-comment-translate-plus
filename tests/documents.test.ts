import { emptyPreserveTerms, prepareTranslation } from "../src/documents/terms.ts"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { parseMarkdown, parseMarkdownWithCode } from "../src/documents/markdown.ts"
import { parseYaml, assertYamlStructure } from "../src/documents/yaml.ts"
import { validateTranslation } from "../src/documents/validation.ts"
import { translatedMarkdown, translationDisplayText, displayTranslations } from "../src/documents/presentation.ts"
import { validateTranslations } from "../src/translation/results.ts"
import { TranslationStore } from "../src/translation/store.ts"
import type { TranslationInput } from "../src/model/translation.ts"
import { splitTranslations } from "../src/translation/providers/prompts.ts"
import type { TranslationEvent } from "../src/model/events.ts"
import { sourceReferences } from "../src/documents/references.ts"
import {
  referenceText,
  embeddedMarkdown,
  requestTranslation,
  inputOf,
  modelContext,
  unitReferences,
  batch,
  response,
  waitFor,
  modelInput,
  chatFixture,
  listBatch
} from "./support/fixtures.ts"

test("embedded translations reject missing container prefixes, line-boundary damage, broken links and fence injection", async () => {
  const source = "> ```md\n> Read [guide](https://example.com)\n> and keep `sourceId`.\n> ```"
  const parsed = await embeddedMarkdown(source)
  const unit = parsed.groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  const translated = prepared.restore(prepared.text.replace("Read", "阅读"))
  assert.equal(validateTranslation(unit, unit.text.replace("Read", "阅读").replace("\n> ", "\n")) === undefined, false)
  assert.equal(validateTranslation(unit, translated.replace("example.com", "changed.example")) === undefined, false)
  assert.ok(validateTranslation(unit, prepared.restore(prepared.text.replace("`sourceId`", ""))) === undefined)
  assert.throws(() => prepared.restore(prepared.text + "\nNew paragraph."), /structure-invalid/u)

  const code = "```js\n// Read the guide.\n```"
  const codeParsed = await parseMarkdownWithCode(code, async (source) => ({
    source,
    groups: [{ start: 0, end: source.trimEnd().length, units: [{ id: "comment", start: 0, end: source.trimEnd().length, text: source.trimEnd(), format: "text", kind: "comment" }] }],
    errors: []
  }))
  const comment = codeParsed.groups[0].units[0]
  assert.throws(() => translatedMarkdown(codeParsed, new Map([[comment.id, "// Translated\n```\n# Injected"]])), /structure-invalid/u)
})

test("malformed fenced YAML retains source and valid neighbouring Markdown remains translatable", async () => {
  const source = "Read the guide.\n\n```yaml\nvalue: [invalid\n```\n\n```md\nRead more.\n```"
  const parsed = await embeddedMarkdown(source)
  assert.deepEqual(parsed.errors, ["yaml-invalid"])
  const translations = new Map(
    parsed.groups
      .flatMap((group) => group.units)
      .map((unit) => [unit.id, prepareTranslation(unit, emptyPreserveTerms, 32).restore(prepareTranslation(unit, emptyPreserveTerms, 32).text.replaceAll("Read", "阅读"))])
  )
  assert.equal(translatedMarkdown(parsed, translations), source.replaceAll("Read", "阅读"))
})

test("local meaning wins over distant titles and YAML ancestors under a tight reference budget", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["# " + "General ".repeat(120), "", "- Billing: statements and invoices for customer accounts.", "  - Charge"].join(newline)
    const child = inputOf(parseMarkdown(source)).units.at(-1)!
    const context = referenceText([{ ...child, reference: unitReferences(child, 2000) }])
    assert.equal(context, "- Billing: statements and invoices for customer accounts.")
    const yaml = "root_" + "x".repeat(970) + ":" + newline + "  state: State of the electrical switch"
    const field = inputOf(parseYaml(yaml)).units.find((unit) => unit.content === "state")!
    assert.equal(referenceText([{ ...field, reference: unitReferences(field, 2000) }]), "  state: State of the electrical switch")
    assert.equal(child.text.trim(), "- Charge")
    assert.equal(field.content, "state")
    const continuation = inputOf(parseMarkdown(["- Billing: statements and invoices for customer accounts.", "", "  " + "General ".repeat(120), "", "  Charge."].join(newline))).units.at(
      -1
    )!
    assert.equal(referenceText([{ ...continuation, reference: unitReferences(continuation, 2000) }]), "- Billing: statements and invoices for customer accounts.")
  }
})

test("headings use their direct explanation and paragraph neighbours stay within structural boundaries", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["# Manual", "", "## Charge", "", "Apply an electrical charge to the capacitor.", "", "Keep it.", "", "## Billing", "", "Charge the customer."].join(newline)
    const units = inputOf(parseMarkdown(source)).units
    const heading = units.find((unit) => unit.text === "## Charge")!
    const headingContext = referenceText([{ ...heading, reference: unitReferences(heading, 2000) }])
    assert.equal(headingContext, "# Manual\n\nApply an electrical charge to the capacitor.")
    const short = units.find((unit) => unit.text === "Keep it.")!
    const shortContext = referenceText([{ ...short, reference: unitReferences(short, 2000) }])
    assert.ok(shortContext.includes("Apply an electrical charge to the capacitor.") && !shortContext.includes("Billing"))
    const separated = inputOf(parseMarkdown("# Section\n\n- Other item.\n\n> Quoted paragraph.\n\nShort.\n\n" + "Long prose. ".repeat(12))).units
    for (const unit of separated.filter((unit) => unit.text === "Short." || unit.text.startsWith("Long prose."))) {
      const context = referenceText([{ ...unit, reference: unitReferences(unit, 2000) }])
      assert.ok(context.includes("Short.") && context.includes("Long prose."), "Complete neighbouring paragraphs were not available to an isolated target.")
      assert.ok(!context.includes("Quoted paragraph") && !context.includes("Other item"), "A context crossed its list or quote container.")
    }
    const noLead = inputOf(parseMarkdown("## Charge\n\n- List boundary\n\nUnrelated later paragraph.")).units[0]
    const noLeadContext = referenceText([{ ...noLead, reference: unitReferences(noLead, 2000) }])
    assert.ok(noLeadContext.includes("List boundary") && !noLeadContext.includes("Unrelated later"), "A heading skipped its direct list to collect unrelated prose.")
  }
})

test("table references select the header, delimiter and full row atomically", () => {
  const source = "| Operation | Meaning |\n| --- | --- |\n| Charge | Apply electricity. |"
  const unit = inputOf(parseMarkdown(source)).units.find((unit) => unit.text === "Charge")!
  assert.equal(referenceText([{ ...unit, reference: unitReferences(unit, source.length) }]), source)
  assert.equal(referenceText([{ ...unit, reference: unitReferences(unit, source.length - 1) }]), "", "A partial table lost the relationship between its columns and target row.")
})

test("isolated Markdown targets retain neighbouring rules, section guidance and document background", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "You are the Coordinator Agent. Choose the workflow and delegate work.",
      "",
      "## Routing and Planning",
      "",
      "Discover skills before executing the requested workflow.",
      "",
      "### Skills",
      "",
      "- Discover a matching skill for the current request.",
      "- Load the selected skill before execution.",
      "- Skill guidance cannot grant consent or expand scope.",
      "",
      "## Unrelated section",
      "",
      "Unrelated confidential context."
    ].join(newline)
    const units = inputOf(parseMarkdown(source)).units
    const target = units.find((unit) => unit.text.includes("cannot grant consent"))!
    const context = referenceText([{ ...target, reference: unitReferences(target, 2000) }])
    for (const required of ["Load the selected skill", "Discover skills before", "You are the Coordinator Agent", "### Skills"])
      assert.ok(context.includes(required), "An isolated rule lost its explanatory context: " + required)
    assert.ok(!context.includes("Unrelated"), "Reference selection crossed a section boundary.")
    const heading = units.find((unit) => unit.text === "### Skills")!
    const headingContext = referenceText([{ ...heading, reference: unitReferences(heading, 2000) }])
    assert.ok(headingContext.includes("Discover a matching skill"), "A list-led heading has no explanation of its contents.")
  }
})

test("Markdown neighbours use complete blocks for long prose and fall back within the unit budget", () => {
  const previous = "Explain the electrical meaning of charge."
  const target = "Apply the charge to the capacitor and keep the connection stable until the next operation completes."
  const next = "Disconnect the supply after charging."
  const units = inputOf(parseMarkdown(["## Circuit", previous, target, next, "## Billing", "Charge the customer."].join("\n\n"))).units
  const unit = units.find((item) => item.text === target)!
  const context = referenceText([{ ...unit, reference: unitReferences(unit, 2000) }])
  assert.ok(context.includes(previous) && context.includes(next) && !context.includes("customer"), "Long prose lost adjacent context or crossed into billing.")
  const oversized = "- " + "Remote detail ".repeat(120)
  const tight = inputOf(parseMarkdown(["## Circuit", "", oversized, "- Disconnect the supply.", "- Keep it disconnected."].join("\n"))).units.at(-1)!
  const fallback = referenceText([{ ...tight, reference: unitReferences(tight, 2000) }])
  assert.ok(fallback.includes("- Disconnect the supply.") && !fallback.includes("Remote detail"), "An oversized window prevented a smaller complete neighbour from fitting.")
})

test("reference output follows global source order across headings and list containers regardless of target order", () => {
  const source = "# Guide\n\n## Left section\n\n- Left parent.\n  - Left target.\n\n## Right section\n\n- Right parent.\n  - Right target."
  const units = inputOf(parseMarkdown(source)).units.filter((unit) => unit.text.includes("target."))
  const expected = "# Guide\n\n## Left section\n\n- Left parent.\n\n## Right section\n\n- Right parent."
  assert.equal(referenceText(units), expected)
  assert.equal(referenceText(units.slice().reverse()), expected)
})

test("source windows fall back to complete nearer lines without truncation or mixing alternatives", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["x".repeat(1100), "// Electrical input", 'const state = "Open";', "// End input", "y".repeat(1100)].join(newline)
    const start = source.indexOf("Open")
    const unit = { id: "open", start, end: start + 4, text: "Open", format: "text" as const, kind: "string" as const }
    const referenced = { ...unit, reference: sourceReferences(source, unit, "typescript") }
    assert.equal(referenceText([{ ...referenced, reference: unitReferences(referenced, 2000) }]), ["// Electrical input", 'const state = "Open";', "// End input"].join(newline))
    assert.equal(referenceText([{ ...referenced, reference: unitReferences(referenced, 30) }]), 'const state = "Open";')
    assert.equal(referenceText([{ ...referenced, reference: unitReferences(referenced, 10) }]), "")
  }
})

test("reference equality removes duplicate body across entry points without ignoring meaningful internal differences", () => {
  const unit = { id: "one", start: 0, end: 15, text: "Read this text.", format: "text" as const }
  const same = { ...unit, reference: [{ kind: "Reference", text: "\r\nRead this text.\r\n" }] }
  assert.deepEqual(unitReferences(same, 2000), [])
  assert.equal(referenceText([same]), "")
  const different = { ...unit, reference: [{ kind: "Reference", text: "Read  this text." }] }
  assert.equal(unitReferences(different, 2000).length, 1)
  assert.ok(referenceText([different]).includes("Read  this text."))
  assert.deepEqual(unitReferences(different, 0), [])
  for (const text of ["- Read this text.", "2. Read this text."])
    assert.deepEqual(unitReferences({ ...unit, text, end: text.length, format: "markdown", reference: [{ kind: "Reference", text: "Read this text." }] }, 2000), [])
  assert.deepEqual(
    unitReferences(
      {
        ...unit,
        reference: [
          { kind: "Long", text: "x".repeat(1200) },
          { kind: "Title", text: "Guide" }
        ]
      },
      100
    ),
    [{ kind: "Title", text: "Guide" }]
  )
})

test("Markdown references preserve heading ownership, parent list and table relationships without later chapters", () => {
  const source = "# Document title\n\n## Current section\n\n- Parent item.\n  - Child item.\n\n| Mode | Output |\n| --- | --- |\n| Hotspot | Brief |\n\n## Later section\n\nLater body."
  const units = parseMarkdown(source).groups.flatMap((group) => group.units)
  const child = units.find((unit) => unit.text.includes("Child item."))!
  const childContext = referenceText([{ ...child, reference: unitReferences(child, 2000) }])
  assert.ok(childContext.includes("Document title") && childContext.includes("Current section") && childContext.includes("Parent item."))
  assert.ok(!childContext.includes("Later section") && !childContext.includes("Child item."))
  const title = units.find((unit) => unit.text === "# Document title")!
  assert.equal(referenceText([{ ...title, reference: unitReferences(title, 2000) }]), "")
  const cell = units.find((unit) => unit.text === "Hotspot")!
  const cellContext = referenceText([{ ...cell, reference: unitReferences(cell, 2000) }])
  assert.ok(cellContext.includes("| Mode | Output |\n| --- | --- |\n| Hotspot | Brief |") && !cellContext.includes("Later section"))
  assert.equal(prepareTranslation(cell, emptyPreserveTerms, 32).text, "Hotspot")
  assert.equal(referenceText([cell, cell]), cellContext, "Repeated raw context was emitted once per item.")
  const header = units.find((unit) => unit.text === "Mode")!
  assert.ok(referenceText([{ ...header, reference: unitReferences(header, 2000) }]).includes("| Mode | Output |\n| --- | --- |"), "Header context lost its original table separator row.")
})

test("masked Markdown retains original local context without duplicating plain source or exceeding reference budgets", () => {
  const source = "# Links and tables\n\n**R**ead [the guide][guide] and keep `sourceId_abcdefghijklmnopqrstuvwxyz_123456789` unchanged."
  const unit = inputOf(parseMarkdown(source)).units[1]
  const selected = { ...unit, reference: unitReferences(unit, 2000) }
  const context = referenceText([selected])
  assert.ok(context.includes(unit.text), "The model cannot see the source hidden by inline protection markers.")
  assert.ok(context.includes("# Links and tables"))
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32, context)
  assert.ok(!prepared.text.includes("sourceId_abcdefghijklmnopqrstuvwxyz") && prepared.hasMarkers)
  assert.equal(prepared.restore(prepared.text), unit.text)
  assert.equal(referenceText([{ ...unit, reference: unitReferences(unit, 0) }]), "")
  assert.ok(referenceText([{ ...unit, reference: unitReferences(unit, 25) }]).length <= 25)
  const longSource = "x".repeat(1200) + "\n" + unit.text
  const surrounded = { ...unit, start: 1201, end: longSource.length }
  const bounded = { ...surrounded, reference: unitReferences({ ...surrounded, reference: sourceReferences(longSource, surrounded, "markdown") }, 150) }
  assert.equal(referenceText([bounded]), unit.text, "An oversized surrounding window discarded the smaller original context needed to understand markers.")
  const plain = inputOf(parseMarkdown("Read the complete guide.")).units[0]
  assert.equal(referenceText([{ ...plain, reference: unitReferences(plain, 2000) }]), "")
})

test("nested fenced units inherit only their outer headings and list ancestors with exact LF and CRLF source ranges", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "# Guide",
      "",
      "## Current section",
      "",
      "- Parent instructions",
      "",
      "  ````md",
      "  ### Inner section",
      "",
      "  ```yaml",
      "  title: Read the guide.",
      "  ```",
      "  ````",
      "",
      "## Later section"
    ].join(newline)
    const parsed = await embeddedMarkdown(source)
    const unit = inputOf(parsed).units.find((item) => item.content === "Read the guide.")!
    const context = referenceText([{ ...unit, reference: unitReferences(unit, 2000) }])
    assert.ok(context.includes("# Guide") && context.includes("## Current section") && context.includes("### Inner section"), "A nested fence lost its owning heading path.")
    assert.ok(context.includes("- Parent instructions") && !context.includes("Later section"))
    for (const block of unit.reference ?? []) if (block.range) assert.equal(source.slice(block.range.start, block.range.end), block.text)
    assert.equal(prepareTranslation(unit, emptyPreserveTerms, 32).restore(prepareTranslation(unit, emptyPreserveTerms, 32).text), unit.text)
  }
})

test("YAML context retains raw field syntax while translation still splits key and scalar value", () => {
  const units = parseMarkdown("---\nmetadata:\n  description: |\n    Read both lines.\n    Keep their meaning.\n---").groups.flatMap((group) => group.units)
  const value = units.find((unit) => unit.content?.includes("Read both lines."))!
  const raw = "metadata:\n  description: |\n    Read both lines.\n    Keep their meaning."
  assert.equal(referenceText([{ ...value, reference: unitReferences(value, 2000) }]), raw)
  assert.equal(value.content, "Read both lines.\nKeep their meaning.\n")
  const key = units.find((unit) => unit.content === "description")!
  const context = referenceText([{ ...key, reference: unitReferences(key, 2000) }])
  assert.equal(context, raw)
  assert.equal(prepareTranslation(key, emptyPreserveTerms, 32).text, "description")
  const preparedValue = prepareTranslation(value, emptyPreserveTerms, 32)
  assert.ok(!/[\r\n]/u.test(preparedValue.text))
  assert.equal(preparedValue.restore(preparedValue.text), value.text)
})

test("YAML collection keys reference complete values while descendants keep only ancestor headers and their own field", () => {
  for (const newline of ["\n", "\r\n"]) {
    const metadata = "metadata:\n  availability: active\n  flags:\n    - enabled\n    - disabled\n  nested:\n    read_only: false".replaceAll("\n", newline)
    const source = ["---", metadata, "outside: ignored", "---"].join(newline)
    const units = inputOf(parseMarkdown(source)).units
    for (const [name, expected] of [
      ["metadata", metadata],
      ["flags", "metadata:" + newline + "  flags:\n    - enabled\n    - disabled".replaceAll("\n", newline)],
      ["nested", "metadata:" + newline + "  nested:\n    read_only: false".replaceAll("\n", newline)],
      ["availability", "metadata:" + newline + "  availability: active"]
    ]) {
      const unit = units.find((item) => item.content === name)!
      assert.equal(referenceText([{ ...unit, reference: unitReferences(unit, 2000) }]), expected)
      assert.equal(prepareTranslation(unit, emptyPreserveTerms, 32).text, name)
    }
    const parent = units.find((unit) => unit.content === "metadata")!
    assert.deepEqual(unitReferences(parent, metadata.length - 1), [], "An oversized collection reference was truncated to its field header.")
    assert.equal(source.slice(parent.display!.start, parent.display!.end), "metadata:", "Full reference expanded the parent's editor display range.")
  }
})

test("source context keeps a contiguous raw excerpt with two neighboring lines and omits duplicate body", () => {
  const source = "old\r\nbefore2\r\nbefore1\r\nTARGET\r\nafter1\r\nafter2\r\nfar"
  const unit = { start: source.indexOf("TARGET"), end: source.indexOf("TARGET") + 6 }
  const blocks = sourceReferences(source, unit, "typescript")
  assert.equal(blocks[0].kind, "Source (typescript)")
  assert.equal(blocks[0].text, "before2\r\nbefore1\r\nTARGET\r\nafter1\r\nafter2\r\n")
  assert.equal(sourceReferences(source, { ...unit, end: unit.end + 2 }, "typescript")[0].text, blocks[0].text, "Selecting the line ending acquired a third following line.")
  const standalone = { id: "code", start: 0, end: 6, text: "TARGET", format: "text" as const }
  assert.deepEqual(unitReferences({ ...standalone, reference: sourceReferences("TARGET", standalone, "typescript") }, 2000), [])
})

test("overlapping source and selection windows merge by source position without adding distant or duplicate lines", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = (await readFile("fixtures/development/comments.rs", "utf8")).replace(/\r?\n/g, newline)
    const units = ["/// Read the original document.", "/* Keep `sourceId` unchanged. */", '"Read the original document."'].map((text, index) => {
      const start = source.indexOf(text)
      const unit = { id: "code" + index, text, start, end: start + text.length, format: "text" as const }
      return { ...unit, reference: sourceReferences(source, unit, "rust") }
    })
    assert.equal(referenceText(units), source.trimEnd())
    assert.equal(referenceText([...units].reverse()), source.trimEnd(), "Source order depended on the request order.")
    const repeated = "before\nTARGET\nafter\n" + "gap\n".repeat(8) + "before\nTARGET\nafter\n"
    const targets = [repeated.indexOf("TARGET"), repeated.lastIndexOf("TARGET")].map((start, index) => {
      const unit = { id: "selection" + index, start, end: start + 6, text: "TARGET", format: "text" as const }
      return { ...unit, reference: sourceReferences(repeated, unit, "plaintext") }
    })
    const context = referenceText(targets)
    assert.equal(context.match(/TARGET/g)?.length, 2, "Equal text at distinct source locations was collapsed.")
    assert.ok(!context.includes("gap\ngap\ngap"), "Disjoint windows acquired unselected source lines.")
  }
})

test("Markdown references retain unique heading ancestry and the full raw list ancestry", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["# Guide", "", "## Section", "", "First target.", "", "### Detail", "", "- Parent context.", "  - Child context.", "    - Grandchild target."].join(newline)
    const units = inputOf(parseMarkdown(source)).units
    const selected = units.filter((unit) => /First target|Grandchild target/.test(unit.text))
    const context = referenceText(selected)
    assert.equal(context.match(/# Guide/g)?.length, 1, "Document title was repeated as a section heading.")
    assert.equal(context.match(/## Section/g)?.length, 1)
    assert.ok(context.includes("- Parent context." + newline + "  - Child context."))
    assert.ok(!context.includes("Grandchild target."))
    assert.equal(referenceText([...selected].reverse()), context)
    const repeated = inputOf(parseMarkdown("# Guide\n\n## Same\n\nFirst target.\n\n## Same\n\nSecond target.")).units.filter((unit) => unit.text.endsWith("target."))
    assert.equal(referenceText(repeated).match(/## Same/g)?.length, 2, "Distinct sections lost their ownership because their text matched.")
  }
  const introduction = inputOf(parseMarkdown("Intro target.\n\n# Later title\n\nLater body.")).units[0]
  assert.equal(referenceText([introduction]), "", "A future heading leaked into an earlier paragraph's reference.")
  const repeatedTitle = inputOf(parseMarkdown("# Guide\n\n# Guide\n\nTarget paragraph.")).units.at(-1)!
  assert.equal(referenceText([{ ...repeatedTitle, reference: unitReferences(repeatedTitle, 2000) }]).match(/# Guide/g)?.length, 2)
})

test("nested tables keep their own header delimiter, quote prefixes and container while YAML keeps original line endings", () => {
  for (const newline of ["\n", "\r\n"]) {
    const table = ["> | Label | Value |", "> | --- | --- |", "> | Same | One |"].join(newline)
    const source = table + newline + ">" + newline + table.replace("One", "Two")
    const units = inputOf(parseMarkdown(source)).units
    assert.equal(units.length, 8, "A CRLF table was parsed as a paragraph instead of independent cells.")
    assert.equal(referenceText(units), table + "\n\n" + table.replace("One", "Two"))
    for (const unit of units) assert.equal(source.slice(unit.start, unit.end), unit.text)
    assert.equal(validateTranslation(units[0], "Label | extra") === undefined, false, "Cell structure validation accepted another column.")
    const parsed = parseMarkdown(source)
    assert.equal(translatedMarkdown(parsed, new Map(units.map((unit) => [unit.id, unit.text === "One" ? "第一项" : unit.text]))), source.replace("One", "第一项"))
    const yaml = ["metadata:", "  first: One", "  second: Two"].join(newline)
    const fields = inputOf(parseMarkdown(["---", yaml, "---"].join(newline))).units.filter((unit) => unit.content === "One" || unit.content === "Two")
    assert.equal(referenceText(fields), yaml)
  }
})

test("seven real list items retain distinct raw source ranges", async () => {
  const text = await readFile("fixtures/lists.md", "utf8")
  const input = inputOf(parseMarkdown(text))
  assert.equal(input.units.length, 7)
  assert.deepEqual(
    input.units.map((unit) => text.slice(unit.start, unit.end)),
    text.trimEnd().split("\n")
  )
  assert.equal(referenceText(input.units), text.trimEnd(), "Overlapping neighbour windows duplicated or omitted source list items.")
})

test("nested task lists, parent continuation, quotes, CRLF and Unicode preserve ownership", () => {
  const text = "# 😀 Title\r\n\r\n- [ ] Parent\r\n  - Child\r\n\r\n  After child.\r\n\r\n> 1. Quoted item."
  const units = parseMarkdown(text).groups.flatMap((group) => group.units)
  assert.deepEqual(
    units.map((unit) => unit.text),
    ["# 😀 Title", "- [ ] Parent", "  - Child", "  After child.", "> 1. Quoted item."]
  )
  for (const unit of units) assert.equal(text.slice(unit.start, unit.end), unit.text)
  assert.equal(units.at(-1)!.start, text.indexOf("> 1."))
})

test("frontmatter separates keys and complete string values while non-string data stays local", async () => {
  const text = await readFile("fixtures/SKILL.md", "utf8")
  const parsed = parseMarkdown(text)
  assert.deepEqual(parsed.errors, [])
  const fields = parsed.groups[0].units
  assert.equal(fields.length, 7)
  assert.ok(fields.some((unit) => unit.text.startsWith(">\n  Translate complete fields.\n") && unit.content?.includes("Translate complete fields.")))
  assert.ok(fields.some((unit) => unit.text.startsWith('"Read the first line\n')))
  assert.equal(fields.find((unit) => unit.content === "enabled")?.text, "enabled")
  assert.ok(!fields.some((unit) => unit.text === "true" || unit.protected?.length), "Non-string data was sent to the translator.")
  const empty = parseMarkdown("---\noptional:\n---")
  const key = empty.groups[0].units[0]
  assert.equal(key.text, "optional")
  assert.equal(translatedMarkdown(empty, new Map([[key.id, "可选"]])), "---\n可选:\n---")
  assert.ok(!parsed.groups.flatMap((group) => group.units).some((unit) => unit.text.includes("const message")))
})

test("nested YAML, sequences, quoted strings and CRLF use original ranges", () => {
  const text = '---\r\nmeta:\r\n  description: |\r\n    First line\r\n    Second line\r\n  tags:\r\n    - "Read this"\r\n  count: 2\r\n---\r\n'
  const units = parseMarkdown(text).groups.flatMap((group) => group.units)
  assert.ok(units.some((unit) => unit.text === "|\r\n    First line\r\n    Second line" && unit.content === "First line\nSecond line\n"))
  assert.ok(units.some((unit) => unit.text === '"Read this"' && unit.content === "Read this"))
  assert.ok(units.some((unit) => unit.content === "count") && !units.some((unit) => unit.text === "2"))
  for (const unit of units) assert.equal(text.slice(unit.start, unit.end), unit.text)
})

test("fenced code and link definitions are not translation units; table prose is", () => {
  const text = "```ts\nDo not translate\n```\n\n[ref]: https://example.com\n\n| Header | Other |\n| --- | --- |\n| Text | `code` |"
  const units = parseMarkdown(text).groups.flatMap((group) => group.units)
  assert.equal(units.length, 3)
  assert.ok(units.every((unit) => !unit.text.includes("Do not translate") && !unit.text.includes("https://example.com")))
})

test("invalid YAML is reported and not translated through a permissive fallback", () => {
  const parsed = parseMarkdown("---\nname: [broken\n---\n\nBody text.")
  assert.deepEqual(parsed.errors, ["frontmatter-invalid"])
  assert.deepEqual(
    parsed.groups.flatMap((group) => group.units).map((unit) => unit.text),
    ["Body text."]
  )
})

test("an unfinished frontmatter block is not mistaken for Markdown prose", () => {
  const parsed = parseMarkdown("---\nname: unfinished\ndescription: [")
  assert.deepEqual(parsed.errors, ["frontmatter-incomplete"])
  assert.deepEqual(parsed.groups, [])
})

test("IDs allow response reordering while only originally multiline units allow soft reflow", () => {
  const result = validateTranslations(batch, response)
  assert.equal(result.get(batch.units[0].id), "1. 第一项包含 `code`。")
  assert.throws(() => prepareTranslation(batch.units[0], emptyPreserveTerms, 32).restore("第一项包含\n   `code`。"), /translation-structure-invalid/)
  const multiline = { ...batch.units[0], text: batch.units[0].text.replace("with ", "with\n   ") }
  assert.ok(validateTranslation(multiline, "1. 第一项包含\n   `code`。") === undefined)
})

for (const defect of ["missing", "duplicate", "unknown", "link", "merged", "invalid-type"]) {
  test(`rejects ${defect} output without guessing correspondence`, () => {
    const parsed = { items: response.map((item) => ({ ...item })) }
    if (defect === "missing") parsed.items.pop()
    if (defect === "duplicate") parsed.items[1].id = parsed.items[0].id
    if (defect === "unknown") parsed.items[0].id = "other"
    if (defect === "link") parsed.items[0].text = "2. 第二项[指南](https://other.example)。"
    if (defect === "merged") parsed.items = [{ id: batch.units[0].id, text: "1. 第一项 第二项" }]
    const text = defect === "invalid-type" ? "unexpected text" : parsed.items
    assert.throws(() => validateTranslations(batch, text))
  })
}

test("inline code content and delimiters may change while surrounding Markdown structure stays intact", () => {
  const source = "`members` is required when `supersedes` is set."
  const document = parseMarkdown(source)
  const unit = document.groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, source)
  assert.equal(prepared.hasMarkers, false)
  const restored = prepared.restore("当设置 `supersedes` 时，必须提供 `members`。")
  assert.equal(validateTranslation(unit, restored) === undefined, true)
  assert.equal(translatedMarkdown(document, new Map([[unit.id, restored]])), restored)
  assert.equal(validateTranslation(unit, restored.replace("supersedes", "supersides")) === undefined, true)
  assert.equal(validateTranslation(unit, restored.replace("`supersedes`", "`members`")) === undefined, true)
  const formatted = parseMarkdown("**Use `members`.** Then set `supersedes`.").groups[0].units[0]
  assert.equal(validateTranslation(formatted, "**使用 `supersedes`。** 然后设置 `members`。") === undefined, true)
  assert.equal(validateTranslation(formatted, "设置 `supersedes`，然后 **使用 `members`。**") === undefined, true)
  assert.ok(validateTranslation(unit, prepared.restore("`members``members`")) === undefined)
  assert.throws(() => prepared.restore(prepared.text + "<CTP999>"), /marker-mismatch/)
})

test("paired formatting restores original delimiter boundaries around Chinese punctuation and rejects crossed pairs", () => {
  const source = "**B — Industry / Competitive.** Confirm scope across **Comparison dimensions**, write the **Industry report**, and produce a **Monitoring checklist**."
  const document = parseMarkdown(source)
  const unit = document.groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, source)
  const response = prepared.text
    .replace("B — Industry / Competitive.", "B — 行业/竞争分析。")
    .replace("Confirm scope across", "确认范围，按")
    .replace("Comparison dimensions", "比较维度")
    .replace(", write the", "撰写")
    .replace("Industry report", "行业报告")
    .replace(", and produce a", "并生成")
    .replace("Monitoring checklist", "监控清单")
  const restored = prepared.restore(response)
  assert.ok(restored.startsWith("**B — 行业/竞争分析。** 确认范围"), "The original safe closing boundary was lost.")
  assert.equal(validateTranslation(unit, restored) === undefined, true)
  assert.equal(translatedMarkdown(document, new Map([[unit.id, restored]])), restored)
  const crossed = response.replace("**比较维度**", "*比较维度**")
  assert.equal(validateTranslation(unit, crossed) === undefined, false)
  assert.ok(prepared.text.includes("Confirm scope"), "Natural language was hidden along with the delimiters.")
})

test("assembled Markdown rejects table-column injection and list nesting loss", () => {
  const table = parseMarkdown("| Header | Other |\n| --- | --- |\n| Read text. | Keep text. |")
  const cell = table.groups.flatMap((group) => group.units).find((unit) => unit.text === "Read text.")!
  assert.equal(validateTranslation(cell, "译文 | 新列") === undefined, false)
  assert.throws(() => translatedMarkdown(table, new Map([[cell.id, "译文 | 新列"]])), /structure-invalid/)
  const nested = parseMarkdown("- Parent item.\n  - Child item.")
  const child = nested.groups.flatMap((group) => group.units).find((unit) => unit.text.includes("Child"))!
  assert.equal(validateTranslation(child, "- 子项。") === undefined, true)
  assert.throws(() => translatedMarkdown(nested, new Map([[child.id, "- 子项。"]])), /structure-invalid/)
  assert.equal(translatedMarkdown(nested, new Map([[child.id, "  - 子项。"]])), "- Parent item.\n  - 子项。")
})

test("extra Markdown output reports structure changes instead of claiming intact code was modified", () => {
  const unit = inputOf(parseMarkdown("Call `write_file` with `artifact_ids`.")).units[0]
  const output = "## 来源项目\n\n调用 `write_file`，并提供 `artifact_ids`。"
  assert.equal(validateTranslation(unit, output) === undefined, false)
  const added = validateTranslation(unit, output)!
  assert.ok(added.reason.includes("新增") && !added.reason.includes("代码"), "The new heading was mistaken for damage to intact code.")
  assert.equal(added.actual, "##")
  const changed = validateTranslation(unit, output.replace("artifact_ids", "artifact_id"))!
  assert.equal(changed.actual, "##")
})

test("inline-code changes do not disable link-target validation", () => {
  for (const format of ["markdown", "text"] as const) {
    const unit = { id: "probe", start: 0, end: 11, text: "Use `read`.", format }
    for (const output of ["使用 `write`。", "使用 read。", "直接阅读。", "使用 `read` 和 `run_command`。"]) assert.ok(validateTranslation(unit, output) === undefined, output)
    const output = "使用 `write`。然后使用 [audio](https://example.com/audio)。"
    assert.equal(validateTranslation(unit, output) === undefined, false)
    const difference = validateTranslation(unit, output)!
    assert.ok(difference.reason.includes("新增"))
    assert.equal(difference.actual, "https://example.com/audio")
  }
})

test("configured character targets and growth factors measure final messages and preserve oversized complete units", async (t) => {
  const fixture = await chatFixture(t, (_body, items) => items.join("\n\n%%\n\n"))
  const input = {
    units: Array.from({ length: 8 }, (_, index) => ({ id: String(index), start: index * 130, end: index * 130 + 129, text: "Original " + "x".repeat(120), format: "text" as const }))
  }
  const settings = {
    ...fixture.settings,
    systemPrompt: "",
    userPrompt: "${content}",
    initialItemsPerRequest: 8,
    initialRequestCharacters: 300,
    batchGrowthSuccesses: 1,
    batchGrowthFactor: 2,
    maxConcurrentRequests: 1
  }
  await requestTranslation(fixture.service, settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    fixture.seen.map((request) => request.items.length),
    [2, 4, 2]
  )
  const before = fixture.seen.length
  await requestTranslation(
    fixture.service,
    { ...settings, adaptiveBatching: false, initialRequestCharacters: 1000, maxRequestCharacters: 300 },
    input,
    new AbortController().signal,
    fixture.gate
  )
  assert.deepEqual(
    fixture.seen.slice(before).map((request) => request.items.length),
    [2, 2, 2, 2]
  )
  assert.ok(fixture.seen.slice(before).every(({ body }) => body.messages.reduce((sum, message) => sum + message.content.length, 0) <= 300))
  const single = { units: [{ ...input.units[0], text: "Original " + "x".repeat(400), end: 409 }] }
  await requestTranslation(fixture.service, settings, single, new AbortController().signal, fixture.gate)
  assert.equal(fixture.seen.at(-1)!.items[0], single.units[0].text)
})

test("cancellation retains only already validated progress and retries neither cancelled work nor successful neighbours", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const input = listBatch(3)
  const store = new TranslationStore()
  const controller = new AbortController()
  const action = (batch: TranslationInput, signal: AbortSignal, completed: (item: { id: string; text: string }) => void) =>
    requestTranslation(fixture.service, fixture.settings, batch, signal, fixture.gate, completed)
  await assert.rejects(store.translate("cancelled", input, action, controller.signal, false, () => controller.abort()))
  await waitFor(() => fixture.seen.length === 1)
  const result = await store.translate("cancelled", input, action, new AbortController().signal)
  assert.equal(result.size, 3)
  assert.equal(fixture.seen.length, 2)
  assert.equal(fixture.seen[1].items.length, 2)
  store.clear()
})

test("literal delimiter lines remain source data and multiline fields are not split by physical newlines", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const input = inputOf(parseMarkdown("Keep a literal separator.\n%%\nKeep the complete paragraph.\n\nKeep the second paragraph."))
  const result = await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate)
  assert.deepEqual(
    [...validateTranslations(input, result).values()],
    input.units.map((unit) => unit.text)
  )
  assert.deepEqual(splitTranslations("description: |\n  First line.\n  Second line.\n\n%%\n\nHeading", "%%", 2), ["description: |\n  First line.\n  Second line.", "Heading"])
  assert.throws(() => splitTranslations("A\n%%\nB\n%%\nC", "%%", 2), /items-mismatch/)
  assert.throws(() => splitTranslations("A\n\nB", "%%", 2), /items-mismatch/)
})

test("reference boundaries use one newline without changing internal blank lines or indentation", async (t) => {
  const fixture = await chatFixture(t, (body) => modelInput(body))
  const unit = inputOf(parseMarkdown("Original paragraph.")).units[0]
  for (const newline of ["\n", "\r\n"]) {
    const content = ["  Parent reference.", "", "    Child reference.  "].join(newline)
    for (const padding of ["", newline, newline + " \t" + newline]) {
      const input = { units: [{ ...unit, reference: [{ kind: "Source", text: padding + content + padding }] }] }
      const events: TranslationEvent[] = []
      await requestTranslation(fixture.service, fixture.settings, input, new AbortController().signal, fixture.gate, undefined, {
        details: true,
        emit: (event) => events.push(event)
      })
      assert.equal(modelContext(fixture.seen.at(-1)!.body), content)
      const request = events.find((event) => event.kind === "request")!
      assert.ok(request.kind === "request" && request.contextCharacters === content.length)
    }
  }
})

test("YAML browse text uses translated keys and complete scalar values without serialization indicators", () => {
  assert.equal(translationDisplayText("描述: |\n  第一行。\n  第二行。\n", "yaml"), "描述: 第一行。\n第二行。\n")
  assert.equal(translationDisplayText("描述: |-\n  第一行。\n  第二行。\n", "yaml"), "描述: 第一行。\n第二行。")
  assert.equal(translationDisplayText("描述: >-\n  第一行。\n  第二行。\n", "yaml"), "描述: 第一行。 第二行。")
  assert.equal(translationDisplayText('  描述: "第一行。\\n第二行。"', "yaml"), "描述: 第一行。\n第二行。")
  assert.equal(translationDisplayText("- 描述: |2-\n    第一行。\n    第二行。", "yaml"), "- 描述: 第一行。\n第二行。")
  assert.equal(translationDisplayText('描述: "保留真正的 | 和 > 字符。"', "yaml"), "描述: 保留真正的 | 和 > 字符。")
  assert.equal(translationDisplayText("元数据", "yaml"), "元数据")
  assert.equal(translationDisplayText("启用: TRUE\n优先级: 0x10\n可选: ~", "yaml"), "启用: TRUE\n优先级: 0x10\n可选: ~")
  assert.equal(translationDisplayText("| Markdown | table |", "markdown"), "| Markdown | table |")
  assert.throws(() => translationDisplayText("描述: [invalid", "yaml"), /structure-invalid/)
})

test("standalone YAML uses original scalar ranges across LF/CRLF, BOM, streams and missing final newline", async () => {
  for (const name of ["yaml-fields.yaml", "yaml-stream.yml"]) {
    const fixture = await readFile("fixtures/development/" + name, "utf8")
    for (const newline of ["\n", "\r\n"]) {
      const source = "\uFEFF" + fixture.trimEnd().replace(/\r?\n/g, newline)
      const parsed = parseYaml(source)
      assert.deepEqual(parsed.errors, [])
      assert.equal(parsed.groups.length, name.endsWith(".yml") ? 2 : 1)
      const units = parsed.groups.flatMap((group) => group.units)
      assert.equal(units.length, name.endsWith(".yml") ? 16 : 10)
      const results = units.map((unit) => {
        assert.equal(source.slice(unit.start, unit.end), unit.text)
        assert.ok(!["true", "false", "TRUE", "0x10", "~", "*base"].includes(unit.text))
        return {
          ...unit,
          translation: prepareTranslation(unit, emptyPreserveTerms, 32).restore(
            prepareTranslation(unit, emptyPreserveTerms, 32).text.replace("name", "名称").replace("Read the original document.", "阅读原始文档。")
          )
        }
      })
      const views = displayTranslations(source, results)
      assert.ok(views.some((row) => translationDisplayText(row.translation, "yaml").startsWith("名称:")))
      let translated = source
      for (const unit of [...results].sort((a, b) => b.start - a.start)) translated = translated.slice(0, unit.start) + unit.translation + translated.slice(unit.end)
      assert.doesNotThrow(() => assertYamlStructure(source, translated))
      assert.equal(parsed.source, source)
    }
  }
})

test("invalid standalone YAML is rejected without text fallback and replacement preserves stream structure and native types", () => {
  for (const source of ["name: [invalid", "name: first\nname: second", "---\nname: value\n---\nname: [invalid"]) {
    const parsed = parseYaml(source)
    assert.deepEqual(parsed.errors, ["yaml-invalid"])
    assert.deepEqual(parsed.groups, [])
  }
  const source = "name: text\nenabled: true\n---\ncount: 0x10\nbase: &base text\nalias: *base"
  assert.doesNotThrow(() => assertYamlStructure(source, source.replace("name: text", '"名称": "文字"')))
  for (const translated of [source.replace("true", '"true"'), source.replace("0x10", "17"), source.replace("*base", "text"), source.replace("---\n", ""), "name: [invalid"])
    assert.throws(() => assertYamlStructure(source, translated), /structure-invalid/)
})

test("YAML reading rows retain field colons and native values for complete and partial translations", () => {
  const translated = new Map([
    ["name", "名称"],
    ["data-analysis", "数据分析"],
    ["metadata", "元数据"],
    ["availability", "可用性"],
    ["active", "可用的"],
    ["default_enabled", "默认启用"],
    ["read_only", "只读"],
    ["priority", "优先级"],
    ["optional", "可选"]
  ])
  for (const newline of ["\n", "\r\n"]) {
    const source = ["---", "name: data-analysis", "metadata:", "  availability: active", "  default_enabled: true", "  read_only: false", "  priority: 0x10", "  optional: ~", "---"].join(
      newline
    )
    for (const parsed of [parseMarkdown(source), parseYaml(source.slice(3 + newline.length, -3 - newline.length))]) {
      const original = parsed.source
      const units = inputOf(parsed).units
      assert.deepEqual(
        units.map((unit) => unit.content),
        [...translated.keys()],
        "Native values became translation items."
      )
      const results = units.map((unit) => ({ ...unit, translation: prepareTranslation(unit, emptyPreserveTerms, 32).restore(translated.get(unit.content!)!) }))
      const rows = displayTranslations(original, results)
      assert.deepEqual(
        rows.map((row) => translationDisplayText(row.translation, "yaml").trimEnd()),
        ["名称: 数据分析", "元数据:", "可用性: 可用的", "默认启用: true", "只读: false", "优先级: 0x10", "可选: ~"]
      )
      assert.equal(rows[2].text, "  availability: active", "Nested field indentation was lost before rendering.")
      const partial = displayTranslations(
        original,
        results.filter((unit) => unit.content === "availability")
      )
      assert.equal(translationDisplayText(partial[0].translation, "yaml"), "可用性: active")
      assert.deepEqual(
        displayTranslations(
          original,
          units.map((unit) => ({ ...unit, translation: unit.text }))
        ),
        [],
        "Unchanged fields painted duplicate rows."
      )
    }
  }
})

test("translated YAML keys and multiline values stay valid for previews while browse text omits block syntax", async (t) => {
  const fixture = await chatFixture(t, (body) =>
    modelInput(body).replace("description", "描述").replace("Read the complete field.", "阅读完整字段。").replace("Keep both lines together.", "保留两行在一起。")
  )
  const source = "---\ndescription: |\n  Read the complete field.\n  Keep both lines together.\n---"
  const parsed = parseMarkdown(source)
  const batch = inputOf(parsed)
  const result = validateTranslations(batch, await requestTranslation(fixture.service, fixture.settings, batch, new AbortController().signal, fixture.gate))
  const views = displayTranslations(
    source,
    batch.units.map((unit) => ({ ...unit, translation: result.get(unit.id)! }))
  )
  assert.equal(views.length, 1)
  assert.equal(translationDisplayText(views[0].translation, "yaml"), "描述: 阅读完整字段。 保留两行在一起。 ")
  assert.ok(translatedMarkdown(parsed, result).includes('"描述": "阅读完整字段。 保留两行在一起。 "'))
  assert.equal(parsed.source, source)
  assert.equal(fixture.seen[0].items[0], "description")
  assert.ok(
    fixture.seen[0].items[1].startsWith("Read the complete field. Keep both lines together.") && !fixture.seen[0].items.some((text) => text.includes("description:") || text.includes("|"))
  )
})

test("YAML scalar translation leaves native types and layout local, including flow collections, aliases and explicit block indentation", () => {
  const source =
    '---\r\nbase: &base value\r\nmeta: {name: "Read text.", flags: [true, false, 0x10, ~], alias: *base}\r\ndescription: |2-\r\n    Read text.\r\n    Keep text.\r\nnext: false # untouched\r\n---'
  const parsed = parseMarkdown(source)
  const units = parsed.groups.flatMap((group) => group.units)
  assert.deepEqual(parsed.errors, [])
  assert.ok(!units.some((unit) => ["true", "false", "0x10", "~", "*base"].includes(unit.text)))
  const translations = new Map(
    units.map((unit) => {
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.ok(!/[\r\n]/u.test(prepared.text), "YAML newlines reached the model.")
      assert.equal(prepared.restore(prepared.text), unit.text, "YAML syntax or scalar content changed.")
      return [unit.id, prepared.restore(prepared.text.replaceAll("Read text.", "阅读：文本。").replaceAll("Keep text.", "保留文本。"))] as const
    })
  )
  const translated = translatedMarkdown(parsed, translations)
  assert.ok(translated.includes("flags: [true, false, 0x10, ~]") && translated.includes("alias: *base") && translated.includes("next: false # untouched"))
  assert.ok(translated.includes('"  阅读：文本。 保留文本。"'), "Block indentation became part of source layout instead of the correct scalar value.")
  for (const unit of units) assert.equal(source.slice(unit.start, unit.end), unit.text)
})

test("editor table rows preserve exact pipes and unchanged neighbours when a subset of cells translates", () => {
  const source = "| Header | Other |\n| :--- | ---: |\n| Read text.  | Keep `code` unchanged. |\n"
  const units = parseMarkdown(source).groups.flatMap((group) => group.units)
  const cell = units.find((unit) => unit.text === "Read text.")!
  const views = displayTranslations(source, [{ ...cell, translation: "阅读文本。" }])
  assert.equal(views.length, 1)
  assert.equal(views[0].text, "| Read text.  | Keep `code` unchanged. |")
  assert.equal(views[0].translation, "| 阅读文本。  | Keep `code` unchanged. |")
  assert.equal(validateTranslation(cell, "阅读文本。 | 新列") === undefined, false)
  const escaped = parseMarkdown("| Read \\| text. | Other |\n| --- | --- |").groups[0].units[0]
  assert.equal(validateTranslation(escaped, "阅读 \\| 文本。") === undefined, true)
  assert.equal(validateTranslation(escaped, "阅读 \\* 文本。") === undefined, false)
})

test("Python triple quote boundary tokens stay local without masking internal escapes", () => {
  for (const quote of ['"""', "'''"]) {
    for (const [opening, closing] of [
      [true, false],
      [false, true],
      [true, true]
    ]) {
      const body = "Create a SearchAgent for web and image search."
      const text = (opening ? quote : "") + body + (closing ? quote : "")
      const unit = {
        id: "docstring",
        start: 0,
        end: text.length,
        text,
        kind: "string" as const,
        format: "text" as const,
        protected: [...(opening ? [{ start: 0, end: 3 }] : []), ...(closing ? [{ start: text.length - 3, end: text.length }] : [])]
      }
      const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
      assert.equal(prepared.text, body)
      assert.equal(prepared.hasMarkers, false)
      assert.equal(prepared.restore("创建一个用于网页和图像搜索的 SearchAgent。"), text.replace(body, "创建一个用于网页和图像搜索的 SearchAgent。"))
      assert.equal(prepared.restore(prepared.text), text)
      const escapeStart = (opening ? quote.length : 0) + body.length
      const escapedText = text.slice(0, escapeStart) + "\\nRead text." + text.slice(escapeStart)
      const escaped = {
        ...unit,
        text: escapedText,
        end: escapedText.length,
        protected: [
          ...(opening ? [{ start: 0, end: 3 }] : []),
          { start: escapeStart, end: escapeStart + 2 },
          ...(closing ? [{ start: escapedText.length - 3, end: escapedText.length }] : [])
        ]
      }
      const internal = prepareTranslation(escaped, emptyPreserveTerms, 32)
      assert.equal(internal.hasMarkers, false)
      assert.throws(() => internal.restore("阅读文本。"), /structure-invalid/)
    }
  }
})

test("Python concatenated literals preserve interpolation and ordered syntax through translation", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = ["f\"Skill '{name}' is already loaded in this \"", '        "session. Continue reading."'].join(newline)
    const boundary = text.indexOf('"' + newline)
    const interpolation = text.indexOf("{name}")
    const unit = {
      id: "python-concatenation",
      start: 0,
      end: text.length,
      text,
      kind: "string" as const,
      format: "text" as const,
      language: "python",
      protected: [
        { start: 0, end: 2 },
        { start: interpolation, end: interpolation + 6 },
        { start: boundary, end: boundary + newline.length + 10 },
        { start: text.length - 1, end: text.length }
      ]
    }
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, text.slice(2, -1))
    assert.equal(prepared.restore(prepared.text), text)
    const translated = prepared.restore(prepared.text.replace("Skill", "技能").replace("Continue reading.", "继续阅读。"))
    assert.equal(translated, text.replace("Skill", "技能").replace("Continue reading.", "继续阅读。"))
    assert.ok(validateTranslation(unit, translated) === undefined)
    assert.throws(() => prepared.restore(prepared.text.replace("{name}", "")), /structure-invalid/u)
    assert.throws(
      () =>
        prepared.restore(
          prepared.text
            .replace("{name}", "<SWAP>")
            .replace(text.slice(boundary, boundary + newline.length + 10), "{name}")
            .replace("<SWAP>", text.slice(boundary, boundary + newline.length + 10))
        ),
      /structure-invalid/u
    )
  }
})

test("list prefixes and indentation stay local for ordered, unordered, task and quoted items", () => {
  for (const source of [
    "- Read the original document.",
    "+ Read the original document.",
    "* Read the original document.",
    "7. Read the original document.",
    "12) Read the original document.",
    "  - Read the original document.",
    "- Parent.\n\t- Read the original document.",
    "  - [x] Read the original document.",
    "> 7. Read the original document.",
    "> - [ ] Read the original document."
  ]) {
    const unit = parseMarkdown(source)
      .groups.flatMap((group) => group.units)
      .find((unit) => unit.text.includes("Read the original document."))!
    assert.ok(unit, "List fixture did not produce a translation unit: " + JSON.stringify(source))
    const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
    assert.equal(prepared.text, "Read the original document.", "A local prefix was sent as model content: " + JSON.stringify(unit.text))
    const restored = prepared.restore("阅读原始文档。")
    assert.equal(restored, unit.text.replace("Read the original document.", "阅读原始文档。"))
    assert.equal(validateTranslation(unit, restored) === undefined, true)
  }
  const source = "  - Read `sourceId`."
  const unit = parseMarkdown(source).groups[0].units[0]
  const prepared = prepareTranslation(unit, emptyPreserveTerms, 32)
  assert.equal(prepared.text, "Read `sourceId`.", "Local list syntax either leaked or consumed the protected inline code.")
  assert.equal(prepared.restore("阅读 `sourceId`。"), "  - 阅读 `sourceId`。")
  assert.equal(prepared.restore("阅读 sourceId。"), "  - 阅读 sourceId。")
})

test("block-comment rejection reports the delimiter mismatch that actually failed", () => {
  const unit = { id: "comment", start: 0, end: 16, text: "/* Read this. */", format: "text" as const, kind: "comment" as const }
  for (const output of ["/* 阅读。", "*/ 阅读。 /*", "/* 阅读。 */ /* */"]) {
    const failure = validateTranslation(unit, output)
    assert.ok(failure)
    assert.match(failure.modelReason, /block-comment delimiters/)
    assert.ok(failure.instruction.includes("/*") && failure.instruction.includes("*/") && failure.instruction.includes("order"))
    assert.equal(failure.expected, "/* */")
    assert.equal(failure.actual, (output.match(/\/\*|\*\//g) ?? []).join(" "))
  }
  assert.equal(validateTranslation(unit, "/* 阅读。 */"), undefined)
})

test("string syntax and protected-fragment order reject with their own corrections", () => {
  const scalar = inputOf(parseYaml('message: "Read this."')).units[1]
  const invalid = validateTranslation(scalar, "[broken")
  assert.ok(invalid)
  assert.match(invalid.instruction, /YAML string scalar/)
  assert.equal(validateTranslation(scalar, '"阅读。"'), undefined)
  const text = "Read [one](https://one.example) then [two](https://two.example)."
  const unit = { id: "text", start: 0, end: text.length, text, format: "text" as const }
  const reordered = validateTranslation(unit, "阅读 [二](https://two.example)，然后 [一](https://one.example)。")
  assert.ok(reordered)
  assert.match(reordered.instruction, /original order/)
})

test("HTML additions report markup errors while inline-code mentions remain allowed", () => {
  for (const output of ["第一章打开<head>和<body>。", "<section>第一章</section>"]) {
    const unit = inputOf(parseMarkdown("The first chapter opens document/head/body.")).units[0]
    const failure = validateTranslation(unit, output)
    assert.ok(failure)
    assert.match(failure.reason, /HTML/)
    assert.match(failure.modelReason, /HTML/)
    assert.match(failure.instruction, /Remove HTML/)
    assert.match(failure.instruction, /plain text without angle brackets/)
  }
  const unit = inputOf(parseMarkdown("The first chapter opens document/head/body.")).units[0]
  assert.equal(validateTranslation(unit, "第一章打开 document/head/body。"), undefined)
  assert.equal(validateTranslation(unit, "第一章打开 `<head>` 和 `<body>`。"), undefined)
  const owned = inputOf(parseMarkdown("Read <span>this</span>.")).units[0]
  assert.ok(validateTranslation(owned, "阅读此内容。"))
})

test("recognizable added and missing markup gets corrections for the actual syntax", () => {
  const plain = inputOf(parseMarkdown("Read the original document.")).units[0]
  const list = inputOf(parseMarkdown("- Read the original document.")).units[0]
  for (const [unit, output, correction] of [
    [plain, "阅读 ~~原始文档~~。", /Remove emphasis or strikethrough/],
    [plain, "> 阅读原始文档。", /Remove blockquote prefixes/],
    [plain, "- 阅读原始文档。", /Remove list items/],
    [list, "- [x] 阅读原始文档。", /Remove task-list checkboxes/],
    [inputOf(parseMarkdown("Read **the original document**.")).units[0], "阅读原始文档。", /source emphasis delimiters/],
    [inputOf(parseMarkdown("Read <span>the original document</span>.")).units[0], "阅读原始文档。", /source HTML tags/],
    [inputOf(parseMarkdown("Read [Title].")).units[0], "阅读内容。", /source reference-link labels/]
  ] as const) {
    const failure = validateTranslation(unit, output)
    assert.ok(failure, output)
    assert.match(failure.instruction, correction)
  }
})
