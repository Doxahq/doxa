// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import {
  useTrackPageRevision,
  type LoadedPageSource,
  type PageRevisions,
} from "~/lib/dashboard/use-track-page-revision"

const KEY = "main:/guide"

function loaded(value: string, revision: number): LoadedPageSource {
  return { key: KEY, value, revision }
}

interface Props {
  loaded: LoadedPageSource | null
  saved: string
  isDirty: boolean
  enabled?: boolean
}

function track(initial: Props) {
  const revisions: PageRevisions = new Map()
  const replaceClean = vi.fn()
  const view = renderHook(
    ({ loaded: page, saved, isDirty, enabled = true }: Props) =>
      useTrackPageRevision({ enabled, revisions, loaded: page, buffer: { key: KEY, saved, isDirty, replaceClean } }),
    { initialProps: initial },
  )
  return { revisions, replaceClean, rerender: view.rerender }
}

describe("useTrackPageRevision", () => {
  test("starts from the revision of the first load", () => {
    const { revisions } = track({ loaded: loaded("one", 3), saved: "one", isDirty: false })
    expect(revisions.get(KEY)).toBe(3)
  })

  test("takes a newer revision when the text of this page did not change", () => {
    const { revisions, replaceClean, rerender } = track({ loaded: loaded("one", 3), saved: "one", isDirty: true })
    rerender({ loaded: loaded("one", 4), saved: "one", isDirty: true })
    expect(revisions.get(KEY)).toBe(4)
    expect(replaceClean).not.toHaveBeenCalled()
  })

  test("takes new text and its revision when there are no unsaved edits", () => {
    const { revisions, replaceClean, rerender } = track({ loaded: loaded("one", 3), saved: "one", isDirty: false })
    rerender({ loaded: loaded("agent text", 4), saved: "one", isDirty: false })
    expect(replaceClean).toHaveBeenCalledWith(KEY, "agent text")
    expect(revisions.get(KEY)).toBe(4)
  })

  test("keeps the old revision over unsaved edits, so that the save is refused", () => {
    const { revisions, replaceClean, rerender } = track({ loaded: loaded("one", 3), saved: "one", isDirty: true })
    rerender({ loaded: loaded("agent text", 4), saved: "one", isDirty: true })
    expect(revisions.get(KEY)).toBe(3)
    expect(replaceClean).not.toHaveBeenCalled()
  })

  test("loads the newer text once the unsaved edits are undone", () => {
    const { revisions, replaceClean, rerender } = track({ loaded: loaded("one", 3), saved: "one", isDirty: true })
    rerender({ loaded: loaded("agent text", 4), saved: "one", isDirty: true })
    rerender({ loaded: loaded("agent text", 4), saved: "one", isDirty: false })
    expect(replaceClean).toHaveBeenCalledWith(KEY, "agent text")
    expect(revisions.get(KEY)).toBe(4)
  })

  test("ignores a slow answer from before the last save", () => {
    const { revisions, replaceClean, rerender } = track({ loaded: loaded("saved", 5), saved: "saved", isDirty: false })
    rerender({ loaded: loaded("older", 4), saved: "saved", isDirty: false })
    expect(revisions.get(KEY)).toBe(5)
    expect(replaceClean).not.toHaveBeenCalled()
  })

  test("does nothing when the guard is off", () => {
    const { revisions } = track({ loaded: loaded("one", 3), saved: "one", isDirty: false, enabled: false })
    expect(revisions.size).toBe(0)
  })
})
