import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { localServiceProfile } from "../tools/local-service.mjs"

test("discovers the unique local model and separates credentials from serializable settings", async (t) => {
  let models = [{ id: "current-local-model" }]
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    assert.equal(request.url, "/v1/models")
    assert.equal(request.headers.authorization, "Bearer synthetic-only")
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ data: models }))
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const profile = await localServiceProfile({ profileId: "integration-local", apiUrl, apiKey: "synthetic-only" })
  assert.equal(profile.settings.profiles[0].id, "integration-local")
  assert.equal(profile.settings.activeProfile, "integration-local")
  assert.equal(profile.settings.profiles[0].model, "current-local-model")
  assert.equal(profile.settings.profiles[0].apiUrl, apiUrl)
  assert.equal(profile.apiKey, "synthetic-only")
  assert.ok(!JSON.stringify(profile.settings).includes("synthetic-only"))
  models = [{ id: "first" }, { id: "second" }]
  await assert.rejects(localServiceProfile({ profileId: "integration-local", apiUrl, apiKey: "synthetic-only" }), /exactly one model/)
  const before = requests
  const selected = await localServiceProfile({ profileId: "other-local", apiUrl, model: "explicit-model", apiKey: "synthetic-only" })
  assert.equal(selected.settings.activeProfile, selected.settings.profiles[0].id)
  assert.equal(selected.settings.activeProfile, "other-local")
  assert.equal(selected.settings.profiles[0].model, "explicit-model")
  assert.equal(requests, before)
})

test("local test profiles derive an optional identifier and reject missing or unsafe addresses before requests", async () => {
  const endpoint = "http://127.0.0.1:0/v1/chat/completions"
  for (const profileId of [undefined, "", "  "]) {
    const profile = await localServiceProfile({ profileId, apiUrl: endpoint, model: "configured-model" })
    assert.equal(profile.settings.profiles[0].id, endpoint)
    assert.equal(profile.settings.activeProfile, endpoint)
  }
  for (const apiUrl of [undefined, "", "  "]) {
    await assert.rejects(localServiceProfile({ profileId: "integration-local", apiUrl }), /COMMENT_TRANSLATE_TEST_API_URL/)
  }
  const anonymous = await localServiceProfile({ profileId: "anonymous", apiUrl: "http://127.0.0.1:12345/v1/chat/completions", model: "configured-model" })
  assert.equal(anonymous.apiKey, "")
  assert.equal(anonymous.settings.profiles[0].name, "anonymous")
  for (const apiUrl of ["https://example.com/v1/chat/completions", "http://key@127.0.0.1:9999/v1/chat/completions", "http://127.0.0.1:9999/v1/chat/completions?key=value"]) {
    await assert.rejects(localServiceProfile({ profileId: "integration-local", apiUrl, model: "explicit" }), /loopback/)
  }
})

test("local startup reads dotenv without a profile identifier and preserves explicit environment overrides", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "comment-translate-env-"))
  t.after(async () => {
    await rm(join(folder, ".env"), { force: true })
    await rmdir(folder)
  })
  const endpoint = "http://127.0.0.1:0/v1/chat/completions"
  await writeFile(folder + "/.env", "COMMENT_TRANSLATE_TEST_API_URL=" + endpoint + "\nCOMMENT_TRANSLATE_TEST_MODEL=file-model\nCOMMENT_TRANSLATE_TEST_API_KEY=synthetic-key\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("COMMENT_TRANSLATE_TEST_")))
  const moduleUrl = new URL("../tools/local-service.mjs", import.meta.url).href
  const script = "import {localServiceFromEnvironment} from " + JSON.stringify(moduleUrl) + "; console.log(JSON.stringify(await localServiceFromEnvironment()))"
  const run = (overrides = {}) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: folder, env: { ...env, ...overrides }, encoding: "utf8" }))
  const file = run()
  assert.equal(file.settings.activeProfile, endpoint)
  assert.equal(file.settings.profiles[0].model, "file-model")
  assert.equal(file.apiKey, "synthetic-key")
  assert.ok(!JSON.stringify(file.settings).includes("synthetic-key"))
  const override = run({ COMMENT_TRANSLATE_TEST_MODEL: "environment-model", COMMENT_TRANSLATE_TEST_API_KEY: "" })
  assert.equal(override.settings.profiles[0].model, "environment-model")
  assert.equal(override.apiKey, "")
})
