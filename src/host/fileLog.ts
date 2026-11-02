import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { redact } from "./logging.ts"

/** Serializes appends and keeps already accepted entries bound to their original file. */
export class FileLog {
  private target: { readonly path: string; failed: boolean } | undefined
  private pending = Promise.resolve()
  private readonly sessionId = randomUUID()

  constructor(private readonly reportFailure: () => void) {}

  get path(): string | undefined {
    return this.target?.path
  }

  get enabled(): boolean {
    return this.target !== undefined && !this.target.failed
  }

  configure(path: string | undefined): void {
    if (path === this.path) return
    this.target = path ? { path, failed: false } : undefined
    if (path) this.record({ kind: "log-start" })
  }

  record(event: object, secrets: readonly string[] = []): void {
    const target = this.target
    if (!target || target.failed) return
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event }, (_key, value: unknown) =>
      typeof value === "string" ? redact(value, secrets) : value
    )
    this.pending = this.pending.then(async () => {
      if (target.failed) return
      try {
        await mkdir(dirname(target.path), { recursive: true })
        await appendFile(target.path, entry + "\n", "utf8")
      } catch {
        target.failed = true
        this.reportFailure()
      }
    })
  }

  async close(): Promise<void> {
    this.target = undefined
    await this.pending
  }
}
