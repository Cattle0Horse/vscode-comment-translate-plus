import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { StatementSync } from "node:sqlite"

export interface PersistentCacheOptions {
  readonly enabled: boolean
  readonly maxEntries: number
  readonly maxBytes: number
}

export interface PersistentCacheSnapshot {
  readonly state: "disabled" | "ready" | "failed"
  readonly entries: number | undefined
  readonly bytes: number | undefined
  readonly diskBytes: number | undefined
  readonly pendingChanges: number
  readonly maxEntries: number
  readonly maxBytes: number
  readonly directory: string
}

interface Change {
  readonly text: string | undefined
  readonly bytes: number
  readonly used: number
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** SQLite owns the persistent index; only uncommitted mutations stay in JavaScript. */
export class PersistentCache {
  private options: PersistentCacheOptions = { enabled: false, maxEntries: 10000, maxBytes: 20 * 1024 * 1024 }
  private readonly changes = new Map<string, Change>()
  private readonly touches = new Map<string, number>()
  private database: DatabaseSync | undefined
  private select: StatementSync | undefined
  private upsert: StatementSync | undefined
  private erase: StatementSync | undefined
  private updateUsed: StatementSync | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private clock = Date.now() * 1000
  private buffered = 0
  private closed = false
  private failed = false
  private warned = false

  constructor(
    private readonly path: string,
    private readonly warning: () => void
  ) {}

  snapshot(): PersistentCacheSnapshot {
    let entries: number | undefined
    let bytes: number | undefined
    let reader: DatabaseSync | undefined
    try {
      const database = this.database ?? (statSync(this.path, { throwIfNoEntry: false }) ? (reader = new DatabaseSync(this.path, { readOnly: true, timeout: 250 })) : undefined)
      const totals = database?.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM translations").get()
      entries = totals ? Number(totals.count) : 0
      bytes = totals ? Number(totals.bytes) : 0
    } catch {
      // Statistics must not change storage state or report unreadable data as empty.
    } finally {
      reader?.close()
    }
    let diskBytes: number | undefined
    try {
      diskBytes = ["", "-wal", "-shm"].reduce((total, suffix) => total + (statSync(this.path + suffix, { throwIfNoEntry: false })?.size ?? 0), 0)
    } catch {
      // File access failures are distinct from absent cache files.
    }
    return {
      state: this.failed ? "failed" : this.options.enabled ? "ready" : "disabled",
      entries,
      bytes,
      diskBytes,
      pendingChanges: this.changes.size,
      maxEntries: this.options.maxEntries,
      maxBytes: this.options.maxBytes,
      directory: dirname(this.path)
    }
  }

  async configure(options: PersistentCacheOptions): Promise<void> {
    if (this.closed) return
    this.options = options
    this.failed = false
    this.cancelTimer()
    try {
      if (!options.enabled) {
        this.clearPending()
        // Clear through SQLite so another connection cannot retain a deleted database inode.
        const database = this.database ?? this.open(false)
        database?.exec("DELETE FROM translations; PRAGMA wal_checkpoint(TRUNCATE)")
        this.release()
        return
      }
      this.open(true)
      this.write()
    } catch {
      this.fail()
    }
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.active) return
    const hash = digest(key)
    const pending = this.changes.get(hash)
    if (pending) {
      this.touch(key)
      return pending.text
    }
    try {
      const row = this.select!.get(hash)
      if (!row) return
      if (typeof row.text !== "string" || row.bytes !== Buffer.byteLength(row.text, "utf8") + 64) {
        this.remove(key)
        return
      }
      this.touch(key)
      return row.text
    } catch {
      this.fail()
      return undefined
    }
  }

  set(key: string, text: string): void {
    if (!this.active) return
    const bytes = Buffer.byteLength(text, "utf8") + 64
    this.change(digest(key), bytes > this.options.maxBytes ? undefined : text, bytes)
  }

  remove(key: string): void {
    if (this.active) this.change(digest(key), undefined, 0)
  }

  touch(key: string): void {
    if (!this.active) return
    this.touches.set(digest(key), this.stamp())
    this.schedule()
  }

  async flush(): Promise<void> {
    this.cancelTimer()
    try {
      this.write()
    } catch {
      this.fail()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
    this.release()
    this.clearPending()
  }

  private get active(): boolean {
    return this.options.enabled && !this.closed && !this.failed && this.database !== undefined
  }

  private stamp(): number {
    this.clock = Math.max(this.clock + 1, Date.now() * 1000)
    return this.clock
  }

  private change(hash: string, text: string | undefined, bytes: number): void {
    this.buffered -= this.changes.get(hash)?.bytes ?? 0
    this.touches.delete(hash)
    const change = { text, bytes: text === undefined ? 0 : bytes, used: this.stamp() }
    this.changes.set(hash, change)
    this.buffered += change.bytes
    this.schedule()
    if (this.buffered >= 256 * 1024) void this.flush()
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.active) return
    this.timer = setTimeout(() => void this.flush(), 2000)
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private open(create: boolean): DatabaseSync | undefined {
    if (this.database) return this.database
    if (!create && !existsSync(this.path)) return undefined
    mkdirSync(dirname(this.path), { recursive: true })
    const database = new DatabaseSync(this.path, { timeout: 250 })
    this.database = database
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS translations (
        key TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 64),
        used INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS translations_used ON translations(used, key);
    `)
    this.select = database.prepare("SELECT text, bytes FROM translations WHERE key = ?")
    this.upsert = database.prepare("INSERT INTO translations VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, bytes = excluded.bytes, used = excluded.used")
    this.erase = database.prepare("DELETE FROM translations WHERE key = ?")
    this.updateUsed = database.prepare("UPDATE translations SET used = MAX(used, ?) WHERE key = ?")
    return database
  }

  private write(): void {
    if (!this.database || !this.options.enabled || this.failed) return
    const database = this.database
    database.exec("BEGIN IMMEDIATE")
    try {
      for (const [hash, change] of this.changes) {
        if (change.text === undefined) this.erase!.run(hash)
        else this.upsert!.run(hash, change.text, change.bytes, change.used)
      }
      for (const [hash, used] of this.touches) this.updateUsed!.run(used, hash)
      const totals = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM translations").get()!
      let count = Number(totals.count)
      let bytes = Number(totals.bytes)
      if (count > this.options.maxEntries || bytes > this.options.maxBytes) {
        for (const row of database.prepare("SELECT key, bytes FROM translations ORDER BY used, key").iterate()) {
          if (count <= Math.floor(this.options.maxEntries * 0.8) && bytes <= Math.floor(this.options.maxBytes * 0.8)) break
          this.erase!.run(row.key!)
          count--
          bytes -= Number(row.bytes)
        }
      }
      database.exec("COMMIT")
      this.clearPending()
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  private release(): void {
    this.select = undefined
    this.upsert = undefined
    this.erase = undefined
    this.updateUsed = undefined
    this.database?.close()
    this.database = undefined
  }

  private clearPending(): void {
    this.changes.clear()
    this.touches.clear()
    this.buffered = 0
  }

  private fail(): void {
    this.failed = true
    this.cancelTimer()
    this.clearPending()
    this.release()
    if (this.warned) return
    this.warned = true
    this.warning()
  }
}
