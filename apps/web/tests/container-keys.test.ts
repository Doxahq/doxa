// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, test } from "vitest"

import { parseMdxDocument } from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function open(source: string): Editor {
  editor = new Editor({ extensions: createWriteExtensions(), content: parseMdxDocument(source).content })
  return editor
}

/** Puts the cursor at the end of the last text inside the first node of `type`. */
function cursorAtEndOf(current: Editor, type: string) {
  let end = -1
  current.state.doc.descendants((node, pos) => {
    if (end !== -1) return false
    if (node.type.name === type) {
      end = pos + node.nodeSize - 1
      while (end > pos && !current.state.doc.resolve(end).parent.isTextblock) end -= 1
    }
    return true
  })
  current.commands.setTextSelection(end)
}

function press(current: Editor, key: string) {
  current.view.someProp("handleKeyDown", (handler) => handler(current.view, new KeyboardEvent("keydown", { key })))
}

function outline(current: Editor): string[] {
  const types: string[] = []
  current.state.doc.forEach((node) => {
    if (!(node.type.name === "paragraph" && node.content.size === 0 && node === current.state.doc.lastChild)) types.push(node.type.name)
  })
  return types
}

describe("leaving containers with Enter", () => {
  test("Enter twice at the end of a note leaves it", () => {
    const current = open('<Note title="Tip">\n\nKeep it short.\n\n</Note>\n\nAfter.\n')
    cursorAtEndOf(current, "callout")
    press(current, "Enter")
    press(current, "Enter")
    expect(current.state.selection.$from.depth).toBe(1)
    // The new line is the one right after the note, not the next paragraph.
    expect(current.state.selection.$from.index(0)).toBe(1)
    expect(current.state.selection.$from.parent.content.size).toBe(0)
    expect(current.state.doc.child(0).childCount).toBe(1)
    expect(outline(current)).toEqual(["callout", "paragraph", "paragraph"])
  })

  test("Enter twice at the end of a tab leaves the tab set", () => {
    const current = open('<Tabs defaultValue="a">\n  <TabsList>\n    <TabsTrigger value="a">A</TabsTrigger>\n  </TabsList>\n  <TabsContent value="a">\n    Text.\n  </TabsContent>\n</Tabs>\n')
    cursorAtEndOf(current, "tabItem")
    press(current, "Enter")
    press(current, "Enter")
    expect(current.state.selection.$from.depth).toBe(1)
    expect(current.state.doc.child(0).child(0).childCount).toBe(1)
  })

  test("Enter on an empty last step line starts a step, and again ends the steps", () => {
    const current = open('<Step>\n  <StepItem title="Install">\n    Add it.\n  </StepItem>\n</Step>\n')
    cursorAtEndOf(current, "stepBody")
    press(current, "Enter")
    press(current, "Enter")
    const steps = current.state.doc.child(0)
    expect(steps.childCount).toBe(2)
    expect(current.state.selection.$from.parent.type.name).toBe("stepTitle")
    press(current, "Enter")
    expect(current.state.doc.child(0).childCount).toBe(1)
    expect(current.state.selection.$from.depth).toBe(1)
  })
})
