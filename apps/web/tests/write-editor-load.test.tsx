// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { resolveSiteConfig } from "@doxahq/site-config"
import { afterEach, describe, expect, test, vi } from "vitest"

import WriteEditor from "~/components/dashboard/content/write-editor/write-editor"

afterEach(cleanup)

const theme = resolveSiteConfig({}).theme

const SOURCE = [
  "---",
  "title: Loaded",
  "---",
  "",
  '<Note title="Tip">',
  "",
  "Keep it short.",
  "",
  "</Note>",
  "",
  "* A list written with stars.",
  "",
].join("\n")

describe("opening a page in Write", () => {
  // PRODUCTION REGRESSION: an update event sent while the editor loaded (from
  // `setEditable`) came before the loaded blocks were recorded, so every
  // block was written again and an untouched page was saved reformatted.
  test("does not change an untouched page", async () => {
    const onChange = vi.fn()
    const props = {
      value: SOURCE,
      onChange,
      onSave: () => undefined,
      page: { href: "/loaded", status: null },
      showOutline: false,
      canvas: { theme, mode: "light" as const, onModeChange: () => undefined },
    }
    const view = render(<WriteEditor {...props} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    view.rerender(<WriteEditor {...props} readOnly />)
    view.rerender(<WriteEditor {...props} readOnly={false} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  // REGRESSION: a reload replaces the whole page, and the selection landed on
  // the last block. A page that ends with cards showed them as selected.
  test("selects no block after a new source from outside", async () => {
    const withCards = (text: string) =>
      `---\ntitle: Cards\n---\n\n${text}\n\n<CardGrid>\n  <Card title="One" description="First" href="/one" />\n</CardGrid>\n`
    const props = {
      onChange: () => undefined,
      onSave: () => undefined,
      page: { href: "/cards", status: null },
      showOutline: false,
      canvas: { theme, mode: "light" as const, onModeChange: () => undefined },
      readOnly: true,
    }
    const view = render(<WriteEditor {...props} value={withCards("Before.")} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    view.rerender(<WriteEditor {...props} value={withCards("After.")} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(document.querySelector(".doxa-write-content")?.textContent).toContain("After.")
    expect(document.querySelector(".doxa-card-group")).not.toBeNull()
    expect(document.querySelector(".doxa-card-group[data-selected]")).toBeNull()
  })
})
