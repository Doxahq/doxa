// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { resolveSiteConfig } from "@doxahq/site-config"
import { afterEach, describe, expect, test } from "vitest"

import WriteEditor from "~/components/dashboard/content/write-editor/write-editor"
import { TooltipProvider } from "~/components/ui/tooltip"

afterEach(cleanup)

const theme = resolveSiteConfig({}).theme

async function renderEditor(status: "published" | "edited" | null) {
  render(
    <TooltipProvider delayDuration={0}>
      <WriteEditor
        value={"---\ntitle: Overview\n---\n\nText.\n"}
        onChange={() => undefined}
        onSave={() => undefined}
        page={{ href: "/overview", status }}
        showOutline={false}
        canvas={{ theme, mode: "light", onModeChange: () => undefined }}
      />
    </TooltipProvider>,
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe("the page strip in Write", () => {
  test("shows the slug with no status or version", async () => {
    await renderEditor("edited")
    expect(screen.getByText("/overview")).toBeTruthy()
    expect(screen.queryByText("Status")).toBeNull()
    expect(screen.queryByText("Version")).toBeNull()
    expect(screen.queryByText(/^v\d+$/)).toBeNull()
  })

  test("marks unpublished changes with a dot and a tooltip", async () => {
    await renderEditor("edited")
    const dot = screen.getByRole("img", { name: "Unpublished changes" })
    fireEvent.pointerMove(dot)
    expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Unpublished changes")
  })

  test("a published page has no dot", async () => {
    await renderEditor("published")
    expect(screen.queryByRole("img", { name: "Unpublished changes" })).toBeNull()
  })
})
