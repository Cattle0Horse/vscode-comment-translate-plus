import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { loadCorpus, verifySuite } from "../tools/verify.mjs"

const corpus = await loadCorpus()
const reference = JSON.parse(await readFile(new URL("../fixtures/results.reference.json", import.meta.url), "utf8"))

test("accepts a complete reference replay independently of result ordering", () => {
  const suite = structuredClone(reference)
  suite.cases.reverse()
  for (const item of suite.cases) item.units.reverse()
  assert.equal(verifySuite(corpus, suite).cases, corpus.length)
})

const failures = [
  ["missing case", (suite) => suite.cases.pop()],
  [
    "unknown case replacing a known case",
    (suite) => {
      suite.cases[0].id = "unknown"
    }
  ],
  [
    "duplicate case",
    (suite) => {
      suite.cases[1] = structuredClone(suite.cases[0])
    }
  ],
  ["missing list item", (suite) => suite.cases[0].units.pop()],
  [
    "duplicate list item",
    (suite) => {
      suite.cases[0].units[1] = structuredClone(suite.cases[0].units[0])
    }
  ],
  [
    "translations assigned to the wrong items",
    (suite) => {
      const [first, second] = suite.cases[0].units
      ;[first.translation, second.translation] = [second.translation, first.translation]
    }
  ],
  [
    "wrong source position",
    (suite) => {
      suite.cases[0].units[0].range.start++
    }
  ],
  [
    "truncated translation",
    (suite) => {
      suite.cases[0].units[1].translation = "2. 截断"
    }
  ],
  [
    "modified link destination",
    (suite) => {
      const unit = suite.cases.find((item) => item.id === "frontmatter-skill").units.at(-1)
      unit.translation = unit.translation.replace("https://example.com/guide", "https://example.com/other")
    }
  ],
  [
    "browse mode writes to the source",
    (suite) => {
      suite.cases[0].sourceAfter += "\n译文"
    }
  ],
  [
    "old document version",
    (suite) => {
      suite.cases[0].snapshot.version++
    }
  ],
  [
    "different source content at the same version",
    (suite) => {
      suite.cases[0].snapshot.sourceHash = "wrong"
    }
  ],
  [
    "old provider context",
    (suite) => {
      suite.cases[0].snapshot.providerId = "other"
    }
  ],
  [
    "another document with identical content",
    (suite) => {
      suite.cases[0].snapshot.documentId = "other.md"
    }
  ],
  [
    "old resource language",
    (suite) => {
      suite.cases[0].snapshot.languageId = "skill"
    }
  ],
  [
    "old source language",
    (suite) => {
      suite.cases[0].snapshot.sourceLanguage = "auto"
    }
  ],
  [
    "old target language",
    (suite) => {
      suite.cases[0].snapshot.targetLanguage = "ja"
    }
  ],
  [
    "collapsed list treated as success",
    (suite) => {
      suite.cases[1].status = "translated"
    }
  ],
  [
    "rejected result still displays a translation",
    (suite) => {
      suite.cases[1].units.push(suite.cases[0].units[0])
    }
  ],
  [
    "stale response still displays a translation",
    (suite) => {
      suite.cases.at(-1).units.push(suite.cases[0].units[0])
    }
  ]
]

for (const [name, mutate] of failures) {
  test(`rejects ${name}`, () => {
    const suite = structuredClone(reference)
    mutate(suite)
    assert.throws(() => verifySuite(corpus, suite))
  })
}

test("CRLF and surrogate pairs are measured in raw UTF-16 source offsets", () => {
  const item = corpus.find((entry) => entry.id === "unicode-crlf")
  assert.ok(item.source.includes("\r\n") && item.source.includes("😀"))
  const task = item.expect.units.find((unit) => unit.id === "task")
  const suite = structuredClone(reference)
  const result = suite.cases.find((entry) => entry.id === item.id).units.find((unit) => unit.id === task.id)
  // A parser that normalizes newlines before calculating positions produces this defect.
  result.range.start = item.source.replaceAll("\r\n", "\n").indexOf(task.source)
  assert.throws(() => verifySuite(corpus, suite), /wrong source range/)
  result.range.start = Array.from(item.source.slice(0, task.range.start)).length
  assert.throws(() => verifySuite(corpus, suite), /wrong source range/)
})

test("verify CLI fails when no product or reference results are supplied", () => {
  const result = spawnSync(process.execPath, ["tools/verify.mjs"], { cwd: new URL("../", import.meta.url), encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--results/)
})
