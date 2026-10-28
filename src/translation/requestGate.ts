interface WaitingRequest {
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

  constructor(
    private rate: number,
    private concurrency: number
  ) {}

  configure(rate: number, concurrency: number): void {
    this.rate = rate
    this.concurrency = concurrency
    this.pump()
  }

  run<T>(work: () => Promise<T>, signal: AbortSignal, priority: () => number = () => 2): Promise<T> {
    return this.enqueue(work, signal, priority, "http")
  }

  /** Plan the next batch at admission without spending an HTTP slot or rate token. */
  plan(work: () => void, signal: AbortSignal, priority: () => number): Promise<void> {
    return this.enqueue(work, signal, priority, "planning")
  }

  private enqueue<T>(work: () => T | Promise<T>, signal: AbortSignal, priority: () => number, kind: "http" | "planning"): Promise<T> {
    if (this.disposed) return Promise.reject("extension-disposed")
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const request: WaitingRequest = {
        signal,
        priority,
        kind,
        start: () => {
          signal.removeEventListener("abort", request.cancel)
          if (kind === "http") {
            this.active++
            this.starts.push(performance.now())
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
      if (!this.timer) this.pump()
    })
  }

  private pump(): void {
    if (this.pumping || this.disposed || this.continuation) return
    this.pumping = true
    try {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      const now = performance.now()
      this.starts = this.starts.filter((start) => now - start < 1000)
      while (this.waiting.length && this.active < this.concurrency && this.starts.length < this.rate) {
        let next = 0
        let priority = this.waiting[0].priority()
        for (let index = 1; index < this.waiting.length; index++) {
          const candidate = this.waiting[index].priority()
          if (candidate < priority || (candidate === priority && this.waiting[index].kind === "http" && this.waiting[next].kind === "planning")) {
            next = index
            priority = candidate
          }
        }
        const request = this.waiting.splice(next, 1)[0]
        if (request.signal.aborted) request.cancel()
        else request.start()
      }
      if (this.waiting.length && this.active < this.concurrency && this.starts.length >= this.rate) {
        this.timer = setTimeout(() => this.pump(), Math.max(1, 1001 - (performance.now() - this.starts[0])))
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
  }
}
