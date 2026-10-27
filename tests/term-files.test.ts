import assert from "node:assert/strict"
import { test } from "node:test"
import { termSource, parseTermFile, appendPreserveTerm } from "../src/documents/termFiles.ts"
import { parsePreserveTerms, isPreservedTerm } from "../src/documents/terms.ts"

test("term sources distinguish Windows drives, UNC, Unix, URI and workspace-relative paths without losing filename characters", () => {
  for (const [input, expected] of [
    ["C:\\Users\\sample-user\\词 表#1%.json", "file:///c:/Users/sample-user/%E8%AF%8D%20%E8%A1%A8%231%25.json"],
    ["C:/Users/sample-user/../terms.jsonc", "file:///c:/Users/terms.jsonc"],
    ["\\\\server\\share\\词 表.json", "file://server/share/%E8%AF%8D%20%E8%A1%A8.json"],
    ["//server/share/terms.json", "file://server/share/terms.json"],
    ["/home/sample-user/词 表.json", "file:///home/sample-user/%E8%AF%8D%20%E8%A1%A8.json"],
    ["file:///C:/Users/sample-user/terms.json", "file:///c:/Users/sample-user/terms.json"],
    ["./.vscode/terms.json", "file:///c:/repo/.vscode/terms.json"],
    [".\\.vscode\\terms.json", "file:///c:/repo/.vscode/terms.json"],
    ["../shared/terms.json", "file:///c:/shared/terms.json"],
    ["https://example.com/terms.jsonc?v=2", "https://example.com/terms.jsonc?v=2"]
  ])
    assert.equal(termSource(input, "file:///c:/repo"), expected, input)
  assert.equal(termSource("./terms.json", "vscode-remote://ssh-remote+host/home/sample-user/repo"), "vscode-remote://ssh-remote+host/home/sample-user/repo/terms.json")
  assert.equal(termSource("~/terms.json", undefined, "C:\\Users\\sample-user"), "file:///c:/Users/sample-user/terms.json")
  assert.equal(termSource("~\\terms.jsonc", undefined, "/home/sample-user"), "file:///home/sample-user/terms.jsonc")
  assert.equal(termSource("terms.json", "file:///repo/space%20name"), "file:///repo/space%20name/terms.json")
})

test("ambiguous paths and untrusted network forms are rejected before reading a source", () => {
  for (const input of [
    "",
    " ",
    "C:terms.json",
    "~other/terms.json",
    "terms.json",
    "~/terms.json",
    "http://example.com/terms.json",
    "https://user:password@example.com/terms.json",
    "https://example.com/terms.json#part",
    "file:///home/terms.json?x=1",
    "terms.txt",
    "\\\\server\\"
  ])
    assert.throws(() => termSource(input), Error, input)
})

test("JSON stays strict while JSONC accepts comments and trailing commas; compiled rules keep full-body and literal semantics", () => {
  const source = "file:///terms.jsonc"
  const rules = parsePreserveTerms(parseTermFile('\uFEFF[\n// Shared names\n"Widget", "Widget", {"pattern":"(HTTP|HTTPS)", "flags":"i"},\n]', source))
  const preserved = (text: string) => isPreservedTerm({ id: "term", text, start: 0, end: text.length, format: "text" }, rules)
  for (const text of ["Widget", "widget", "WIDGET", "wIdGeT", "HtTp", "HTTPS", "HTTP"]) {
    assert.equal(preserved(text), true)
  }
  for (const text of ["Use Widget.", "HTTP HTTPS", "Widget!", "Wid get"]) assert.equal(preserved(text), false)
  assert.equal(rules.literals.size, 1)
  assert.equal(parsePreserveTerms(["Widget", { pattern: "HTTP", flags: "i" }]).identity, parsePreserveTerms([{ pattern: "HTTP", flags: "i" }, "widget", "WIDGET"]).identity)
  const caseSensitive = parsePreserveTerms([{ pattern: "Widget" }])
  assert.equal(isPreservedTerm({ id: "regex", text: "widget", start: 0, end: 6, format: "text" }, caseSensitive), false)
  for (const text of ['["Widget",]', '[/* comment */ "Widget"]']) {
    assert.throws(() => parseTermFile(text, "file:///terms.json"))
    assert.deepEqual(parseTermFile(text, source), ["Widget"])
  }
  for (const text of ["[] trailing", "[", '{"terms":[]}', "", "[1,,2]"]) assert.throws(() => parseTermFile(text, source))
})

test("adding a literal preserves JSONC comments and regex rules, escapes content and avoids duplicate writes", () => {
  const term = ' Widget "quoted" \\ path\n第二行 '
  for (const [source, text] of [
    ["file:///terms.json", "[]"],
    ["file:///terms.json", '\uFEFF["existing", {"pattern":"HTTP", "flags":"i"}]\r\n'],
    ["file:///terms.jsonc", '\uFEFF[\r\n// Shared names\r\n"existing", /* keep */ {"pattern":"HTTP", "flags":"i"},\r\n]\r\n// end'],
    ["file:///terms.jsonc", "[/* empty list */]"]
  ]) {
    const result = appendPreserveTerm(text, source, term)
    assert.deepEqual(parseTermFile(result, source), [...parseTermFile(text, source), term])
    assert.equal(appendPreserveTerm(result, source, term), result)
    for (const comment of text.match(/\/\/[^\r\n]*|\/\*.*?\*\//gu) ?? []) assert.ok(result.includes(comment))
    assert.equal(result.startsWith("\uFEFF"), text.startsWith("\uFEFF"))
  }
  assert.equal(appendPreserveTerm('["Widget"]', "file:///terms.json", "widget"), '["Widget"]')
  assert.deepEqual(parseTermFile(appendPreserveTerm('["Widget"]', "file:///terms.json", "Widget!"), "file:///terms.json"), ["Widget", "Widget!"])
})

test("adding a literal refuses malformed files and invalid existing rules instead of replacing their contents", () => {
  for (const text of ["", "[", '["name",]', "[/* comment */]", "{}", "[1]", '[{"pattern":"["}]']) assert.throws(() => appendPreserveTerm(text, "file:///terms.json", "Widget"))
  for (const term of ["", " \n "]) assert.throws(() => appendPreserveTerm("[]", "file:///terms.jsonc", term))
})
