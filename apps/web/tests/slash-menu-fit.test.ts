// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, test } from "vitest"

import { BLOCK_COMMANDS, fitsHere } from "~/components/dashboard/content/write-editor/slash-menu"
import { captureOriginalBlocks, parseMdxDocument, serializeMdxDocument } from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function offered(source: string, inside: string): string[] {
  editor = new Editor({ extensions: createWriteExtensions(), content: parseMdxDocument(source).content })
  let cursor = -1
  editor.state.doc.descendants((node, pos) => {
    if (cursor === -1 && node.type.name === inside) cursor = pos + 1
    return cursor === -1
  })
  editor.commands.setTextSelection(inside === "doc" ? 1 : cursor + 1)
  return BLOCK_COMMANDS.filter((command) => fitsHere(editor!, command.node)).map((command) => command.id)
}

describe("the block menu offers what fits", () => {
  test("everything on a top-level line", () => {
    expect(offered("Text.\n", "doc")).toEqual(BLOCK_COMMANDS.map((command) => command.id))
  })

  test("no divider, table or component inside a note", () => {
    const ids = offered('<Note title="A">\n\nText.\n\n</Note>\n', "callout")
    expect(ids).toContain("bulleted-list")
    expect(ids).not.toContain("divider")
    expect(ids).not.toContain("table")
    expect(ids).not.toContain("note")
  })

  test("only text in a table cell", () => {
    expect(offered("| A |\n| - |\n| x |\n", "tableCell")).toEqual(["text"])
  })
})

describe("the Card command", () => {
  test("inserts one card written without a grid", () => {
    const document = parseMdxDocument("Intro.\n\n/\n")
    editor = new Editor({ extensions: createWriteExtensions(), content: document.content })
    const originals = captureOriginalBlocks(editor.getJSON())
    const slash = editor.state.doc.child(0).nodeSize + 1
    // The cursor sits after the typed "/", as when the menu opens.
    editor.commands.setTextSelection(slash + 1)
    BLOCK_COMMANDS.find((command) => command.id === "card")!.run(editor, { from: slash, to: slash + 1 })
    const saved = serializeMdxDocument(document, editor.getJSON(), originals, { title: "", description: "" })
    expect(saved).toBe('Intro.\n\n<Card title="Card title">\n  Describe this card.\n</Card>\n')
  })
})
