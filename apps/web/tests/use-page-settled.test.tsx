// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const settle = vi.hoisted(() => ({
  tasks: [] as Array<() => void>,
  cancelled: 0,
}))

vi.mock("~/lib/when-page-settles", () => ({
  whenPageSettles: (task: () => void) => {
    settle.tasks.push(task)
    return () => {
      settle.cancelled += 1
    }
  },
}))

const { resetPageSettledForTests, usePageSettled } = await import("~/lib/dashboard/use-page-settled")

beforeEach(() => {
  settle.tasks = []
  settle.cancelled = 0
  resetPageSettledForTests()
})

afterEach(cleanup)

describe("usePageSettled", () => {
  test("is false until the page settles, then true", () => {
    const hook = renderHook(() => usePageSettled())
    expect(hook.result.current).toBe(false)
    expect(settle.tasks).toHaveLength(1)

    act(() => settle.tasks[0]())
    expect(hook.result.current).toBe(true)
  })

  test("a component that mounts after the page settled starts true, with no new wait", () => {
    const first = renderHook(() => usePageSettled())
    act(() => settle.tasks[0]())
    expect(first.result.current).toBe(true)

    const later = renderHook(() => usePageSettled())
    expect(later.result.current).toBe(true)
    expect(settle.tasks).toHaveLength(1)
  })

  test("an unmount before the page settles cancels the wait", () => {
    const hook = renderHook(() => usePageSettled())
    hook.unmount()
    expect(settle.cancelled).toBe(1)
  })
})
