import { isScalar, parseDocument } from "yaml"
import type { TextUnit, TranslationDifference } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree, standalone } from "./tree.ts"
import { yamlShape } from "./yaml.ts"
import { fragmentContents, labelReference } from "./protection.ts"
import { unembedTranslation } from "./embedding.ts"

/** Explain rejected output without changing the validation decision or repairing its content. */
export function translationDifference(unit: TextUnit, translated: string): TranslationDifference {
  if (unit.embedding) {
    try {
      return translationDifference(unit.embedding.unit, unembedTranslation(unit, translated))
    } catch {
      return { modelReason: "The response changed code-block container prefixes or line boundaries.", reason: "模型修改了代码块的容器前缀或行边界。" }
    }
  }
  if (!translated.trim()) return { modelReason: "The response for this item was empty.", reason: "模型返回了空译文。" }
  if (translated.length > 200000)
    return {
      modelReason: "The response exceeded the 200000 UTF-16 character limit for one item.",
      reason: "模型返回的单项译文超过长度上限。",
      expected: "不超过 200000 个 UTF-16 字符",
      actual: translated.length + " 个字符"
    }
  if (unit.format !== "yaml") {
    const expected = fragmentContents(unit)
    const actual = fragmentContents({ ...unit, text: translated })
    const unmatched = [...actual]
    const missing = expected.filter((fragment) => {
      const index = unmatched.findIndex((candidate) => candidate[0] === fragment[0] && candidate[1] === fragment[1])
      if (index < 0) return true
      unmatched.splice(index, 1)
      return false
    })
    if (missing.length) {
      const fragment = missing[0]
      const replacement = unmatched.find((candidate) => candidate[0] === fragment[0])
      let reason: string
      let modelReason: string
      if (fragment[0] === "URL") {
        reason = replacement ? "模型修改了链接目标。" : "模型返回的译文缺失链接目标。"
        modelReason = replacement ? "The response changed a link target." : "The response omitted a link target."
      } else if (fragment[0].includes("Code")) {
        reason = replacement ? "模型修改了受保护的代码。" : "模型返回的译文缺失受保护的代码。"
        modelReason = replacement ? "The response changed protected code." : "The response omitted protected code."
      } else {
        reason = replacement ? "模型修改了必须保留的格式或内容。" : "模型返回的译文缺失必须保留的格式或内容。"
        modelReason = replacement ? "The response changed required formatting or protected content." : "The response omitted required formatting or protected content."
      }
      return {
        modelReason,
        reason,
        expected: fragment[1],
        actual: replacement?.[1] ?? "（缺失）"
      }
    }
    // Markdown validates syntax, not translated prose that happens to match a technical-word pattern.
    const extra =
      unmatched.find((fragment) => fragment[0] === "URL") ??
      unmatched.find((fragment) => fragment[0].includes("Code")) ??
      unmatched.find((fragment) => unit.format === "text" || fragment[0] !== "Technical")
    if (extra)
      return {
        modelReason:
          extra[0] === "URL"
            ? "The response added a link target absent from the source."
            : extra[0].includes("Code")
              ? "The response added code absent from the source."
              : "The response added formatting or protected content absent from the source.",
        reason: extra[0] === "URL" ? "模型新增了原文之外的链接目标。" : extra[0].includes("Code") ? "模型新增了原文之外的代码片段。" : "模型新增了原文之外的格式或保护内容。",
        expected: "不新增原文之外的代码、链接或格式。",
        actual: extra[1]
      }
  }
  return {
    modelReason:
      unit.format === "yaml"
        ? "The response changed YAML field structure, value types or non-string data."
        : "The response changed Markdown paragraphs, list hierarchy or formatting structure.",
    reason: unit.format === "yaml" ? "模型修改了 YAML 字段结构、值类型或非字符串数据。" : "模型修改了 Markdown 的段落、列表层级或格式结构。"
  }
}

