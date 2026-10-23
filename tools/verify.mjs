import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const hashText = (text) => createHash("sha256").update(text).digest("hex")

export async function loadCorpus(path = resolve(root, "fixtures/cases.json")) {
  const manifest = JSON.parse(await readFile(path, "utf8"))
  assert.equal(manifest.schemaVersion, 1, "unsupported corpus schema")
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0, "empty corpus")
  const ids = new Set()
  const cases = []
  for (const item of manifest.cases) {
    assert.ok(typeof item.id === "string" && item.id && !ids.has(item.id), "duplicate or invalid case ID")
    ids.add(item.id)
    const sourcePath = resolve(dirname(path), item.file)
    const localPath = relative(dirname(path), sourcePath)
    assert.ok(!isAbsolute(localPath) && localPath !== ".." && !localPath.startsWith(`..${sep}`), `${item.id}: source outside corpus`)
    const source = await readFile(sourcePath, "utf8")
    assert.ok(typeof item.languageId === "string" && item.languageId, `${item.id}: missing language ID`)
    assert.ok(Number.isInteger(item.snapshot.version) && item.snapshot.version > 0, `${item.id}: invalid document version`)
    for (const key of ["providerId", "sourceLanguage", "targetLanguage"]) {
      assert.ok(typeof item.snapshot[key] === "string" && item.snapshot[key], `${item.id}: missing ${key}`)
    }
    assert.ok(["translated", "rejected", "stale"].includes(item.expect.status), `${item.id}: invalid status`)
    assert.ok(Array.isArray(item.expect.units), `${item.id}: missing expected units`)
    assert.equal(item.expect.units.length > 0, item.expect.status === "translated", `${item.id}: invalid expected output`)
    const unitIds = new Set()
    let previousEnd = 0
    for (const unit of item.expect.units) {
      const { start, end } = unit.range
      assert.ok(unit.id && !unitIds.has(unit.id), `${item.id}: duplicate expected unit ID`)
      unitIds.add(unit.id)
      assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= previousEnd && end > start && end <= source.length, `${item.id}/${unit.id}: invalid range`)
      assert.equal(source.slice(start, end), unit.source, `${item.id}/${unit.id}: source range drift`)
      assert.ok(typeof unit.translation === "string" && unit.translation.trim(), `${item.id}/${unit.id}: empty expected translation`)
      previousEnd = end
    }
    cases.push({ ...item, source, snapshot: { ...item.snapshot, documentId: item.file, languageId: item.languageId, sourceHash: hashText(source) } })
  }
  return cases
}

// This validates an adapter's observations, not translation quality or editor layout.
export function verifySuite(corpus, suite) {
  assert.equal(suite.schemaVersion, 1, "unsupported result schema")
  assert.ok(["reference", "extension"].includes(suite.origin), "origin must be reference or extension")
  assert.ok(typeof suite.revision === "string" && suite.revision.trim(), "missing producer revision")
  assert.ok(Array.isArray(suite.cases), "missing result cases")
  assert.equal(suite.cases.length, corpus.length, "case count mismatch")
  const results = new Map()
  for (const result of suite.cases) {
    assert.ok(!results.has(result.id), `duplicate result case: ${result.id}`)
    results.set(result.id, result)
  }
  for (const item of corpus) {
    const result = results.get(item.id)
    assert.ok(result, `${item.id}: missing result`)
    assert.deepEqual(result.snapshot, item.snapshot, `${item.id}: snapshot/context mismatch`)
    assert.equal(result.sourceAfter, item.source, `${item.id}: browse translation changed source`)
    assert.equal(result.status, item.expect.status, `${item.id}: wrong result status`)
    assert.ok(Array.isArray(result.units), `${item.id}: missing result units`)
    assert.equal(result.units.length, item.expect.units.length, `${item.id}: unit count mismatch`)
    const units = new Map()
    for (const unit of result.units) {
      assert.ok(!units.has(unit.id), `${item.id}: duplicate result unit ${unit.id}`)
      units.set(unit.id, unit)
    }
    for (const expected of item.expect.units) {
      const unit = units.get(expected.id)
      assert.ok(unit, `${item.id}: missing unit ${expected.id}`)
      assert.deepEqual(unit.range, expected.range, `${item.id}/${expected.id}: wrong source range`)
      assert.equal(unit.translation, expected.translation, `${item.id}/${expected.id}: wrong replay translation`)
    }
  }
  return { origin: suite.origin, cases: corpus.length, units: corpus.reduce((count, item) => count + item.expect.units.length, 0) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    assert.ok(args.length === 2 && args[0] === "--results", "usage: node tools/verify.mjs --results <results.json>")
    const suite = JSON.parse(await readFile(resolve(args[1]), "utf8"))
    const summary = verifySuite(await loadCorpus(), suite)
    console.log(JSON.stringify(summary))
    console.log(
      summary.origin === "reference"
        ? "Reference replay passed; no extension, editor layout, or live service was tested."
        : "Adapter results passed; editor layout and translation quality require separate evidence."
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
