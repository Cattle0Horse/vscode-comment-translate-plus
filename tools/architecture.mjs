import { readdir, readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"

const root = resolve("src")
const dependencies = new Map()
const layers = {
  model: ["model"],
  documents: ["model", "documents"],
  translation: ["model", "documents", "translation"]
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await inspect(path)
      continue
    }
    if (!path.endsWith(".ts")) continue
    const name = relative(root, path).replaceAll("\\", "/")
    const layer = name.split("/", 1)[0]
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true)
    const imports = []
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node)) continue
      const specifier = node.moduleSpecifier.text
      if (layers[layer] && specifier === "vscode") throw Error(`${name} must not depend on the VS Code host.`)
      if (!specifier.startsWith(".") || !specifier.endsWith(".ts")) continue
      const target = relative(root, resolve(dirname(path), specifier)).replaceAll("\\", "/")
      if (layers[layer] && !layers[layer].includes(target.split("/", 1)[0])) throw Error(`${name} crosses its dependency boundary: ${target}`)
      const bindings = node.importClause?.namedBindings
      const onlyTypes = node.importClause?.isTypeOnly || (bindings && ts.isNamedImports(bindings) && bindings.elements.every((item) => item.isTypeOnly))
      if (!onlyTypes) imports.push(target)
    }
    dependencies.set(name, imports)
  }
}

await inspect(root)
const visited = new Set()
const active = []

function visit(name) {
  if (active.includes(name)) throw Error("Runtime import cycle: " + [...active.slice(active.indexOf(name)), name].join(" -> "))
  if (visited.has(name)) return
  active.push(name)
  for (const target of dependencies.get(name) ?? []) visit(target)
  active.pop()
  visited.add(name)
}

for (const name of dependencies.keys()) visit(name)
console.log(`Architecture checked ${dependencies.size} source modules: domain boundaries and runtime imports.`)
