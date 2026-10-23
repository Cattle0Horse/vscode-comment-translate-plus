import * as vscode from "vscode"
import { Application } from "./host/application.ts"

export function activate(context: vscode.ExtensionContext): Application {
  const application = new Application(context)
  context.subscriptions.push(application)
  return application
}
