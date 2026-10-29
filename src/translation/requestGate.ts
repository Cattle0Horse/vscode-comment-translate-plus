import type { ServiceSettings } from "./settings.ts"
import { retryDelay, transportPolicySchema } from "./transport.ts"

interface Recovery {
  settings: ServiceSettings
  until: number
  failures: number
  nextStart: number
  limit: number
  successes: number
  slowStart: boolean
  recovering: boolean
  generation: object
  readonly reducedVersions: WeakSet<object>
  networkFailures: number[]
}

interface WaitingRequest {
  readonly scope: string
  readonly notBefore: number
  readonly signal: AbortSignal
  readonly priority: () => number
  readonly kind: "http" | "planning"
  start(): void
  cancel(): void
}

export class RequestGate {
  private starts: number[] = []
  private active = 0
  private waiting: WaitingRequest[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private pumping = false
  private continuation: ReturnType<typeof setImmediate> | undefined
  private readonly recovery = new Map<string, Recovery>()
  private readonly activeScopes = new Map<string, number>()

  constructor(
    private rate: number,
    private concurrency: number
  ) {}

  configure(rate: number, concurrency: number): void {
    this.rate = rate
    this.concurrency = concurrency
    this.pump()
  }

  run<T>(work: () => Promise<T>, signal: AbortSignal, priority: () => number = () => 2, scope = "", notBefore = 0): Promise<T> {
    return this.enqueue(work, signal, priority, "http", scope, notBefore)
  }

  /** Plan the next batch at admission without spending an HTTP slot or rate token. */
  plan(work: () => void, signal: AbortSignal, priority: () => number, scope = ""): Promise<void> {
    return this.enqueue(work, signal, priority, "planning", scope, 0)
  }

  version(scope: string): object | undefined {
    return this.recovery.get(scope)?.generation
  }

  configureScope(scope: string, settings: ServiceSettings): void {
    const state = this.recovery.get(scope)
    if (state) {
      if (Object.keys(transportPolicySchema).some((key) => state.settings[key as keyof typeof transportPolicySchema] !== settings[key as keyof typeof transportPolicySchema])) {
        state.successes = 0
        state.failures = 0
        state.networkFailures = []
        state.generation = {}
        state.nextStart = state.until
      }
      state.settings = settings
      if (!settings.slowStart) state.slowStart = false
      if (!state.slowStart && !settings.requestRecovery) state.limit = this.concurrency
      else state.limit = Math.min(state.limit, this.concurrency)
    } else if (!this.disposed) {
      // Keep idle service learning bounded; active or still-cooling scopes retain their state.
      for (const [key, previous] of this.recovery) {
        if (this.recovery.size < 16) break
        if (previous.until <= performance.now() && !this.activeScopes.has(key) && !this.waiting.some((item) => item.scope === key)) this.recovery.delete(key)
      }
      this.recovery.set(scope, {
        settings,
        until: 0,
        failures: 0,
        nextStart: 0,
        successes: 0,
        limit: settings.slowStart ? Math.min(settings.slowStartInitialConcurrency, this.concurrency) : this.concurrency,
        slowStart: settings.slowStart,
        recovering: false,
        generation: {},
        networkFailures: [],
        reducedVersions: new WeakSet()
      })
    }
  }

  failed(scope: string, settings: ServiceSettings, attempt: number, serverDelay = 0, pressure = false, version = this.version(scope)): number {
    if (this.disposed) return 0
    this.configureScope(scope, settings)
    const state = this.recovery.get(scope)!
    const now = performance.now()
    state.failures++
    const failures = settings.sharedRequestCooldown ? state.failures : attempt
    const until = now + Math.max(serverDelay, retryDelay(settings, failures))
    state.slowStart = false
    state.successes = 0
    state.networkFailures = state.networkFailures.filter((time) => now - time < settings.networkFailureWindowMs)
    if (!pressure) {
      state.networkFailures.push(now)
      state.networkFailures = state.networkFailures.slice(-settings.networkFailureThreshold)
    }
    if (settings.requestRecovery && (pressure || state.networkFailures.length >= settings.networkFailureThreshold) && version && !state.reducedVersions.has(version)) {
      state.limit = Math.min(this.concurrency, state.limit, Math.max(settings.recoveryMinConcurrency, Math.floor(state.limit * settings.recoveryDecreaseFactor)))
      state.reducedVersions.add(version)
    } else if (!settings.requestRecovery) state.limit = this.concurrency
    state.recovering = settings.requestRecovery
    state.generation = {}
    if (settings.sharedRequestCooldown) {
      state.until = Math.max(state.until, until)
      state.nextStart = Math.max(state.nextStart, state.until)
    }
    this.pump()
    return until
  }

  succeeded(scope: string, version: object | undefined): void {
    const state = this.recovery.get(scope)
    // A response started before the latest failure cannot reopen the gate.
    const now = performance.now()
    if (!state || state.generation !== version || now < state.until) return
    if (state.limit >= this.concurrency) {
      state.recovering = false
      state.nextStart = 0
      state.failures = 0
      return
    }
    // Growth needs backlog, a saturated concurrency allowance and spare rate/spacing budget.
    const loaded =
      this.waiting.some((item) => item.scope === scope && !item.signal.aborted && item.notBefore <= now) &&
      (this.activeScopes.get(scope) ?? 0) === state.limit &&
      this.starts.filter((start) => now - start < 1000).length < this.rate &&
      state.nextStart <= now
    if (!loaded) return
    if (++state.successes >= state.settings.recoverySuccesses) {
      state.successes = 0
      state.failures = 0
      state.limit = Math.min(this.concurrency, state.slowStart ? Math.ceil(state.limit * state.settings.slowStartGrowthFactor) : state.limit + state.settings.recoveryConcurrencyStep)
      if (state.limit >= this.concurrency) {
        state.recovering = false
        state.nextStart = 0
      }
    }
  }

  private enqueue<T>(work: () => T | Promise<T>, signal: AbortSignal, priority: () => number, kind: "http" | "planning", scope: string, notBefore: number): Promise<T> {
    if (this.disposed) return Promise.reject("extension-disposed")
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const request: WaitingRequest = {
        scope,
        notBefore,
        signal,
        priority,
        kind,
        start: () => {
          signal.removeEventListener("abort", request.cancel)
          if (kind === "http") {
            this.active++
            this.activeScopes.set(scope, (this.activeScopes.get(scope) ?? 0) + 1)
            this.starts.push(performance.now())
            const state = this.recovery.get(scope)
            if (state?.recovering) state.nextStart = performance.now() + state.settings.recoveryIntervalMs
          }
          let result: Promise<T>
          try {
            signal.throwIfAborted()
            result = Promise.resolve(work())
          } catch (error) {
            result = Promise.reject(error)
          }
          result.then(resolve, reject).finally(() => {
            if (kind === "http") {
              this.active--
              const active = (this.activeScopes.get(scope) ?? 1) - 1
              if (active) this.activeScopes.set(scope, active)
              else this.activeScopes.delete(scope)
              // Let consumers validate the response, learn batch limits and
              // enqueue their next priority before admitting another batch.
              if (!this.disposed && !this.continuation)
                this.continuation = setImmediate(() => {
                  this.continuation = undefined
                  this.pump()
                })
            } else if (!this.timer) this.pump()
          })
        },
        cancel: () => {
          this.waiting = this.waiting.filter((item) => item !== request)
          signal.removeEventListener("abort", request.cancel)
          reject(this.disposed ? "extension-disposed" : signal.reason)
          this.pump()
        }
      }
      signal.addEventListener("abort", request.cancel, { once: true })
      this.waiting.push(request)
      this.pump()
    })
  }

  private pump(): void {
    if (this.pumping || this.disposed || this.continuation) return
    this.pumping = true
    try {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      let wakeAt = Infinity
      while (this.waiting.length && this.active < this.concurrency) {
        const now = performance.now()
        this.starts = this.starts.filter((start) => now - start < 1000)
        if (this.starts.length >= this.rate) {
          wakeAt = this.starts[0] + 1001
          break
        }
        let next = -1
        let priority = Infinity
        wakeAt = Infinity
        for (let index = 0; index < this.waiting.length; index++) {
          const item = this.waiting[index]
          const state = this.recovery.get(item.scope)
          const readyAt = Math.max(item.notBefore, state?.until ?? 0, state?.nextStart ?? 0)
          if (readyAt > now) {
            wakeAt = Math.min(wakeAt, readyAt)
            continue
          }
          if (state && (this.activeScopes.get(item.scope) ?? 0) >= state.limit) continue
          const candidate = item.priority()
          if (candidate < priority || (candidate === priority && item.kind === "http" && this.waiting[next]?.kind === "planning")) {
            next = index
            priority = candidate
          }
        }
        if (next < 0) break
        const request = this.waiting.splice(next, 1)[0]
        if (request.signal.aborted) request.cancel()
        else request.start()
      }
      if (this.waiting.length && this.active < this.concurrency && Number.isFinite(wakeAt)) {
        this.timer = setTimeout(() => this.pump(), Math.min(2_147_483_647, Math.max(1, Math.ceil(wakeAt - performance.now()))))
      }
    } finally {
      this.pumping = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.continuation) clearImmediate(this.continuation)
    this.continuation = undefined
    for (const request of this.waiting) request.cancel()
    this.waiting = []
    this.recovery.clear()
  }
}
