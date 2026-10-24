// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, test } from "vitest"

import { LazyCodeEditor, preloadCodeEditor } from "~/components/code-editor/lazy-code-editor"

afterEach(cleanup)

beforeAll(() => {
  // jsdom has no layout. CodeMirror measures text ranges after it mounts.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})

const noop = () => undefined

async function settle() {
  await act(async () => {
    for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

describe("the lazily loaded code editor", () => {
  test("holds the editor's place with an empty box of the same size and color, then shows the editor", async () => {
    const view = render(
      <div style={{ height: 200 }}>
        <LazyCodeEditor value="# Title" onChange={noop} onSave={noop} language="mdx" ariaLabel="MDX block source" />
      </div>,
    )

    const placeholder = view.container.querySelector("[data-code-editor-placeholder]")
    expect(placeholder).not.toBeNull()
    // The same classes as the editor's host, and the MDX editor's background.
    expect(placeholder?.className.split(" ").sort()).toEqual(["bg-editor", "h-full", "min-h-0", "overflow-hidden"])
    expect(placeholder?.textContent).toBe("")
    // No spinner or other loading state.
    expect(placeholder?.querySelector("svg")).toBeNull()

    await settle()
    expect(view.container.querySelector("[data-code-editor-placeholder]")).toBeNull()
    const editor = view.container.querySelector(".cm-editor")
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain("# Title")
    expect(view.container.querySelector("[aria-label='MDX block source']")).not.toBeNull()
  })

  test("a plain editor has no background of its own", async () => {
    const view = render(<LazyCodeEditor value="graph TD" onChange={noop} onSave={noop} language="plain" />)
    const placeholder = view.container.querySelector("[data-code-editor-placeholder]")
    expect(placeholder?.className.split(" ").sort()).toEqual(["h-full", "min-h-0", "overflow-hidden"])
    await settle()
    expect(view.container.querySelector(".cm-editor")?.textContent).toContain("graph TD")
  })

  test("passes edits through", async () => {
    let latest = ""
    const view = render(
      <LazyCodeEditor value="a" onChange={(next) => (latest = next)} onSave={noop} language="plain" />,
    )
    await settle()
    const content = view.container.querySelector(".cm-content")
    expect(content).not.toBeNull()
    const { EditorView } = await import("@codemirror/view")
    const editorView = EditorView.findFromDOM(view.container.querySelector(".cm-editor") as HTMLElement)
    act(() => editorView?.dispatch({ changes: { from: 1, insert: "b" } }))
    expect(latest).toBe("ab")
  })

  test("preloading is safe to repeat", async () => {
    preloadCodeEditor("mdx")
    preloadCodeEditor("mdx")
    preloadCodeEditor("plain")
    await settle()
    const view = render(<LazyCodeEditor value="x" onChange={noop} onSave={noop} language="mdx" />)
    await settle()
    expect(view.container.querySelectorAll(".cm-editor")).toHaveLength(1)
  })
})
