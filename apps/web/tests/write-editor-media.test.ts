// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { parseRuntimeMdx, type RuntimeMdxElementNode, type RuntimeMdxNode } from "@doxahq/mdx-runtime"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { altTextFromFileName, imageFiles } from "~/lib/editor/image-file"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"

import { releaseBlockSelection } from "~/lib/editor/block-selection"
import { createImageUpload, uploadIntoImage, type ImageUploader } from "~/lib/editor/image-upload"
import { captureOriginalBlocks, parseMdxDocument, serializeMdxDocument } from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

const editors: Editor[] = []
afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

function load(source: string, uploader: ImageUploader | null = null) {
  const document = parseMdxDocument(source)
  const editor = new Editor({
    extensions: createWriteExtensions({}, [createImageUpload({ getUploader: () => uploader })]),
    content: document.content,
  })
  editors.push(editor)
  const originals = captureOriginalBlocks(editor.getJSON())
  const save = () =>
    serializeMdxDocument(document, editor.getJSON(), originals, {
      title: document.title,
      description: document.description,
    })
  return { editor, save }
}

function topTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map((node) => node.type ?? "")
}

function elements(nodes: readonly RuntimeMdxNode[]): RuntimeMdxElementNode[] {
  return nodes.flatMap((node) => (node.type === "element" ? [node, ...elements(node.children ?? [])] : []))
}

function imagePosition(editor: Editor): number {
  let position = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") position = pos
    return position === -1
  })
  return position
}

function imageAttrs(editor: Editor): Record<string, unknown> {
  return editor.state.doc.nodeAt(imagePosition(editor))?.attrs ?? {}
}

/** A GIF is uploaded as it is, without the canvas re-encoding jsdom lacks. */
function gif(name: string): File {
  return new File(["GIF89a"], name, { type: "image/gif" })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeAll(() => {
  URL.createObjectURL ??= () => "blob:preview"
  URL.revokeObjectURL ??= () => {}
})

const PAGE = `---
title: Media
---

Intro.

![Rate limits](/assets/rate-limits.png "Limits")

<Embed url="https://youtu.be/dQw4w9WgXcQ" />
`

describe("images in Write", () => {
  test("an image alone on its line loads as an image block and saves back unchanged", () => {
    const { editor, save } = load(PAGE)

    expect(topTypes(editor)).toEqual(["paragraph", "image", "embed"])
    expect(editor.getJSON().content?.[1]?.attrs).toMatchObject({
      src: "/assets/rate-limits.png",
      alt: "Rate limits",
      title: "Limits",
    })
    expect(save()).toBe(PAGE)
  })

  test("an edited image is written as Markdown that the renderer draws", () => {
    const { editor, save } = load(PAGE)
    let position = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") position = pos
    })
    editor.commands.command(({ tr }) => {
      tr.setNodeMarkup(position, undefined, { src: "/assets/rate-limits.png", alt: "New [alt]", title: null })
      return true
    })

    const saved = save()
    expect(saved).toContain("![New \\[alt\\]](/assets/rate-limits.png)")
    const image = elements(parseRuntimeMdx(saved).nodes).find((node) => node.name === "img")
    expect(image?.props).toMatchObject({ src: "/assets/rate-limits.png", alt: "New [alt]" })
  })

  test("an image that is still uploading is not saved", () => {
    const { editor, save } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "image",
      attrs: { src: "", alt: "", uploadId: "pending" },
    })

    expect(save()).toBe("Intro.\n")
  })

  test("an empty image waiting for a file is not saved", () => {
    const { editor, save } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "image", attrs: { src: "" } })

    expect(save()).toBe("Intro.\n")
  })

  test("a file uploaded into an empty image fills it, with the file name as alt text", async () => {
    const uploaded = deferred<{ path: string }>()
    const { editor, save } = load("Intro.\n", { upload: () => uploaded.promise, onError: vi.fn() })
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "image", attrs: { src: "" } })

    expect(uploadIntoImage(editor, imagePosition(editor), [gif("team-photo.gif")])).toBe(true)
    expect(imageAttrs(editor)).toMatchObject({ src: "", alt: "team photo" })
    expect(imageAttrs(editor).uploadId).toEqual(expect.any(String))

    uploaded.resolve({ path: "/assets/team-photo.gif" })
    await vi.waitFor(() => expect(imageAttrs(editor).uploadId).toBeNull())
    expect(save()).toBe("Intro.\n\n![team photo](/assets/team-photo.gif)\n")
  })

  test("a replaced image goes back to the old file when the upload fails", async () => {
    const onError = vi.fn()
    const { editor, save } = load("![Old](/assets/old.png)\n", {
      upload: () => Promise.reject(new Error("offline")),
      onError,
    })

    expect(uploadIntoImage(editor, imagePosition(editor), [gif("new.gif")])).toBe(true)
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(imageAttrs(editor)).toMatchObject({ src: "/assets/old.png", alt: "Old", uploadId: null })
    expect(save()).toBe("![Old](/assets/old.png)\n")
  })

  test("an image in a line of text or with a relative source stays a locked block", () => {
    expect(topTypes(load("Look: ![a](/assets/a.png) here.\n").editor)).toEqual(["mdxBlock"])
    expect(topTypes(load("![a](images/a.png)\n").editor)).toEqual(["mdxBlock"])
  })

  test("an image inside a note loads into the note", () => {
    const source = '<Note title="See">\n  ![Diagram](/assets/diagram.png)\n</Note>\n'
    const { editor, save } = load(source)

    expect(topTypes(editor)).toEqual(["callout"])
    expect(editor.getJSON().content?.[0]?.content?.[0]?.type).toBe("image")
    expect(save()).toBe(source)
  })
})

