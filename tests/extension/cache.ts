import * as vscode from "vscode"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PersistentCache } from "../../src/host/persistentCache.ts"
import { TranslationStore } from "../../src/translation/store.ts"
import { parseMarkdown } from "../../src/documents/markdown.ts"
import type { Application } from "../../src/host/application.ts"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message)
}

export async function runPersistentCache(workspace: vscode.Uri, owner: Application): Promise<string[]> {
  const path = join(workspace.fsPath, "persistent-cache-probe.sqlite")
  const options = { enabled: true, maxEntries: 10000, maxBytes: 20 * 1024 * 1024 }
  const warnings: string[] = []
  const open = async () => {
    const cache = new PersistentCache(path, () => warnings.push("cache-failure"))
    await cache.configure(options)
    return cache
  }
  const parsed = parseMarkdown("Read the original document.\n\nKeep `sourceId` and [guide](https://example.com).")
  const input = { units: parsed.groups.flatMap((group) => group.units) }
  const cache = await open()
  let restored: PersistentCache | undefined
  const signal = () => new AbortController().signal
  try {
    const store = new TranslationStore(cache)
    const result = await store.translate(
      "synthetic-config",
      input,
      async (input) => input.units.map((unit) => ({ id: unit.id, text: unit.text.replace("Read", "阅读").replace("Keep", "保留") })),
      signal()
    )
    await cache.close()
    restored = await open()
    const next = new TranslationStore(restored)
    const recovered = await next.translate(
      "synthetic-config",
      input,
      async () => {
        throw Error("Disk recovery unexpectedly requested translation.")
      },
      signal()
    )
    assert(JSON.stringify([...recovered]) === JSON.stringify([...result]), "A fresh store lost persisted unit translations.")
    next.invalidate("synthetic-config", [input])
    await restored.flush()
    await restored.close()
    restored = await open()
    let requested = 0
    await new TranslationStore(restored).translate(
      "synthetic-config",
      input,
      async (input) => {
        requested += input.units.length
        return input.units.map((unit) => ({ id: unit.id, text: unit.text }))
      },
      signal()
    )
    assert(requested === input.units.length, "Invalidated entries survived store reconstruction.")
    await restored.configure({ ...options, enabled: false })
    const database = new DatabaseSync(path)
    assert(database.prepare("SELECT COUNT(*) AS count FROM translations").get()?.count === 0, "Disabling persistence left cached records.")
    database.close()
    assert(!warnings.length, "Native cache storage reported a read or write failure.")
  } finally {
    await cache.close()
    await restored?.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  }

  const config = vscode.workspace.getConfiguration("commentTranslatePlus")
  const original = config.inspect<boolean>("persistentCache")?.globalValue
  const uri = vscode.Uri.joinPath(workspace, "persistent-settings.md")
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("Read the original document. Persistence settings probe."))
  const document = await vscode.workspace.openTextDocument(uri)
  const units = { units: parseMarkdown(document.getText()).groups.flatMap((group) => group.units) }
  try {
    await config.update("persistentCache", true, vscode.ConfigurationTarget.Global)
    await owner.translations.configureCache()
    const result = await owner.translations.translate(document, units, signal())
    await config.update("persistentCache", false, vscode.ConfigurationTarget.Global)
    await owner.translations.configureCache()
    const recovered = await owner.translations.translate(document, units, signal())
    assert(JSON.stringify([...result]) === JSON.stringify([...recovered]), "Disabling disk persistence discarded current memory results.")
    assert(document.getText().startsWith("Read the original document.") && !document.isDirty, "Cache configuration edited the source.")
  } finally {
    await config.update("persistentCache", original, vscode.ConfigurationTarget.Global)
    await owner.translations.configureCache()
  }
  return [
    "native desktop SQLite persists independent validated units, restores a fresh store and deletes invalidations before reopening",
    "native persistent-cache settings enable and disable the production runtime without discarding memory results or editing source"
  ]
}
