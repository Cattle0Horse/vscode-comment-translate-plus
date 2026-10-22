import assert from "node:assert/strict"
import { hashText } from "./verify.mjs"

const { isTargetLanguage } = await import("../artifacts/core/documents/languageDetection.mjs")
const inputs = [
  { text: "这是已经写好的中文说明，不需要再次请求翻译服务。", target: "zh-CN", expected: true },
  { text: "Read the original document.", target: "en-US", expected: true },
  { text: "これは日本語で書かれた文章です。変更せずにそのまま保持してください。", target: "ja", expected: true },
  { text: "Bonjour, ceci est un texte écrit en français pour tester la détection.", target: "fr", expected: true },
  { text: "这是中文说明。 Read the original document.", target: "zh-CN", expected: false },
  { text: "Read the original document.", target: "zh-CN", expected: false },
  { text: "你好", target: "zh-CN", expected: false },
  { text: "Read the original document. ".repeat(300), target: "en-US", expected: false }
]
const workload = Array.from({ length: 200 }, (_, index) => {
  const item = inputs[index % inputs.length]
  return { ...item, unit: { id: String(index), start: 0, end: item.text.length, text: item.text, format: "markdown" } }
})

export default {
  id: "product.offline-language-detection",
  kind: "product",
  fingerprint: hashText(JSON.stringify({ inputs, count: workload.length, library: "tinyld@1.3.4", maxCharacters: 4096, score: 0.9, margin: 0.25 })),
  scenarios: [
    {
      id: "detect-200-multilingual-units",
      run() {
        for (const { unit, target, expected } of workload) assert.equal(isTargetLanguage(unit, target), expected)
      }
    }
  ]
}
