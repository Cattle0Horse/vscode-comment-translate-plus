import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { RequestGate } from "../src/translation/requestGate.ts"
import { requestScope, retryAfterDelay, retryDelay } from "../src/translation/transport.ts"
import { emptyPreserveTerms } from "../src/documents/terms.ts"
import { readRequestPolicy, type ServiceSettings } from "../src/translation/settings.ts"
import { chatFixture, limits, listBatch, requestTranslation, waitFor } from "./support/fixtures.ts"

function settings(overrides: Partial<ServiceSettings> = {}): ServiceSettings {
  return {
    ...limits,
    provider: "openai",
    apiUrl: "http://fixture.invalid/v1",
    apiKey: "",
    model: "fixture",
    systemPrompt: "",
    userPrompt: "${content}",
    languageNames: {},
    preserveTerms: emptyPreserveTerms,
    sourceLanguage: "en",
    targetLanguage: "zh",
    skipSameLanguage: false,
    recoverySuccesses: 1,
    recoveryIntervalMs: 0,
    ...overrides
  }
}

function workload(t: TestContext, policy: ServiceSettings, maximum = 8, rate = 100) {
  const gate = new RequestGate(rate, maximum)
  const scope = requestScope(policy)
  gate.configureScope(scope, policy)
  const controller = new AbortController()
  const started: { version: object | undefined; finish(healthy?: boolean): void }[] = []
  const pending: Promise<void>[] = []
  t.after(async () => {
    controller.abort("user-cancelled")
    for (const item of started) item.finish(false)
    gate.dispose()
    await Promise.allSettled(pending)
  })
  return {
    gate,
    scope,
    started,
    enqueue(count: number) {
      for (let i = 0; i < count; i++) {
        const work = gate.run(
          () =>
            new Promise<void>((resolve) => {
              const version = gate.version(scope)
              let finished = false
              started.push({
                version,
                finish(healthy = true) {
                  if (finished) return
                  finished = true
                  if (healthy) gate.succeeded(scope, version)
                  resolve()
                }
              })
            }),
          controller.signal,
          undefined,
          scope
        )
        pending.push(work)
        void work.catch(() => {})
      }
    }
  }
}

test("partial grouped scheduling overrides take effect while omitted fields keep defaults; malformed groups and values fail before dispatch", async (t) => {
  const overrides: Record<string, unknown> = {
    "requestScheduling.slowStart": { initialConcurrency: 2 },
    "requestScheduling.retry": { initialDelayMs: 250, jitterRatio: 0 }
  }
  const policy = readRequestPolicy((key, fallback) => overrides[key] ?? fallback)
  const configured = settings(policy)
  const w = workload(t, configured)
  w.enqueue(5)
  assert.equal(w.started.length, 2)
  assert.equal(retryDelay(configured, 1), 250)
  for (const invalid of [null, [], false, { initialDelayMs: -1 }, { jitterRatio: 2 }]) {
    assert.throws(() => readRequestPolicy((key, fallback) => (key === "requestScheduling.retry" ? invalid : fallback)))
  }
  assert.throws(() => readRequestPolicy((key, fallback) => (key === "requestScheduling.slowStart" ? { enabled: "yes" } : fallback)))
})

test("Retry-After accepts seconds and HTTP dates, rejects invalid delays, and jitter stays within the configured backoff cap", () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(retryAfterDelay(" 12 ", now), 12000)
  assert.equal(retryAfterDelay("Thu, 01 Jan 2026 00:00:05 GMT", now), 5000)
  assert.equal(retryAfterDelay("Wed, 31 Dec 2025 23:59:00 GMT", now), 0)
  for (const value of [null, "", "-1", "1.5", "Infinity", "99999999999999999999", "invalid"]) assert.equal(retryAfterDelay(value, now), undefined)
  const policy = settings({ retryBackoffInitialMs: 100, retryBackoffMaxMs: 500, retryBackoffMultiplier: 2, retryJitterRatio: 0.2 })
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => retryDelay(policy, n, 0.5)),
    [100, 200, 400, 500]
  )
  assert.equal(retryDelay(policy, 1, 0), 80)
  assert.equal(retryDelay(policy, 1, 1), 120)
  assert.equal(retryDelay(policy, 1000, 1), 500)
  assert.equal(retryDelay({ ...policy, retryBackoffInitialMs: 0 }, 1000, 1), 0)
})

