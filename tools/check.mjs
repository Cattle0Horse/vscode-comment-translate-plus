import { readdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadCorpus } from "./verify.mjs"

const root = new URL("../", import.meta.url)
let count = 0
for (const folder of ["tools", "tests"]) {
  for (const file of await readdir(new URL(`${folder}/`, root))) {
    if (!file.endsWith(".mjs")) continue
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`${folder}/${file}`, root))], { cwd: root, encoding: "utf8" })
    if (result.error || result.status !== 0) {
      console.error(result.error?.message ?? result.stderr)
      process.exit(1)
    }
    count++
  }
}
const corpus = await loadCorpus()
console.log(`Tooling syntax checked ${count} modules; validated ${corpus.length} corpus cases. TypeScript, Oxfmt and Oxlint checks run next.`)
