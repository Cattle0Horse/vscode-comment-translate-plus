import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml"
import type { Document } from "yaml"
import type { TextUnit, ReferenceBlock, ParsedDocument } from "../model/document.ts"
import { makeUnit, endsProseLine } from "./tree.ts"

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
    const header = unit.text.match(/^[|>][^\n]*\n/u)
    const ranges: { start: number; end: number }[] = []
    if (header && !yamlKey) {
      let start = header[0].length
      for (const match of unit.text.slice(start).matchAll(/[^\n]*(?:\n|$)/gu)) {
        const end = header[0].length + match.index + match[0].trimEnd().length
        if (endsProseLine(match[0])) {
          ranges.push({ start, end })
          start = header[0].length + match.index + match[0].length
        }
      }
      const end = unit.text.trimEnd().length
      if (end > start) ranges.push({ start, end })
    }
    if (ranges.length <= 1) {
      units.push({ ...unit, content: node.value, yamlKey, display: view ?? display(node.range[0], node.range[1]), reference, scope })
      return
    }
    for (const range of ranges) {
      const part = makeUnit(source, unit.start + range.start, unit.start + range.end, "text")
      const inner: TextUnit = { ...part, kind: "string" }

      function content(text: string): string {
        assertYamlStructure(unit.text, unit.text.slice(0, range.start) + text + unit.text.slice(range.end))
        return text
      }

      units.push({
        ...part,
        reference,
        scope,
        projection: {
          kind: "literal",
          unit: inner,
          codec: {
            identity: unit.text,
            invalid: {
              reason: "The response changed YAML block scalar syntax.",
              instruction: "Translate only this prose item; preserve YAML indentation and block boundaries.",
              difference: { reason: "译文破坏了 YAML 多行值的语法。" }
            },
            restore: content,
            content,
            display: (text) => content(text).trim()
          }
        }
      })
    }
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
        const keyIndex = units.length
        scalar(key, field, references, scope, true)
        if (isScalar(value)) {
          const valueIndex = units.length
          scalar(value, field, references, scope)
          if (units.length - valueIndex > 1 && valueIndex > keyIndex && key?.range) {
            units[keyIndex] = { ...units[keyIndex], display: display(key.range[0], key.range[1] + colon) }
          }
        } else visit(value, view ?? flow, field ? [...parents, reference(field)] : parents, scope)
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
    const documents = parseAllDocuments(source, { strict: true })
    const error = documents.flatMap((document) => document.errors)[0]
    if (error)
      return {
        source,
        groups: [],
        errors: [{ code: "yaml-invalid", kind: "syntax", language: "yaml", range: { start: Math.min(source.length, error.pos[0]), end: Math.min(source.length, error.pos[1]) } }]
      }
    const groups = documents.flatMap((document) => {
      const units = yamlUnits(source, 0, document)
      return units.length ? [{ start: document.range[0], end: document.range[2], units }] : []
    })
    return { source, groups, errors: [] }
  } catch {
    return { source, groups: [], errors: [{ code: "yaml-invalid", kind: "syntax", language: "yaml", range: { start: 0, end: source.length } }] }
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
