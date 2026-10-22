import assert from "node:assert/strict"
import { test } from "node:test"
import { RequestGate } from "../src/translation/requestGate.ts"

test("disposing the shared HTTP gate releases queued consumers and prevents later requests", async () => {
  const gate = new RequestGate(1, 1)
  const signal = new AbortController().signal
  await gate.run(async () => {}, signal)
  const queued = gate.run(async () => {
    assert.fail("A request started after the HTTP gate was disposed.")
  }, signal)
  const cancelled = assert.rejects(queued, (reason: unknown) => reason === "extension-disposed")
  gate.dispose()
  await cancelled
  await assert.rejects(
    gate.run(async () => {}, signal),
    (reason: unknown) => reason === "extension-disposed"
  )
})
