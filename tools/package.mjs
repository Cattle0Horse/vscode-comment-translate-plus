import { mkdir } from "node:fs/promises"
import { createVSIX } from "@vscode/vsce"

await mkdir("artifacts", { recursive: true })
await createVSIX({
  packagePath: "artifacts/comment-translate-plus.vsix",
  dependencies: false,
  skipLicense: true
})