test("loaded startup grows exponentially; the first failure switches subsequent probes to additive growth", async (t) => {
  const policy = settings({ slowStart: true })
  const w = workload(t, policy)
  w.enqueue(20)
  assert.equal(w.started.length, 1)
  w.started[0].finish()
  await waitFor(() => w.started.length === 3)
  w.started.slice(1, 3).forEach((item) => item.finish())
  await waitFor(() => w.started.length === 7)
  // Four in flight: one pressure event halves the allowance to two.
  const cohort = w.started.slice(3, 7)
  for (const item of cohort) w.gate.failed(w.scope, policy, 1, 0, true, item.version)
  cohort.slice(0, 2).forEach((item) => item.finish())
  await delay(1)
  assert.equal(w.started.length, 7, "Reducing concurrency cancelled or replaced requests while the old allowance was still in flight.")
  cohort.forEach((item) => item.finish())
  await waitFor(() => w.started.length >= 9)
  assert.equal(w.started.length, 9, "Same-cohort failures repeatedly reduced concurrency or stale successes reopened it.")
  w.started[7].finish()
  await waitFor(() => w.started.length >= 11)
  assert.equal(w.started.length, 11, "Post-failure growth multiplied two to four instead of probing at three.")
})

test("idle serial successes and starts limited by the rate window do not grow startup concurrency", async (t) => {
  const policy = settings({ slowStart: true })
  const idle = workload(t, policy)
  for (let i = 0; i < 4; i++) {
    idle.enqueue(1)
    await waitFor(() => idle.started.length === i + 1)
    idle.started[i].finish()
    await delay(1)
  }
  idle.enqueue(3)
  await waitFor(() => idle.started.length === 5)
  assert.equal(idle.started.length, 5)
  const rateLimited = workload(t, policy, 8, 1)
  rateLimited.enqueue(3)
  rateLimited.started[0].finish()
  // Raising the RPS cap exposes the unchanged concurrency limit without waiting a full window.
  rateLimited.gate.configure(100, 8)
  await waitFor(() => rateLimited.started.length === 2)
  assert.equal(rateLimited.started.length, 2)
})

test("late failures from a previously reduced cohort cannot reduce a newer recovery twice", async (t) => {
  const policy = settings({ slowStart: false })
  const w = workload(t, policy)
  w.enqueue(20)
  const original = w.started.slice()
  w.gate.failed(w.scope, policy, 1, 0, true, original[0].version)
  original.slice(0, 5).forEach((item) => item.finish(false))
  await waitFor(() => w.started.length === 9)
  w.gate.failed(w.scope, policy, 1, 0, true, w.started[8].version)
  w.gate.failed(w.scope, policy, 1, 0, true, original[7].version)
  w.started.slice(5, 9).forEach((item) => item.finish())
  await waitFor(() => w.started.length >= 11)
  assert.equal(w.started.length, 11)
})

test("a configured recovery floor never raises concurrency on a failing request", async (t) => {
  const policy = settings({ slowStart: true, recoveryMinConcurrency: 8 })
  const w = workload(t, policy)
  w.gate.failed(w.scope, policy, 1, 0, true)
  w.enqueue(4)
  assert.equal(w.started.length, 1)
})

test("isolated network failures back off; the configured failure window and threshold control concurrency reduction", async (t) => {
  const policy = settings({ slowStart: false, networkFailureThreshold: 2, networkFailureWindowMs: 20 })
  const w = workload(t, policy, 4)
  w.gate.failed(w.scope, policy, 1)
  await delay(30)
  w.gate.failed(w.scope, policy, 1)
  w.enqueue(10)
  assert.equal(w.started.length, 4, "An expired network fault or a single fault reduced concurrency.")
  w.gate.failed(w.scope, policy, 1, 0, false, w.started[0].version)
  w.started.slice(0, 3).forEach((item) => item.finish(false))
  await waitFor(() => w.started.length >= 5)
  assert.equal(w.started.length, 5, "Repeated faults did not halve four to two.")
})

test("shared cooling blocks planning and HTTP for its service, while other credentials remain eligible; waiting cancels without dispatch", async (t) => {
  const policy = settings({ retryBackoffInitialMs: 10, retryBackoffMaxMs: 10 })
  const w = workload(t, policy, 4)
  const until = w.gate.failed(w.scope, policy, 1, 80, true)
  const controller = new AbortController()
  let planned = false
  const planning = w.gate.plan(
    () => {
      planned = true
    },
    controller.signal,
    () => 0,
    w.scope
  )
  let sent = false
  const waiting = w.gate.run(
    async () => {
      sent = true
    },
    controller.signal,
    () => 0,
    w.scope
  )
  const other = requestScope({ ...policy, apiKey: "fictional-other-credential" })
  await w.gate.run(
    async () => {},
    new AbortController().signal,
    () => 2,
    other
  )
  assert.equal(planned, false)
  assert.equal(sent, false)
  controller.abort("user-cancelled")
  await Promise.all([assert.rejects(planning), assert.rejects(waiting)])
  await w.gate.run(
    async () => {
      assert.ok(performance.now() >= until)
    },
    new AbortController().signal,
    undefined,
    w.scope
  )
  assert.equal(sent, false)
})

