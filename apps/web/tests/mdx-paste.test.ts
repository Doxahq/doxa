// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { parseRuntimeMdx } from "@doxahq/mdx-runtime"
import { afterEach, describe, expect, test } from "vitest"

import { captureOriginalBlocks, parseMdxDocument, serializeMdxDocument } from "~/lib/editor/mdx-document"
import { MdxPaste, looksLikeMdx, pastedContent } from "~/lib/editor/mdx-paste"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

/** Pastes plain text the way a browser does, through the editor's paste handlers. */
function paste(current: Editor, text: string): boolean {
  const event = { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") }, preventDefault: () => undefined }
  return Boolean(current.view.someProp("handlePaste", (handler) => handler(current.view, event as unknown as ClipboardEvent, current.state.selection.content())))
}

describe("MDX paste", () => {
  test("recognizes Markdown and MDX, and leaves prose alone", () => {
    expect(looksLikeMdx("## Setup\n\nRun it.")).toBe(true)
    expect(looksLikeMdx('<Note type="warning">\n\nCareful.\n\n</Note>')).toBe(true)
    expect(looksLikeMdx("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true)
    expect(looksLikeMdx("Just a sentence, with a < sign and #hashtag.")).toBe(false)
  })

  test("turns pasted MDX into blocks that save as written", () => {
    const source = "Intro.\n"
    const document = parseMdxDocument(source)
    editor = new Editor({ extensions: createWriteExtensions({}, [MdxPaste]), content: document.content })
    const originals = captureOriginalBlocks(editor.getJSON())
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.splitBlock()

    const pasted = ['## Install', "", '<Note title="Heads up" type="warning">', "", "Keep the key secret.", "", "</Note>", "", "- one", "- two"].join("\n")
    expect(paste(editor, pasted)).toBe(true)

    const types: string[] = []
    // The editor keeps an empty line at the end to type after the last block. It is not saved.
    editor.state.doc.forEach((node) => {
      if (!(node.type.name === "paragraph" && node.content.size === 0)) types.push(node.type.name)
    })
    expect(types).toEqual(["paragraph", "heading", "callout", "bulletList"])

    const saved = serializeMdxDocument(document, editor.getJSON(), originals, { title: "", description: "" })
    expect(parseRuntimeMdx(saved).nodes.slice(1)).toEqual(parseRuntimeMdx(pasted).nodes)
  })

  test("pastes inline Markdown into the line, and plain text as text", () => {
    editor = new Editor({ extensions: createWriteExtensions({}, [MdxPaste]), content: parseMdxDocument("Start: \n").content })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    expect(paste(editor, "a **bold** word")).toBe(true)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.getHTML()).toContain("<strong>bold</strong>")
    expect(paste(editor, "plain words only")).toBe(false)
  })

  test("never gives a pasted block the source of a block on the page", () => {
    const content = pastedContent("## A\n\nB\n")
    expect(content && "blocks" in content && content.blocks.every((block) => block.attrs?.blockId === undefined)).toBe(true)
  })
})
