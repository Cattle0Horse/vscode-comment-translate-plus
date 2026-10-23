import { readFile } from "node:fs/promises"
import { hashText, loadCorpus, verifySuite } from "./verify.mjs"

const corpus = await loadCorpus()
const suite = JSON.parse(await readFile(new URL("../fixtures/results.reference.json", import.meta.url), "utf8"))

export default {
  id: "tooling.verify-suite",
  kind: "tooling",
  fingerprint: hashText(JSON.stringify({ corpus, suite })),
  scenarios: [
    {
      id: "verify-reference-corpus",
      run() {
        verifySuite(corpus, suite)
      }
    }
  ]
}
