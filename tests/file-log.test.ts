import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileLog } from "../src/host/fileLog.ts"

test("JSONL appends preserve existing evidence, order, redaction and routing across path changes and shutdown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctp-log-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = join(directory, "first.jsonl")
  const second = join(directory, "nested", "second.jsonl")
  await writeFile(first, '{"kind":"previous-session"}\n')
  const log = new FileLog(() => assert.fail("Unexpected file failure"))
  const secret = 'synthetic-"key\\value'
  log.configure(first)
  log.record({ kind: "request", text: "line one\nline two", nested: [secret, JSON.stringify(secret).slice(1, -1)] }, [secret])
  log.configure(second)
  log.record({ kind: "finish", status: "complete" })
  log.configure(undefined)
  log.record({ kind: "disabled" })
  await log.close()
  log.record({ kind: "after-close" })
  const firstRecords = (await readFile(first, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const secondRecords = (await readFile(second, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    firstRecords.map((event) => event.kind),
    ["previous-session", "log-start", "request"]
  )
  assert.deepEqual(firstRecords[2].nested, ["[REDACTED]", "[REDACTED]"])
  assert.equal(firstRecords[2].text, "line one\nline two")
  assert.deepEqual(
    secondRecords.map((event) => event.kind),
    ["log-start", "finish"]
  )
  assert.equal(firstRecords[2].sessionId, secondRecords[1].sessionId)
})

test("a failed destination reports once, stops collecting and permits a new destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctp-log-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const blocked = join(directory, "blocked")
  await writeFile(blocked, "not a directory")
  let failures = 0
  let failed!: () => void
  const failure = new Promise<void>((resolve) => {
    failed = resolve
  })
  const log = new FileLog(() => {
    failures++
    failed()
  })
  log.configure(join(blocked, "events.jsonl"))
  log.record({ kind: "request" })
  await failure
  assert.equal(failures, 1)
  assert.equal(log.enabled, false)
  const recovered = join(directory, "recovered.jsonl")
  log.configure(recovered)
  log.record({ kind: "finish", status: "complete" })
  await log.close()
  const records = (await readFile(recovered, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(records.at(-1).status, "complete")
  assert.equal(failures, 1)
})