describe("video embeds in Write", () => {
  test("a new embed saves as <Embed> with its url", () => {
    const { editor, save } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "embed",
      attrs: { attributes: [{ name: "url", value: "https://www.loom.com/share/0123456789abcdef0123456789abcdef" }] },
    })

    const saved = save()
    expect(saved).toBe('Intro.\n\n<Embed url="https://www.loom.com/share/0123456789abcdef0123456789abcdef" />\n')
    expect(elements(parseRuntimeMdx(saved).nodes).some((node) => node.name === "Embed")).toBe(true)
  })

  test("an embed waiting for its link is not saved", () => {
    const { editor, save } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "embed", attrs: { attributes: [] } })

    expect(save()).toBe("Intro.\n")
  })

  test("an <Embed> with children stays a locked block", () => {
    expect(topTypes(load('<Embed url="https://youtu.be/dQw4w9WgXcQ">\n  Text\n</Embed>\n').editor)).toEqual([
      "mdxBlock",
    ])
  })
})

describe("image files", () => {
  test("keeps only the image types a page can hold", () => {
    const files = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.heic", { type: "image/heic" }),
      new File(["c"], "c.txt", { type: "text/plain" }),
      new File(["d"], "d.svg", { type: "image/svg+xml" }),
    ]
    expect(imageFiles(files).map((file) => file.name)).toEqual(["a.png", "d.svg"])
  })

  test.each([
    ["rate-limits_diagram.png", "rate limits diagram"],
    ["image.png", ""],
    ["Screenshot 2026-10-07 at 23.48.03.png", ""],
    ["Screen Shot 2026-10-07.png", ""],
  ])("alt text for %j is %j", (name, alt) => {
    expect(altTextFromFileName(name)).toBe(alt)
  })
})

describe("letting go of a selected block", () => {
  test("a selected video becomes a text cursor after it, out of the undo history", () => {
    const { editor, save } = load('Intro.\n\n<Embed url="https://youtu.be/dQw4w9WgXcQ" />\n\nAfter.\n')
    let position = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "embed") position = pos
    })
    editor.commands.setNodeSelection(position)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)

    expect(releaseBlockSelection(editor)).toBe(true)
    expect(editor.state.selection).toBeInstanceOf(TextSelection)
    expect(editor.state.selection.from).toBeGreaterThan(position)
    expect(editor.can().undo()).toBe(false)
    expect(save()).toBe('Intro.\n\n<Embed url="https://youtu.be/dQw4w9WgXcQ" />\n\nAfter.\n')
  })

  test("a text selection stays", () => {
    const { editor } = load("Some text.\n")
    editor.commands.setTextSelection({ from: 1, to: 5 })

    expect(releaseBlockSelection(editor)).toBe(false)
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(5)
  })
})
