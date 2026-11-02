import assert from "node:assert/strict"
import { test } from "node:test"
import { maskGitConflictMarkers } from "../src/documents/git-conflicts.ts"
import { parseMarkdown } from "../src/documents/markdown.ts"

test("Git conflict markers do not consume Markdown prose or change UTF-16 offsets for LF and CRLF", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ["<<<<<<< HEAD 🐎", "Read the map.", "||||||| base", "Keep the ticket.", "=======", "Read the guide.", ">>>>>>> incoming", "", "Keep the receipt."].join(newline)
    const masked = maskGitConflictMarkers(source)
    assert.equal(masked.length, source.length)
    assert.deepEqual(masked.match(/\r?\n/gu), source.match(/\r?\n/gu))
    const units = parseMarkdown(masked).groups.flatMap((group) => group.units)
    assert.deepEqual(
      units.map((unit) => unit.text),
      ["Read the map.", "Keep the ticket.", "Read the guide.", "Keep the receipt."]
    )
    for (const unit of units) assert.equal(unit.text, source.slice(unit.start, unit.end))
  }
})

test("marker sizes, incomplete conflicts and ordinary separators retain explicit boundaries", () => {
  const source = [
    "Heading",
    "=======",
    ">>>>>>> ordinary quote",
    "  <<<<<<< indented example",
    "<<<<<<<<<< ours",
    "Read the map.",
    "==========",
    "Keep the ticket.",
    ">>>>>>>>>> theirs",
    "=======",
    "tail"
  ].join("\n")
  const masked = maskGitConflictMarkers(source)
  assert.equal(masked, source.replace("<<<<<<<<<< ours", " ".repeat(15)).replace("==========", " ".repeat(10)).replace(">>>>>>>>>> theirs", " ".repeat(17)))
  assert.equal(maskGitConflictMarkers("<<<<<<< HEAD\nRead the map."), "            \nRead the map.")
  assert.equal(maskGitConflictMarkers("prefix >>>>>>> label\n=======\n||||||| base"), "prefix >>>>>>> label\n=======\n||||||| base")
})
