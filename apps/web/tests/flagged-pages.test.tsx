// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { FlaggedPage } from "@doxahq/contracts/generation-reviews"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ReviewFlaggedPages } from "~/components/dashboard/content/review/review-flagged-pages"
import { GenerationFlaggedPages } from "~/components/dashboard/generation-flagged-pages"

afterEach(cleanup)

const kept: FlaggedPage = {
  pageId: "documentation/install",
  title: "Install",
  reason: "Overloaded",
  outcome: "kept_published",
  href: "/install",
}
const leftOut: FlaggedPage = {
  pageId: "documentation/webhooks",
  title: "Webhooks",
  reason: "Page failed validation after 3 attempts",
  outcome: "left_out",
  href: null,
}

describe("flagged pages", () => {
  test("the review opens a kept page and only lists a left-out page", () => {
    const onSelect = vi.fn()
    render(<ReviewFlaggedPages pages={[kept, leftOut]} focusHref={null} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: /Install/ }))
    expect(onSelect).toHaveBeenCalledWith("/install")
    expect(screen.queryByRole("button", { name: /Webhooks/ })).toBeNull()
    expect(screen.getByText("Webhooks").closest("li")?.getAttribute("title")).toBe(leftOut.reason)
    expect(screen.getByText("Not in this version")).toBeTruthy()
  })

  test("the generation page lists each page with what the version shows and why", () => {
    render(<GenerationFlaggedPages pages={[kept, leftOut]} />)

    expect(screen.getByText("2 pages could not be written")).toBeTruthy()
    expect(screen.getByText("Kept the published page")).toBeTruthy()
    expect(screen.getByText("Overloaded")).toBeTruthy()
  })

  test("nothing renders without flagged pages", () => {
    const { container } = render(<GenerationFlaggedPages pages={[]} />)
    expect(container.innerHTML).toBe("")
  })
})
