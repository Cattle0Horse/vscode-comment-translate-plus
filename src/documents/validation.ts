import { isScalar, parseDocument } from "yaml"
import type { TextUnit, TranslationDifference } from "../model/document.ts"
import type { MarkdownNode } from "./tree.ts"
import { children, markdownTree, standalone } from "./tree.ts"
import { yamlShape } from "./yaml.ts"
import { fragmentContents, labelReference } from "./protection.ts"
import { unembedTranslation } from "./embedding.ts"

function translatedString(unit: TextUnit, text: string): string | undefined {
  if (unit.format !== "yaml") {
    const value: unknown = JSON.parse(text)
    return typeof value === "string" ? value : undefined
  }
  const document = parseDocument(text)
  return !document.errors.length && isScalar(document.contents) && typeof document.contents.value === "string" ? document.contents.value : undefined
}

type ValidationFailure = TranslationDifference & { readonly modelReason: string; readonly instruction: string }

// Names and both corrections belong to one content category, not separate dispatchers.
const contentDescriptions = {
  syntax: {
    name: "源码语法",
    modelName: "delimiters, escapes or interpolations",
    preserve: "Keep source delimiters, escapes and interpolations unchanged.",
    remove: "Remove source-language syntax absent from this source item."
  },
  link: {
    name: "链接目标",
    modelName: "link targets",
    preserve: "Preserve every source link target exactly; translate only link text.",
    remove: "Remove link targets absent from this source item."
  },
  reference: {
    name: "引用链接或图片标签",
    modelName: "reference-link or image labels",
    preserve: "Preserve source reference-link labels exactly; translate only surrounding prose.",
    remove: "Remove reference links and images absent from this source item."
  },
  code: {
    name: "代码块",
    modelName: "code blocks",
    preserve: "Keep source code blocks and their fences unchanged.",
    remove: "Remove code blocks absent from this source item."
  },
  html: {
    name: "HTML 标签或区块",
    modelName: "HTML markup",
    preserve: "Keep source HTML tags and attributes unchanged.",
    remove: "Remove HTML tags absent from this source item. Write tag names mentioned in prose as plain text without angle brackets."
  },
  linkSyntax: {
    name: "链接或图片括号",
    modelName: "link or image brackets",
    preserve: "Preserve source link and image brackets and parentheses; keep link targets unchanged.",
    remove: "Remove link or image brackets absent from this source item."
  },
  quote: {
    name: "引用前缀",
    modelName: "blockquote prefixes",
    preserve: "Preserve source blockquote prefixes and nesting.",
    remove: "Remove blockquote prefixes absent from this source item."
  },
  escape: {
    name: "Markdown 转义",
    modelName: "Markdown escape sequences",
    preserve: "Keep source Markdown escape sequences unchanged.",
    remove: "Remove Markdown escape sequences absent from this source item."
  },
  heading: {
    name: "标题标记",
    modelName: "heading markers",
    preserve: "Preserve source heading levels; do not add or remove headings.",
    remove: "Remove headings absent from this source item."
  },
  list: {
    name: "列表标记",
    modelName: "list markers",
    preserve: "Preserve source list markers and nesting; do not add or remove list items.",
    remove: "Remove list items absent from this source item."
  },
  task: {
    name: "任务框",
    modelName: "task-list checkboxes",
    preserve: "Preserve source task-list checkboxes and their checked state.",
    remove: "Remove task-list checkboxes absent from this source item."
  },
  emphasis: {
    name: "强调或删除线标记",
    modelName: "emphasis or strikethrough delimiters",
    preserve: "Preserve source emphasis delimiters and nesting.",
    remove: "Remove emphasis or strikethrough absent from this source item."
  },
  data: {
    name: "字面数据",
    modelName: "literal data",
    preserve: "Keep source literal data unchanged.",
    remove: "Remove literal data absent from this source item."
  },
  other: {
    name: "格式或保护内容",
    modelName: "formatting or protected content",
    preserve: "Preserve the source formatting and protected content.",
    remove: "Remove formatting absent from this source item; exclude reference/context and explanations."
  }
} as const