function markdownShape(node: MarkdownNode, source: string, embedded = false): unknown {
  if (labelReference(node, source)) return [node.name, source.slice(node.from, node.to)]
  if (embedded && node.name === "FencedCode")
    return [
      node.name,
      children(node)
        .filter((child) => ["CodeMark", "CodeInfo"].includes(child.name))
        .map((child) => [child.name, source.slice(child.from, child.to)])
    ]
  if (node.name === "InlineCode") return [node.name]
  if (["FencedCode", "CodeBlock", "HTMLTag", "HTMLBlock", "URL", "LinkLabel", "ListMark", "TaskMarker", "Escape"].includes(node.name)) return [node.name, source.slice(node.from, node.to)]
  const content = children(node).filter((child) => !["HardBreak", "QuoteMark"].includes(child.name))
  const shapes = content.map((child) => markdownShape(child, source, embedded))
  const inline = content.length > 1 && content.every((child) => ["InlineCode", "Emphasis", "StrongEmphasis", "Strikethrough", "Link", "Image"].includes(child.name))
  return [
    node.name,
    inline ? shapes.map((shape) => JSON.stringify(shape)).sort() : shapes,
    content
      .filter((child) => child.name === "InlineCode")
      .map((child) => source.slice(child.from, child.to))
      .sort()
  ]
}

/** Compare validated results; YAML representation and prose boundary whitespace are not translations. */
export function translationIsUnchanged(unit: TextUnit, translated: string): boolean {
  if (translated === unit.text) return true
  if (unit.embedding) return translationIsUnchanged(unit.embedding.unit, unembedTranslation(unit, translated))
  if (unit.kind === "string") return false
  if (unit.content !== undefined) {
    const value = parseDocument(translated).contents
    return isScalar(value) && value.value === unit.content
  }
  return translated.replace(/\r\n/g, "\n").trim() === unit.text.replace(/\r\n/g, "\n").trim()
}

export function validTranslation(unit: TextUnit, translated: string): boolean {
  try {
    if (!translated.trim() || translated.length > 200000) return false
    if (unit.embedding) return validTranslation(unit.embedding.unit, unembedTranslation(unit, translated))
    if (unit.kind === "comment" && unit.text.startsWith("/*") && JSON.stringify(unit.text.match(/\/\*|\*\//g)) !== JSON.stringify(translated.match(/\/\*|\*\//g))) return false
    if (unit.format === "text") return JSON.stringify(fragmentContents(unit)) === JSON.stringify(fragmentContents({ ...unit, text: translated }))
    if (unit.format === "yaml") {
      const after = parseDocument(translated)
      return unit.content !== undefined && !after.errors.length && isScalar(after.contents) && typeof after.contents.value === "string"
    }
    const shape = (text: string) => {
      let input = standalone(text)
      if (unit.display) input = "| " + input + " |\n| --- |"
      return JSON.stringify(markdownShape(markdownTree(input).topNode, input))
    }
    return shape(unit.text) === shape(translated)
  } catch {
    return false
  }
}

export function markdownDocumentShape(source: string, embedded = false): unknown {
  let frontmatter: unknown
  const opening = source.match(/^\uFEFF?---[\t ]*\r?\n/)
  if (opening) {
    const closing = /^---[\t ]*\r?$/gm
    closing.lastIndex = opening[0].length
    const end = closing.exec(source)
    if (!end) return ["incomplete", source]
    const raw = source.slice(opening[0].length, end.index)
    const yaml = parseDocument(raw)
    frontmatter = yaml.errors.length ? raw : yamlShape(yaml.contents)
    source = source.slice(end.index + end[0].length)
  }
  return [frontmatter, markdownShape(markdownTree(source).topNode, source, embedded)]
}

export function assertMarkdownStructure(source: string, translated: string): void {
  if (JSON.stringify(markdownDocumentShape(source)) !== JSON.stringify(markdownDocumentShape(translated))) throw Error("translation-structure-invalid")
}
