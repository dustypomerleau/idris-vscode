import * as vscode from "vscode"
import { IdrisClient } from "idris-ide-client"
import {
  currentWord,
  lineAfterDecl,
  insertLine,
  replaceLine,
  getIndent,
  prevEmptyLine,
  replaceRange,
  currentSelection,
} from "./editing"
import { stitchBrowseNamespace, stitchMetavariables } from "./message-stitching"
import { virtualDocState } from "./global-state"

let loaded: string = ""

/**
 * Many of the calls that accept the name of a metavariable don’t expect the
 * name to begin with the leading ?, so it has to be removed first.
 */
const trimMeta = (name: string) =>
  name.startsWith("?") ? name.slice(1, name.length) : name

const status = (msg: string) => vscode.window.setStatusBarMessage(msg, 2000)

const loadIfNot = (client: IdrisClient): Promise<void> => {
  const doc = vscode.window.activeTextEditor?.document
  return new Promise((res) => {
    if (doc && doc.fileName !== loaded) {
      res(loadFile(client, doc))
    }
    res()
  })
}

export const addClause = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    await loadIfNot(client)
    const reply = await client.addClause(name, line + 1)
    if (reply.ok) {
      const insertAt = lineAfterDecl(line)
      insertLine(reply.initialClause, insertAt)
    }
  }
}

/**
 * If you call addMissing on a case statement, it works, but is prefaced with
 * some unwanted text (but with correct indentation), e.g.:
 * "                 case block in one at /home/michael/dev/idris-scratch/temp.idr:6:18-22 _ (S k) = ?Z_rhs_1"
 * This function keeps the indent and the statement, but crops out the other text.
 * Also, it uses = instead of =>, I guess it doesn’t know it’s in a case statement.
 * Also, if you call it on the existing metavariable, it will add an additional ?
 */
const parseCaseBlockStmt = (replyText: string): string => {
  const regex = /(\s+)case block in \w+ at .*? _ (.*?)$/
  const match = regex.exec(replyText)
  if (match) {
    const [_, indent, stmt] = match
    const fixed = stmt.replace("=", "=>").replace("??", "?")
    return indent + fixed
  } else return replyText
}

export const addMissing = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    await loadIfNot(client)
    const reply = await client.addMissing(name, line + 1)
    if (reply.ok) {
      const insertAt = lineAfterDecl(line)
      insertLine(parseCaseBlockStmt(reply.missingClauses), insertAt)
    }
  }
}

const displayApropos = async (
  client: IdrisClient,
  input: string
): Promise<void> => {
  status("Searching for documentation that includes " + input + "...")
  const reply = await client.apropos(input)
  if (reply.ok) {
    virtualDocState[reply.id] = {
      text: reply.docs,
      metadata: reply.metadata,
    }
    const uri = vscode.Uri.parse("idris:" + reply.id)
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc)
  } else {
    status("No results found for " + input + ".")
  }
}

export const apropos = (client: IdrisClient) => async () => {
  const prompt = "Search documentation for all references to:"
  const input = await vscode.window.showInputBox({ prompt })
  if (input) displayApropos(client, input)
}

export const aproposSelection = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) displayApropos(client, selection.name)
}

export const browseNamespace = (client: IdrisClient) => async () => {
  const prompt = "Show contents of namespace:"
  const input = await vscode.window.showInputBox({ prompt })
  status("Searching for contents of " + input + "...")
  if (input) {
    const reply = await client.browseNamespace(input)
    if (reply.ok) {
      const docInfo = stitchBrowseNamespace(
        reply.subModules,
        reply.declarations
      )
      virtualDocState[reply.id] = docInfo
      const uri = vscode.Uri.parse("idris:" + reply.id)
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc)
    } else {
      status("No results found for " + input + ".")
    }
  }
}

export const caseSplit = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    await loadIfNot(client)
    const reply = await client.caseSplit(name, line + 1)
    if (reply.ok) {
      const caseStmt = reply.caseClause.trim()
      if (caseStmt) {
        // The reply doesn’t preserve indentation, so if we’re replacing the
        // whole line, we want to first re-add the original indentation. Adding
        // the padding to the first line is enough, the second line is magically
        // kept aligned.
        const indentation = getIndent(line)
        replaceLine(indentation + caseStmt, line)
      }
    } else {
      status(name + " cannot be case-split.")
    }
  }
}

const displayDocsFor = async (client: IdrisClient, input: string) => {
  status("Getting documentation for " + input + "...")
  const reply = await client.docsFor(input, ":full")
  if (reply.ok) {
    virtualDocState[reply.id] = {
      text: reply.docs,
      metadata: reply.metadata,
    }
    const uri = vscode.Uri.parse("idris:" + reply.id)
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc)
  } else {
    status("No results found for " + input + ".")
  }
}

