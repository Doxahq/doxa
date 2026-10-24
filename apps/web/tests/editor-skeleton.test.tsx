// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { EditorSkeleton, PreviewSkeleton, SourceSkeleton } from "~/components/dashboard/content/editor-skeleton"

afterEach(cleanup)

describe("the editor skeletons", () => {
  test("the Write skeleton announces the loading page and draws the outline", () => {
    const { container } = render(<EditorSkeleton />)
    expect(screen.getByRole("status").textContent).toContain("Loading page")
    expect(container.querySelector(".pt-\\[180px\\]")).not.toBeNull()
  })

  test("focus mode drops the outline, as the editor does", () => {
    const { container } = render(<EditorSkeleton showOutline={false} />)
    expect(container.querySelector(".pt-\\[180px\\]")).toBeNull()
  })

  test("every bar has an inline size, so it never depends on a generated class", () => {
    const { container } = render(<EditorSkeleton />)
    const bars = [...container.querySelectorAll("span.bg-muted")] as HTMLElement[]
    expect(bars.length).toBeGreaterThan(20)
    expect(bars.every((bar) => bar.style.width && bar.style.height)).toBe(true)
  })

  test("the Split panes announce the source and the preview", () => {
    render(
      <>
        <SourceSkeleton />
        <PreviewSkeleton />
      </>,
    )
    const labels = screen.getAllByRole("status").map((status) => status.textContent)
    expect(labels).toEqual([expect.stringContaining("Loading source"), expect.stringContaining("Loading preview")])
  })
})