test("recovery spaces sends; disabling shared cooling delays only the failed request", async (t) => {
  const policy = settings({ slowStart: false, recoveryIntervalMs: 40, recoverySuccesses: 100 })
  const w = workload(t, policy, 4)
  w.gate.failed(w.scope, policy, 1, 0, true)
  const starts: number[] = []
  await Promise.all(
    Array.from({ length: 3 }, () =>
      w.gate.run(
        async () => {
          starts.push(performance.now())
        },
        new AbortController().signal,
        undefined,
        w.scope
      )
    )
  )
  assert.ok(starts[1] - starts[0] >= 40 && starts[2] - starts[1] >= 40)
  const localPolicy = settings({ sharedRequestCooldown: false, requestRecovery: false, retryBackoffInitialMs: 80, retryBackoffMaxMs: 80, retryJitterRatio: 0 })
  const local = workload(t, localPolicy)
  const until = local.gate.failed(local.scope, localPolicy, 1)
  let retried = false
  const retry = local.gate.run(
    async () => {
      retried = true
      assert.ok(performance.now() >= until)
    },
    new AbortController().signal,
    undefined,
    local.scope,
    until
  )
  await local.gate.run(
    async () => {
      assert.equal(retried, false)
    },
    new AbortController().signal,
    undefined,
    local.scope
  )
  await retry
})

test("HTTP 429/503 recover through the item attempt budget without model instructions, and terminal or disabled status retries fail once", async (t) => {
  for (const status of [429, 503, 401]) {
    const fixture = await chatFixture(t, (_body, items, call) => (call === 1 ? { status } : items.join("\n%%\n")))
    const result = requestTranslation(fixture.service, fixture.settings, listBatch(2), new AbortController().signal, fixture.gate)
    if (status === 401) {
      await assert.rejects(result, /service-http-401/)
      assert.equal(fixture.seen.length, 1)
    } else {
      assert.equal((await result).length, 2)
      assert.equal(fixture.seen.length, 2)
      assert.deepEqual(fixture.seen[0].body, fixture.seen[1].body)
    }
  }
  const disabled = await chatFixture(t, () => ({ status: 429 }))
  await assert.rejects(requestTranslation(disabled.service, { ...disabled.settings, retryHttp429: false }, listBatch(1), new AbortController().signal, disabled.gate), /service-http-429/)
  assert.equal(disabled.seen.length, 1)
  const exhausted = await chatFixture(t, () => ({ status: 503 }))
  await assert.rejects(
    requestTranslation(exhausted.service, { ...exhausted.settings, maxTranslationAttempts: 2 }, listBatch(1), new AbortController().signal, exhausted.gate),
    /service-http-503/
  )
  assert.equal(exhausted.seen.length, 2)
})

test("a real Retry-After response overrides the local backoff cap; long waits remain cancellable and can be opted out", async (t) => {
  const starts: number[] = []
  const fixture = await chatFixture(t, (_body, items, call) => {
    starts.push(performance.now())
    return call === 1 ? { status: 429, headers: { "Retry-After": "1" } } : items.join("\n%%\n")
  })
  const policy = { ...fixture.settings, retryBackoffMaxMs: 0 }
  assert.equal((await requestTranslation(fixture.service, policy, listBatch(1), new AbortController().signal, fixture.gate)).length, 1)
  assert.ok(starts[1] - starts[0] >= 1000)
  const controller = new AbortController()
  const long = await chatFixture(t, () => ({ status: 503, headers: { "Retry-After": "3600" } }))
  let cooling = false
  const cancelled = requestTranslation(long.service, long.settings, listBatch(1), controller.signal, long.gate, undefined, {
    details: false,
    emit: (event) => {
      if (event.kind === "request" && (event.retryDelayMs ?? 0) > 3_000_000) cooling = true
    }
  })
  const cancellation = assert.rejects(cancelled)
  await waitFor(() => cooling)
  controller.abort("user-cancelled")
  await cancellation
  assert.equal(long.seen.length, 1)
  const ignored = await chatFixture(t, (_body, items, call) => (call === 1 ? { status: 429, headers: { "Retry-After": "3600" } } : items.join("\n%%\n")))
  assert.equal((await requestTranslation(ignored.service, { ...ignored.settings, respectRetryAfter: false }, listBatch(1), new AbortController().signal, ignored.gate)).length, 1)
})