function describeContent(kind?: string) {
  if (kind === undefined) return contentDescriptions.syntax
  if (kind === "URL" || kind === "Autolink") return contentDescriptions.link
  if (["LinkLabel", "Link", "Image"].includes(kind)) return contentDescriptions.reference
  if (["FencedCode", "CodeBlock", "CodeMark"].includes(kind)) return contentDescriptions.code
  if (kind === "HTMLTag" || kind === "HTMLBlock") return contentDescriptions.html
  if (kind === "LinkMark") return contentDescriptions.linkSyntax
  if (kind === "QuoteMark") return contentDescriptions.quote
  if (kind === "Escape") return contentDescriptions.escape
  if (kind === "HeaderMark") return contentDescriptions.heading
  if (kind === "ListMark") return contentDescriptions.list
  if (kind === "TaskMarker") return contentDescriptions.task
  if (kind === "EmphasisMark" || kind === "StrikethroughMark") return contentDescriptions.emphasis
  if (kind === "Technical") return contentDescriptions.data
  return contentDescriptions.other
}

/** A missing expectation means the response introduced content; otherwise retain the source fragment. */
export function protectedContentFailure({ kind, expected, actual }: { kind?: string; expected?: string; actual?: string }): ValidationFailure {
  const content = describeContent(kind)
  if (expected === undefined)
    return {
      reason: "模型新增了原文之外的" + content.name + "。",
      modelReason: "The response added " + content.modelName + " absent from the source.",
      instruction: content.remove,
      expected: "不新增原文之外的" + content.name + "。",
      actual
    }
  return {
    reason: actual === undefined ? "模型返回的译文缺失" + content.name + "。" : "模型修改了" + content.name + "。",
    modelReason: "The response " + (actual === undefined ? "omitted" : "changed") + " source " + content.modelName + ".",
    instruction: content.preserve,
    expected,
    actual: actual ?? "（缺失）"
  }
}

/** Describe differences between fragments already extracted by the validator. */
function fragmentDifference(expected: ReturnType<typeof fragmentContents>, actual: ReturnType<typeof fragmentContents>): ValidationFailure | undefined {
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
    return protectedContentFailure({ kind: fragment[0], expected: fragment[1], actual: replacement?.[1] })
  }
  // Keep the existing diagnostic priority: added link targets, code blocks, then other syntax.
  const extra =
    unmatched.find((fragment) => describeContent(fragment[0]) === contentDescriptions.link) ??
    unmatched.find((fragment) => describeContent(fragment[0]) === contentDescriptions.code) ??
    unmatched[0]
  if (extra) return protectedContentFailure({ kind: extra[0], actual: extra[1] })
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
  if (["FencedCode", "CodeBlock", "HTMLTag", "HTMLBlock", "URL", "LinkLabel", "ListMark", "TaskMarker", "Escape"].includes(node.name)) return [node.name, source.slice(node.from, node.to)]
  const content = children(node).filter((child) => !["HardBreak", "QuoteMark", "InlineCode"].includes(child.name))
  const shapes = content.map((child) => markdownShape(child, source, embedded))
  const inline = content.length > 1 && content.every((child) => ["Emphasis", "StrongEmphasis", "Strikethrough", "Link", "Image"].includes(child.name))
  return [node.name, inline ? shapes.map((shape) => JSON.stringify(shape)).sort() : shapes]
}

/** Compare validated results; YAML representation and prose boundary whitespace are not translations. */
export function translationIsUnchanged(unit: TextUnit, translated: string): boolean {
  if (translated === unit.text) return true
  if (unit.embedding) return translationIsUnchanged(unit.embedding.unit, unembedTranslation(unit, translated))
  if (unit.kind === "string") return false
  if (unit.content !== undefined) {
    return translatedString(unit, translated) === unit.content
  }
  return translated.replace(/\r\n/g, "\n").trim() === unit.text.replace(/\r\n/g, "\n").trim()
}

