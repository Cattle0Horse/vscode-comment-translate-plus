import * as vscode from "vscode"
import { Application } from "./host/application.ts"
import { homedir } from "node:os"

let application: Application | undefined

export function activate(context: vscode.ExtensionContext): Application {
  application = new Application(context, homedir())
  context.subscriptions.push(application)
  return application
}

export async function deactivate(): Promise<void> {
  await application?.dispose()
  application = undefined
}
