import { build, context } from "esbuild"
import { readFile, writeFile, copyFile, mkdir, readdir, unlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

const args = new Set(process.argv.slice(2))
await mkdir("dist", { recursive: true })
await copyFile("resources/loading.svg", "dist/loading.svg")
await copyFile(createRequire(import.meta.url).resolve("vscode-oniguruma/release/onig.wasm"), "dist/onig.wasm")
for (const arg of args) {
  if (!["--production", "--watch", "--tests"].includes(arg)) throw Error(`Unknown build option: ${arg}`)
}
if (args.has("--production") && (args.has("--watch") || args.has("--tests"))) throw Error("Production, watch and test builds must run separately.")

const options = {
  entryPoints: ["src/extension.ts", "src/desktop.ts"],
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "browser",
  mainFields: ["module", "main"],
  target: "es2022",
  format: "cjs",
  external: ["vscode", "node:os"],
  sourcemap: !args.has("--production"),
  minify: args.has("--production"),
  metafile: true,
  logLevel: "silent"
}

if (args.has("--watch")) {
  const watcher = await context({
    ...options,
    plugins: [
      {
        name: "watch-messages",
        setup(builder) {
          builder.onStart(() => console.log("[watch] build started"))
          builder.onEnd((result) => {
            for (const error of result.errors) {
              const location = error.location
              console.error(`${location?.file ?? "build"}:${location?.line ?? 1}:${(location?.column ?? 0) + 1}: error: ${error.text}`)
            }
            console.log("[watch] build finished")
          })
        }
      }
    ]
  })
  await watcher.watch()
} else {
  const result = await build(options)
  const licenses = new Map()
  const bundledInputs = new Set(
    Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, details]) => details.bytesInOutput > 0)
        .map(([input]) => input)
    )
  )
  for (const input of bundledInputs) {
    if (!input.includes("node_modules/")) continue
    let directory = dirname(resolve(input))
    while (directory.includes("node_modules")) {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"))
        if (!manifest.name) {
          directory = dirname(directory)
          continue
        }
        if (licenses.has(manifest.name)) break
        let license
        for (const name of ["license", "LICENSE", "LICENSE.md", "license.md", "LICENSE.txt", "LICENSE-MIT.txt"]) {
          try {
            license = await readFile(resolve(directory, name), "utf8")
            break
          } catch (error) {
            if (error.code !== "ENOENT") throw error
          }
        }
        if (!license) throw Error(`Missing bundled license: ${manifest.name}`)
        for (const name of ["NOTICES.txt", "NOTICE", "ThirdPartyNotices.txt"]) {
          try {
            license += "\n\n" + (await readFile(resolve(directory, name), "utf8"))
          } catch (error) {
            if (error.code !== "ENOENT") throw error
          }
        }
        licenses.set(manifest.name, `${manifest.name}@${manifest.version}\n${license}`)
        break
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        directory = dirname(directory)
      }
    }
  }
  await writeFile("dist/ThirdPartyNotices.txt", [...licenses.values()].sort().join("\n\n----------\n\n") + "\n")
  if (args.has("--tests")) {
    await mkdir("artifacts/tests", { recursive: true })
    for (const file of await readdir("artifacts/tests")) if (/\.test\.cjs(?:\.map)?$/.test(file)) await unlink(resolve("artifacts/tests", file))
    const tests = (await readdir("tests")).filter((file) => file.endsWith(".test.ts")).map((file) => "tests/" + file)
    await build({ ...options, platform: "node", entryPoints: tests, outfile: undefined, outdir: "artifacts/tests", outExtension: { ".js": ".cjs" } })
    await build({ ...options, outdir: undefined, entryPoints: ["tests/extension/index.ts"], outfile: "artifacts/extension-tests/index.cjs" })
    await build({ ...options, outdir: undefined, entryPoints: ["tests/extension/local.ts"], outfile: "artifacts/extension-tests/local.cjs" })
    await build({
      ...options,
      entryPoints: [
        "src/documents/markdown.ts",
        "src/documents/code.ts",
        "src/documents/tokenization.ts",
        "src/documents/yaml.ts",
        "src/documents/presentation.ts",
        "src/documents/validation.ts",
        "src/documents/protection.ts",

        "src/translation/store.ts",
        "src/documents/languageDetection.ts",
        "src/host/logging.ts",
        "src/documents/terms.ts",
        "src/documents/references.ts",
        "src/translation/engine.ts",
        "src/translation/prepare.ts",
        "src/translation/providers/prompts.ts"
      ],
      format: "esm",
      splitting: true,
      outdir: "artifacts/core",
      outfile: undefined,
      outExtension: { ".js": ".mjs" }
    })
  }
  console.log(args.has("--production") ? "Production translation extension built." : "Translation extension built.")
}
