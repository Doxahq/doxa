// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { describe, expect, test, vi } from "vitest"

import { useReviewRestore } from "~/lib/dashboard/use-review-restore"

const deleted: GenerationReviewPage = {
  href: "/pricing",
  branchHref: "/pricing",
  title: "Pricing",
  change: "removed",
  decision: "accepted",
  reasons: [],
  decidedAt: "2026-10-14T10:00:00.000Z",
}

function renderRestore(decide: (...args: unknown[]) => Promise<boolean>) {
  return renderHook(
    ({ editorPageHref }: { editorPageHref: string | null }) => useReviewRestore(deleted, editorPageHref, decide),
    { initialProps: { editorPageHref: "/install" as string | null } },
  )
}

describe("restore a review page in place", () => {
  test("keeps the page restoring until the editor shows it", async () => {
    const decide = vi.fn(async () => true)
    const { result, rerender } = renderRestore(decide)

    act(() => result.current.restore(deleted))
    expect(decide).toHaveBeenCalledWith(deleted, "rejected", { advance: false })
    // The editor still shows the page that was open, then loads the restored page.
    expect(result.current.isRestoring(deleted)).toBe(true)
    rerender({ editorPageHref: null })
    expect(result.current.isRestoring(deleted)).toBe(true)

    rerender({ editorPageHref: "/pricing" })
    expect(result.current.isRestoring(deleted)).toBe(false)
    // Opening another page later does not bring the restoring state back.
    rerender({ editorPageHref: "/install" })
    expect(result.current.isRestoring(deleted)).toBe(false)
  })

  test("stops restoring when the decision does not save", async () => {
    const { result } = renderRestore(async () => false)

    act(() => result.current.restore(deleted))
    await waitFor(() => expect(result.current.isRestoring(deleted)).toBe(false))
  })
})
