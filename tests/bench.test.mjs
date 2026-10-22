import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { compareReports, measure } from "../tools/bench.mjs"

function report(value) {
  return {
    schemaVersion: 1,
    target: { id: "test-only", kind: "tooling", fingerprint: "fixed-workload" },
    environment: { node: "test-node", cpuModel: "test-cpu" },
    config: { samples: 5, warmup: 1 },
    scenarios: [{ id: "work", samplesMs: Array(5).fill(value), statsMs: { min: value, median: value, p95: value, max: value } }]
  }
}

test("compares both median and p95 using a declared regression allowance", () => {
  assert.equal(compareReports(report(11), report(10), 0.2).passed, true)
  assert.equal(compareReports(report(13), report(10), 0.2).passed, false)
  const tail = report(10)
  tail.scenarios[0].samplesMs[4] = 20
  tail.scenarios[0].statsMs = { min: 10, median: 10, p95: 20, max: 20 }
  assert.equal(compareReports(tail, report(10), 0.2).passed, false)
})

for (const key of ["target", "environment", "config"]) {
  test(`refuses a comparison with different ${key}`, () => {
    const current = report(10)
    if (key === "target") current.target.fingerprint = "changed-inputs"
    if (key === "environment") current.environment.node = "different-node"
    if (key === "config") current.config.warmup = 2
    assert.throws(() => compareReports(current, report(10)), /incomparable/)
  })
}

for (const value of [0, -1, null, NaN, Infinity]) {
  test(`refuses invalid timing evidence: ${value}`, () => {
    assert.throws(() => compareReports(report(value), report(10)))
  })
}

test("does not trust summary numbers without their matching raw samples", () => {
  const baseline = report(10)
  baseline.scenarios[0].statsMs.median = 100
  assert.throws(() => compareReports(report(10), baseline), /statistics/)
})

test("measures completed work and separates warmup from recorded samples", async () => {
  let calls = 0
  const target = {
    id: "tooling-test",
    kind: "tooling",
    fingerprint: "counter",
    scenarios: [
      {
        id: "work",
        run() {
          calls++
        }
      }
    ]
  }
  const result = await measure(target, { warmup: 2, samples: 5 })
  assert.equal(calls, 7)
  assert.equal(result.scenarios[0].samplesMs.length, 5)
  assert.equal(compareReports(result, result).passed, true)
  assert.ok(result.scenarios[0].memoryBytes.before.heapUsed > 0)
})

test("measurement failure propagates instead of producing a passing report", async () => {
  const target = {
    id: "broken",
    kind: "tooling",
    fingerprint: "broken",
    scenarios: [
      {
        id: "work",
        run() {
          throw Error("workload failed")
        }
      }
    ]
  }
  await assert.rejects(measure(target), /workload failed/)
  await assert.rejects(measure({ ...target, scenarios: [] }), /empty/)
})

test("CLI saves measurement evidence and exits nonzero for a detected regression", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "comment-translate-bench-"))
  const baselinePath = join(directory, "baseline.json")
  const currentPath = join(directory, "current.json")
  t.after(async () => {
    await rm(baselinePath, { force: true })
    await rm(currentPath, { force: true })
    await rmdir(directory)
  })
  const run = (args) =>
    spawnSync(process.execPath, ["tools/bench.mjs", ...args], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8"
    })
  const first = run(["--output", baselinePath])
  assert.equal(first.status, 0, first.stderr)
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"))
  // Deliberately artificial baseline: exercise exit behavior without a flaky speed assertion.
  for (const scenario of baseline.scenarios) {
    scenario.samplesMs.fill(1e-9)
    scenario.statsMs = { min: 1e-9, median: 1e-9, p95: 1e-9, max: 1e-9 }
  }
  await writeFile(baselinePath, JSON.stringify(baseline))
  const regressed = run(["--baseline", baselinePath, "--output", currentPath])
  assert.equal(regressed.status, 1, regressed.stderr)
  assert.equal(JSON.parse(await readFile(currentPath, "utf8")).comparison.passed, false)
  const original = await readFile(baselinePath, "utf8")
  const overwrite = run(["--baseline", baselinePath, "--output", baselinePath])
  assert.equal(overwrite.status, 1)
  assert.match(overwrite.stderr, /overwrite baseline/)
  assert.equal(await readFile(baselinePath, "utf8"), original)
})
