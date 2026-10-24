// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { resolveSiteConfig } from "@doxahq/site-config"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { parseSpy } = vi.hoisted(() => ({ parseSpy: vi.fn() }))

vi.mock("~/lib/editor/mdx-document", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/editor/mdx-document")>()
  parseSpy.mockImplementation(original.parseMdxDocument)
  return { ...original, parseMdxDocument: parseSpy }
})

import WriteEditor from "~/components/dashboard/content/write-editor/write-editor"
import { parseMdxDocumentCached } from "~/lib/editor/mdx-document-cache"

afterEach(cleanup)
beforeEach(() => {
  parseSpy.mockClear()
})

const theme = resolveSiteConfig({}).theme

/** A source no other test uses, so the shared memo cannot already hold it. */
let counter = 0
const unique = (body = "Some text.") => `---\ntitle: Page ${(counter += 1)}\n---\n\n${body}\n`

describe("the Write editor's parse memo", () => {
  test("parses the same source once", () => {
    const source = unique()
    const first = parseMdxDocumentCached(source)
    const second = parseMdxDocumentCached(source)
    expect(second).toBe(first)
    expect(parseSpy).toHaveBeenCalledTimes(1)
  })

  test("parses a different source", () => {
    parseMdxDocumentCached(unique("One."))
    parseMdxDocumentCached(unique("Two."))
    expect(parseSpy).toHaveBeenCalledTimes(2)
  })

  test("keeps the last eight sources, the most recently used last", () => {
    const sources = Array.from({ length: 8 }, () => unique())
    for (const source of sources) parseMdxDocumentCached(source)
    // Using the oldest one keeps it. The next oldest is dropped instead.
    parseMdxDocumentCached(sources[0]!)
    parseMdxDocumentCached(unique())
    parseSpy.mockClear()

    parseMdxDocumentCached(sources[0]!)
    expect(parseSpy).not.toHaveBeenCalled()
    parseMdxDocumentCached(sources[1]!)
    expect(parseSpy).toHaveBeenCalledTimes(1)
  })

  test("parses once when the editor mounts and renders again", async () => {
    const source = unique('<Note title="Tip">\n\nKeep it short.\n\n</Note>')
    const props = {
      value: source,
      onChange: () => undefined,
      onSave: () => undefined,
      page: { href: "/memo", status: null },
      showOutline: false,
      canvas: { theme, mode: "light" as const, onModeChange: () => undefined },
    }
    const view = render(<WriteEditor {...props} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    view.rerender(<WriteEditor {...props} showOutline />)
    view.rerender(<WriteEditor {...props} readOnly />)
    view.rerender(<WriteEditor {...props} />)
    expect(parseSpy).toHaveBeenCalledTimes(1)

    // Opening the same page again costs no parse.
    view.unmount()
    render(<WriteEditor {...props} />)
    expect(parseSpy).toHaveBeenCalledTimes(1)
  })

  test("the editor leaves the shared document unchanged", async () => {
    const source = unique("# Heading\n\n- one\n- two\n\n```ts\nconst a = 1\n```")
    const document = parseMdxDocumentCached(source)
    const before = JSON.stringify(document)
    const props = {
      value: source,
      onChange: () => undefined,
      onSave: () => undefined,
      page: { href: "/shared", status: null },
      showOutline: false,
      canvas: { theme, mode: "light" as const, onModeChange: () => undefined },
    }
    const view = render(<WriteEditor {...props} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    view.rerender(<WriteEditor {...props} value={unique("Other.")} />)
    view.rerender(<WriteEditor {...props} value={source} />)
    expect(JSON.stringify(document)).toBe(before)
  })
})