/** Success has no difference; rejection carries the reason found by this same check. */
export function validateTranslation(unit: TextUnit, translated: string): ValidationFailure | undefined {
  if (!translated.trim())
    return {
      modelReason: "The response for this item was empty.",
      instruction: "Provide a non-empty translation for this item.",
      reason: "模型返回了空译文。",
      expected: "非空译文",
      actual: "空文本"
    }
  if (translated.length > 200000)
    return {
      modelReason: "The response exceeded the 200000 UTF-16 character limit for one item.",
      instruction: "Return only this source item's translation within 200000 UTF-16 characters; exclude reference/context and explanations.",
      reason: "模型返回的单项译文超过长度上限。",
      expected: "不超过 200000 个 UTF-16 字符",
      actual: translated.length + " 个字符"
    }
  if (unit.embedding) {
    let logical: string
    try {
      logical = unembedTranslation(unit, translated)
    } catch {
      return {
        modelReason: "The response changed code-block container prefixes or line boundaries.",
        instruction: "Preserve source code-block container prefixes and structural line boundaries.",
        reason: "模型修改了代码块的容器前缀或行边界。"
      }
    }
    return validateTranslation(unit.embedding.unit, logical)
  }
  if (unit.content !== undefined) {
    let value: string | undefined
    try {
      value = translatedString(unit, translated)
    } catch {
      // Invalid serialization must not be interpreted as translated prose.
    }
    if (value === undefined)
      return {
        reason: "模型返回的字符串语法无效。",
        modelReason: "The response is not a valid source-language string literal.",
        instruction: unit.format === "yaml" ? "Return a valid YAML string scalar; preserve its string type." : "Return a valid JSON string literal with escaped quotes and backslashes."
      }
    return validateTranslation({ ...unit, text: unit.content, content: undefined, protected: undefined, format: "text" }, value)
  }
  if (unit.kind === "comment" && unit.text.startsWith("/*")) {
    const expected = unit.text.match(/\/\*|\*\//g) ?? []
    const actual = translated.match(/\/\*|\*\//g) ?? []
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      return {
        modelReason: "The response changed block-comment delimiters or their order.",
        instruction: "Preserve source /* and */ delimiters in their original order; do not add or remove comment boundaries.",
        reason: "模型修改了块注释定界符或其顺序。",
        expected: expected.join(" "),
        actual: actual.length ? actual.join(" ") : "（缺失）"
      }
  }
  if (unit.format === "yaml")
    return {
      modelReason: "The response is not a supported YAML string unit.",
      instruction: "Translate only the requested YAML string value; do not return a whole YAML document.",
      reason: "无法将未拆分的 YAML 内容作为字符串单元校验。"
    }
  try {
    if (unit.format === "text") {
      const expected = fragmentContents(unit)
      const actual = fragmentContents({ ...unit, text: translated })
      if (JSON.stringify(expected) === JSON.stringify(actual)) return
      return (
        fragmentDifference(expected, actual) ?? {
          modelReason: "The response reordered protected fragments.",
          instruction: "Keep source protected fragments in their original order.",
          reason: "模型改变了受保护片段的顺序。"
        }
      )
    }
    let source = standalone(unit.text)
    let output = standalone(translated)
    if (unit.display) {
      source = "| " + source + " |\n| --- |"
      output = "| " + output + " |\n| --- |"
    }
    const before = markdownTree(source).topNode
    const after = markdownTree(output).topNode
    if (JSON.stringify(markdownShape(before, source)) === JSON.stringify(markdownShape(after, output))) return
    return (
      fragmentDifference(fragmentContents({ ...unit, text: source }, before), fragmentContents({ ...unit, text: output }, after)) ?? {
        modelReason: "The response changed Markdown paragraphs, list hierarchy or formatting structure.",
        instruction:
          "Translate only this source item. Preserve source syntax, document structure, link targets, and protected content. Exclude the reference/context, other items, and explanations.",
        reason: "模型修改了 Markdown 的段落、列表层级或格式结构。"
      }
    )
  } catch {
    return {
      modelReason: "The response document structure could not be validated.",
      instruction: "Return this source item's translation with valid source document syntax; exclude reference/context and explanations.",
      reason: "无法校验译文的文档结构。"
    }
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