export const docsFor = (client: IdrisClient) => async () => {
  const prompt = "Show documentation for: "
  const input = await vscode.window.showInputBox({ prompt })
  if (input) displayDocsFor(client, input)
}

export const docsForSelection = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) displayDocsFor(client, selection.name)
}

export const metavariables = (client: IdrisClient) => async () => {
  await loadIfNot(client)
  const reply = await client.metavariables(80)
  const docInfo = stitchMetavariables(reply.metavariables)
  virtualDocState[reply.id] = docInfo
  const uri = vscode.Uri.parse("idris:" + reply.id)
  const doc = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(doc)
}

export const evalResult = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
})

export const interpretSelection = (client: IdrisClient) => async () => {
  const selection = currentSelection()
  if (selection) {
    const { name, range } = selection
    await loadIfNot(client)
    const reply = await client.interpret(name)
    if (reply.ok) {
      const opts: vscode.DecorationOptions = {
        hoverMessage: { language: "idris", value: reply.result },
        range,
        renderOptions: {
          after: {
            color: new vscode.ThemeColor("editorCursor.foreground"),
            contentText: " => " + reply.result,
            fontStyle: "italic",
          },
        },
      }
      vscode.window.activeTextEditor?.setDecorations(evalResult, [opts])
    } else {
      status("Could not evaluate " + name + ".")
    }
  }
}

const displayPrintDefinition = async (client: IdrisClient, input: string) => {
  status("Getting definition for " + input + "...")
  await loadIfNot(client)
  const reply = await client.printDefinition(input)
  if (reply.ok) {
    virtualDocState[reply.id] = {
      text: reply.definition,
      metadata: reply.metadata,
    }
    const uri = vscode.Uri.parse("idris:" + reply.id)
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc)
  } else {
    status("No results found for " + input + ".")
  }
}

export const printDefinition = (client: IdrisClient) => async () => {
  const prompt = "Show definition for: "
  const input = await vscode.window.showInputBox({ prompt })
  if (input) displayPrintDefinition(client, input)
}

export const printDefinitionSelection = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) displayPrintDefinition(client, selection.name)
}

export const loadFile = async (
  client: IdrisClient,
  document: vscode.TextDocument
): Promise<void> =>
  new Promise((res) => {
    if (document.languageId === "idris") {
      res(
        client.loadFile(document.fileName).then(() => {
          loaded = document.fileName
        })
      )
    } else res()
  })

export const makeCase = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    loadIfNot(client)
    const reply = await client.makeCase(trimMeta(name), line + 1)
    const caseStmt = reply.caseClause.trim()
    if (caseStmt) {
      // The reply doesn’t preserve indentation, so if we’re replacing the whole
      // line, we want to first re-add the original indentation. Adding the
      // padding to the first line is enough, the second line is magically kept
      // aligned.
      const indentation = getIndent(line)
      replaceLine(indentation + caseStmt, line)
    } else {
      status("Failed to add a case statement for " + name + ".")
    }
  }
}

export const makeLemma = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    await loadIfNot(client)
    const reply = await client.makeLemma(trimMeta(name), line + 1)
    if (reply.ok) {
      const editor = vscode.window.activeTextEditor
      editor?.edit((eb) => {
        // when making multiple changes, they need to use the same edit-builder
        const declPos = new vscode.Position(prevEmptyLine(line), 0)
        eb.insert(declPos, "\n" + reply.declaration + "\n")
        eb.replace(selection.range, reply.metavariable)
      })
    } else {
      status("Failed to make a lemma for " + name + ".")
    }
  }
}

export const makeWith = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    await loadIfNot(client)
    const reply = await client.makeWith(name, line + 1)
    replaceLine(reply.withClause.trim(), line)
  }
}

export const proofSearch = (client: IdrisClient) => async () => {
  const selection = currentWord()
  if (selection) {
    const { name, line } = selection
    status("Solving for " + name + "...")
    await loadIfNot(client)
    const reply = await client.proofSearch(trimMeta(name), line + 1, [])
    if (reply.ok && reply.solution !== name) {
      replaceRange(reply.solution, selection.range)
    } else {
      status("Could not find a solution for " + name + ".")
    }
  }
}

export const version = (client: IdrisClient) => async () => {
  const { major, minor, patch, tags } = await client.version()
  const msg =
    "Idris version is " +
    major +
    "." +
    minor +
    "." +
    patch +
    (tags.length ? "-" + tags.join("-") : "")
  vscode.window.showInformationMessage(msg)
}
