// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { getLazyDocsHighlighter } from "@doxahq/mdx-runtime/highlight-lazy"
import { afterEach, describe, expect, test, vi } from "vitest"

import MdxPreview from "~/components/dashboard/content/mdx-preview"
import { BlockPreviewFrame, BlockPreviewPlaceholder } from "~/components/dashboard/content/write-editor/block-preview-frame"
import { blockPreviewHeight, rememberBlockPreviewHeight } from "~/lib/editor/block-preview-heights"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

describe("a locked block's preview", () => {
  test("shows its placeholder on the first frame, then draws in the background", () => {
    const frames: string[] = []
    const placeholder = <span data-testid="placeholder" ref={(node) => void (node && frames.push("placeholder"))} />
    const view = render(<MdxPreview source={"Some **bold** text."} variant="block" placeholder={placeholder} />)

    expect(frames).toEqual(["placeholder"])
    expect(view.queryByTestId("placeholder")).toBeNull()
    expect(view.container.querySelector("strong")?.textContent).toBe("bold")
  })

  test("a page preview draws on its first frame, with no placeholder", () => {
    const frames: string[] = []
    const placeholder = <span ref={(node) => void (node && frames.push("placeholder"))} />
    const view = render(<MdxPreview source={"# Title\n\nBody."} placeholder={placeholder} />)

    expect(frames).toEqual([])
    expect(view.container.querySelector("h1")?.textContent).toBe("Title")
  })

  test("loads only the grammars of its own code fences", async () => {
    const lazy = await getLazyDocsHighlighter()
    const load = vi.spyOn(lazy, "load")
    const view = render(<MdxPreview source={"```rust\nfn main() {}\n```\n"} />)

    await waitFor(() => view.container.querySelector("[style*='--shiki-light']") !== null)
    expect(view.container.querySelector("pre")?.textContent).toContain("fn main()")
    expect(view.container.querySelector("[style*='--shiki-light']")).not.toBeNull()
    expect(new Set(load.mock.calls.flatMap(([languages]) => [...languages]))).toEqual(new Set(["rust"]))
  })
})

describe("block preview heights", () => {
  test("a source not drawn yet gets one line height per line of text", () => {
    expect(blockPreviewHeight("<Card title=\"A\" />")).toBe(28)
    expect(blockPreviewHeight("| a | b |\n| - | - |\n\n| 1 | 2 |")).toBe(84)
  })

  test("a source drawn before gets its drawn height", () => {
    rememberBlockPreviewHeight("<Drawn />", 143.5)
    expect(blockPreviewHeight("<Drawn />")).toBe(143.5)
    rememberBlockPreviewHeight("<Drawn />", Number.NaN)
    expect(blockPreviewHeight("<Drawn />")).toBe(143.5)
  })

  test("the frame records the drawn height, never the placeholder's", () => {
    const observers: { callback: ResizeObserverCallback; target: Element | null }[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { callback: ResizeObserverCallback; target: Element | null }
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, target: null }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.target = target
        }
        disconnect() {}
      },
    )
    const resize = (height: number) => {
      for (const { callback, target } of observers) {
        callback([{ target, contentRect: { height } } as unknown as ResizeObserverEntry], {} as ResizeObserver)
      }
    }

    const source = "<Measured />"
    const view = render(
      <BlockPreviewFrame source={source}>
        <BlockPreviewPlaceholder source={source} />
      </BlockPreviewFrame>,
    )
    expect((view.container.querySelector("[data-block-preview-placeholder]") as HTMLElement).style.height).toBe("28px")
    resize(500)
    expect(blockPreviewHeight(source)).toBe(28)

    view.rerender(
      <BlockPreviewFrame source={source}>
        <p>Drawn</p>
      </BlockPreviewFrame>,
    )
    resize(96)
    expect(blockPreviewHeight(source)).toBe(96)

    // The next placeholder for the same source holds that height.
    view.rerender(
      <BlockPreviewFrame source={source}>
        <BlockPreviewPlaceholder source={source} />
      </BlockPreviewFrame>,
    )
    expect((view.container.querySelector("[data-block-preview-placeholder]") as HTMLElement).style.height).toBe("96px")
    resize(10)
    expect(blockPreviewHeight(source)).toBe(96)
  })
})
