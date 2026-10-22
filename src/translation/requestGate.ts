interface WaitingRequest {
  readonly signal: AbortSignal
  start(): void
  cancel(): void
}

export class RequestGate {
  private starts: number[] = []
  private active = 0
  private waiting: WaitingRequest[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private rate: number,
    private concurrency: number
  ) {}

  configure(rate: number, concurrency: number): void {
    this.rate = rate
    this.concurrency = concurrency
    this.pump()
  }

  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject("extension-disposed")
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const request: WaitingRequest = {
        signal,
        start: () => {
          signal.removeEventListener("abort", request.cancel)
          this.active++
          this.starts.push(performance.now())
          let result: Promise<T>
          try {
            signal.throwIfAborted()
            result = work()
          } catch (error) {
            result = Promise.reject(error)
          }
          result.then(resolve, reject).finally(() => {
            this.active--
            this.pump()
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
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed) return
    const now = performance.now()
    this.starts = this.starts.filter((start) => now - start < 1000)
    while (this.waiting.length && this.active < this.concurrency && this.starts.length < this.rate) {
      const request = this.waiting.shift()!
      if (request.signal.aborted) request.cancel()
      else request.start()
    }
    if (this.waiting.length && this.active < this.concurrency && this.starts.length >= this.rate) {
      this.timer = setTimeout(() => this.pump(), Math.max(1, 1001 - (performance.now() - this.starts[0])))
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const request of this.waiting) request.cancel()
    this.waiting = []
  }
}
