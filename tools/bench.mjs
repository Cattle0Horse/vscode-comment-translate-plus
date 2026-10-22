import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { arch, cpus, platform, release } from "node:os"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  }
}

export async function measure(target, { samples = 30, warmup = 5 } = {}) {
  assert.ok(target && typeof target.id === "string" && target.id, "missing benchmark target ID")
  assert.ok(["tooling", "product"].includes(target.kind), "target kind must be tooling or product")
  assert.ok(typeof target.fingerprint === "string" && target.fingerprint, "missing workload fingerprint")
  assert.ok(Array.isArray(target.scenarios) && target.scenarios.length > 0, "empty benchmark target")
  assert.ok(Number.isInteger(samples) && samples >= 5, "samples must be an integer >= 5")
  assert.ok(Number.isInteger(warmup) && warmup >= 0, "warmup must be a nonnegative integer")
  const scenarios = []
  const ids = new Set()
  for (const scenario of target.scenarios) {
    assert.ok(typeof scenario.id === "string" && scenario.id && !ids.has(scenario.id), "duplicate or invalid scenario ID")
    assert.equal(typeof scenario.run, "function", "scenario must provide run()")
    ids.add(scenario.id)
    for (let index = 0; index < warmup; index++) await scenario.run()
    const memoryBefore = process.memoryUsage()
    const cpuBefore = process.cpuUsage()
    const durations = []
    for (let index = 0; index < samples; index++) {
      const start = performance.now()
      await scenario.run()
      durations.push(performance.now() - start)
    }
    const cpu = process.cpuUsage(cpuBefore)
    const memoryAfter = process.memoryUsage()
    scenarios.push({ id: scenario.id, samplesMs: durations, statsMs: summarize(durations), cpuMicroseconds: cpu, memoryBytes: { before: memoryBefore, after: memoryAfter } })
  }
  const cpu = cpus()
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" })
  const revision = git(["rev-parse", "--verify", "HEAD"])
  const changes = git(["status", "--porcelain"])
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    target: { id: target.id, kind: target.kind, fingerprint: target.fingerprint },
    environment: {
      node: process.version,
      execArgv: process.execArgv,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      cpuModel: cpu[0]?.model ?? "unknown",
      logicalCpus: cpu.length
    },
    git: { revision: revision.status === 0 ? revision.stdout.trim() : null, dirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null },
    config: { samples, warmup },
    scenarios
  }
  validateReport(report)
  return report
}

function validateReport(report) {
  assert.equal(report.schemaVersion, 1, "unsupported benchmark schema")
  assert.ok(report.target?.id && report.target.fingerprint, "invalid benchmark target")
  assert.ok(["tooling", "product"].includes(report.target.kind), "invalid benchmark target kind")
  assert.ok(report.environment?.node && report.environment.cpuModel, "missing benchmark environment")
  assert.ok(Number.isInteger(report.config?.samples) && report.config.samples >= 5, "invalid sample count")
  assert.ok(Number.isInteger(report.config.warmup) && report.config.warmup >= 0, "invalid warmup count")
  assert.ok(Array.isArray(report.scenarios) && report.scenarios.length > 0, "missing benchmark scenarios")
  const ids = new Set()
  for (const scenario of report.scenarios) {
    assert.ok(scenario.id && !ids.has(scenario.id), "duplicate benchmark scenario")
    ids.add(scenario.id)
    assert.equal(scenario.samplesMs?.length, report.config.samples, "benchmark sample count mismatch")
    assert.ok(
      scenario.samplesMs.every((value) => Number.isFinite(value) && value > 0),
      "benchmark samples must be positive finite numbers"
    )
    assert.deepEqual(scenario.statsMs, summarize(scenario.samplesMs), "benchmark statistics do not match samples")
  }
}

export function compareReports(current, baseline, maxRegression = 0.2) {
  assert.ok(Number.isFinite(maxRegression) && maxRegression >= 0, "max regression must be finite and nonnegative")
  validateReport(current)
  validateReport(baseline)
  for (const key of ["target", "environment", "config"]) {
    assert.deepEqual(current[key], baseline[key], `incomparable benchmark ${key}`)
  }
  assert.deepEqual(current.scenarios.map((item) => item.id).sort(), baseline.scenarios.map((item) => item.id).sort(), "incomparable benchmark scenarios")
  const previous = new Map(baseline.scenarios.map((item) => [item.id, item]))
  const comparisons = current.scenarios.map((item) => {
    const before = previous.get(item.id)
    return { id: item.id, medianChange: item.statsMs.median / before.statsMs.median - 1, p95Change: item.statsMs.p95 / before.statsMs.p95 - 1 }
  })
  return { maxRegression, passed: comparisons.every((item) => item.medianChange <= maxRegression && item.p95Change <= maxRegression), comparisons }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = new Map()
    const allowed = new Set(["--target", "--output", "--baseline", "--samples", "--warmup", "--max-regression"])
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(allowed.has(args[index]) && args[index + 1] && !options.has(args[index]), "invalid benchmark options; see docs/verification.md")
      options.set(args[index], args[index + 1])
    }
    assert.ok(options.has("--baseline") || !options.has("--max-regression"), "--max-regression requires --baseline")
    const targetUrl = options.has("--target") ? pathToFileURL(resolve(options.get("--target"))) : new URL("./bench-target.mjs", import.meta.url)
    const { default: target } = await import(targetUrl.href)
    const report = await measure(target, { samples: Number(options.get("--samples") ?? 30), warmup: Number(options.get("--warmup") ?? 5) })
    if (options.has("--baseline")) {
      const baseline = JSON.parse(await readFile(resolve(options.get("--baseline")), "utf8"))
      report.comparison = compareReports(report, baseline, Number(options.get("--max-regression") ?? 0.2))
    }
    const output = resolve(options.get("--output") ?? "artifacts/benchmark.json")
    if (options.has("--baseline")) assert.notEqual(output, resolve(options.get("--baseline")), "output must not overwrite baseline")
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 4) + "\n")
    console.log(JSON.stringify({ target: report.target, output, scenarios: report.scenarios.map(({ id, statsMs }) => ({ id, statsMs })), comparison: report.comparison }))
    if (target.kind === "tooling") console.log("Tooling benchmark only; this is not a product performance baseline.")
    if (report.comparison && !report.comparison.passed) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
