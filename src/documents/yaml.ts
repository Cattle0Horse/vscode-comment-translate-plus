import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml"
import type { Document } from "yaml"
import type { TextUnit, ReferenceBlock, ParsedDocument } from "../model/document.ts"
import { makeUnit } from "./tree.ts"

export function yamlUnits(source: string, contentStart: number, yaml: Document.Parsed): TextUnit[] {
  if (yaml.errors.length) throw Error("yaml-invalid")
  const units: TextUnit[] = []

  function display(from: number, to: number): { start: number; end: number } {
    const start = source.lastIndexOf("\n", contentStart + from - 1) + 1
    let end = contentStart + to
    while (end > start && /[\r\n]/.test(source[end - 1])) end--
    return { start, end }
  }

  function reference(range: { start: number; end: number }): ReferenceBlock {
    const end = range.end + (source.slice(range.end).match(/^\r?\n/)?.[0].length ?? 0)
    return { kind: "YAML", text: source.slice(range.start, end), range: { start: range.start, end, container: contentStart } }
  }

  function scalar(node: unknown, view?: TextUnit["display"], reference: readonly ReferenceBlock[] = [], scope = "yaml", yamlKey = false): void {
    if (!isScalar(node) || typeof node.value !== "string" || !node.range || node.range[0] === node.range[1] || !node.value.trim()) return
    const unit = makeUnit(source, contentStart + node.range[0], contentStart + node.range[1], "yaml")
    units.push({ ...unit, content: node.value, yamlKey, display: view ?? display(node.range[0], node.range[1]), reference, scope })
  }

  function visit(node: unknown, view?: TextUnit["display"], parents: readonly ReferenceBlock[] = [], scope = "yaml"): void {
    if (isMap(node)) {
      if (node.flow && node.range) view ??= display(node.range[0], node.range[1])
      const scope = "yaml:" + (contentStart + (node.range?.[0] ?? 0))
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? pair.key : undefined
        const value = pair.value
        const collection = isMap(value) || isSeq(value) ? value : undefined
        const range = collection?.range
        const flow = collection?.flow && range ? display(key?.range?.[0] ?? range[0], range[1]) : undefined
        const colon = key?.range ? (source.slice(contentStart + key.range[1]).match(/^[\t ]*:/)?.[0].length ?? 0) : 0
        const field = view ?? flow ?? (key?.range ? display(key.range[0], (isScalar(value) || isAlias(value)) && value.range ? value.range[1] : key.range[1] + colon) : undefined)
        const referenceRange = view ?? flow ?? (key?.range && range ? display(key.range[0], range[1]) : field)
        const references = referenceRange ? [reference(referenceRange), ...parents.slice().reverse()] : parents.slice().reverse()
        scalar(key, field, references, scope, true)
        if (isScalar(value)) scalar(value, field, references, scope)
        else visit(value, view ?? flow, field ? [...parents, reference(field)] : parents, scope)
      }
    } else if (isSeq(node)) {
      if (node.flow && node.range) view ??= display(node.range[0], node.range[1])
      for (const child of node.items) visit(child, view, parents, "yaml:" + (contentStart + (node.range?.[0] ?? 0)))
    } else {
      const raw = isScalar(node) && node.range ? display(node.range[0], node.range[1]) : undefined
      scalar(node, view, raw ? [reference(raw), ...parents.slice().reverse()] : parents.slice().reverse(), scope)
    }
  }

  visit(yaml.contents)
  return units
}

export function parseYaml(source: string): ParsedDocument {
  try {
    const groups = parseAllDocuments(source, { strict: true }).flatMap((document) => {
      const units = yamlUnits(source, 0, document)
      return units.length ? [{ start: document.range[0], end: document.range[2], units }] : []
    })
    return { source, groups, errors: [] }
  } catch {
    return { source, groups: [], errors: ["yaml-invalid"] }
  }
}

export function yamlShape(node: unknown): unknown {
  if (isAlias(node)) return ["alias", node.source]
  if (isScalar(node)) return typeof node.value === "string" ? "string" : node.value
  if (isMap(node)) return ["map", node.items.map((pair) => [yamlShape(pair.key), yamlShape(pair.value)])]
  if (isSeq(node)) return ["seq", node.items.map(yamlShape)]
  if (node === null) return null
  throw Error("translation-yaml-invalid")
}

export function assertYamlStructure(source: string, translated: string): void {
  function shape(text: string): unknown {
    return parseAllDocuments(text, { strict: true }).map((document) => {
      if (document.errors.length) throw Error("translation-structure-invalid")
      return yamlShape(document.contents)
    })
  }

  if (JSON.stringify(shape(source)) !== JSON.stringify(shape(translated))) throw Error("translation-structure-invalid")
}
