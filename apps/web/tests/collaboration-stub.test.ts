// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import * as collaboration from "@tiptap/extension-collaboration"
import { DragHandle } from "@tiptap/extension-drag-handle"
import * as yTiptap from "@tiptap/y-tiptap"
import { afterEach, describe, expect, test } from "vitest"

import * as stub from "~/lib/editor/collaboration-stub"
import { parseMdxDocument } from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(source: string) {
  const element = document.createElement("div")
  editor = new Editor({
    extensions: createWriteExtensions({}, [DragHandle.configure({ render: () => element })]),
    content: parseMdxDocument(source).content,
  })
  return editor
}

describe("the collaboration stub", () => {
  test("replaces the Yjs packages that the drag handle imports", () => {
    expect(yTiptap.ySyncPluginKey as unknown).toBe(stub.ySyncPluginKey)
    expect(collaboration.isChangeOrigin as unknown).toBe(stub.isChangeOrigin)
    // The type checker reads the real packages' types. The test run uses the alias.
    expect(yTiptap.absolutePositionToRelativePosition as unknown).toBe(stub.absolutePositionToRelativePosition)
    expect(yTiptap.relativePositionToAbsolutePosition as unknown).toBe(stub.relativePositionToAbsolutePosition)
    expect(() => stub.absolutePositionToRelativePosition()).toThrow(/not part of the Doxa editor build/)
    expect(() => stub.relativePositionToAbsolutePosition()).toThrow(/not part of the Doxa editor build/)
  })

  test("has no sync state and no change origin in the editor, so the drag handle maps positions itself", () => {
    const current = open("# Title\n\nFirst paragraph.\n\nSecond paragraph.\n")
    expect(stub.ySyncPluginKey.getState(current.state)).toBeUndefined()

    let origins = 0
    current.on("transaction", ({ transaction }) => {
      if (stub.isChangeOrigin(transaction)) origins += 1
    })
    current.commands.insertContentAt(1, "New ")
    current.view.dispatch(current.state.tr.setMeta("lockDragHandle", true))
    current.view.dispatch(current.state.tr.setMeta("hideDragHandle", true))
    expect(origins).toBe(0)
  })
})
