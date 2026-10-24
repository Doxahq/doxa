// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { whenPageSettles } from "~/lib/when-page-settles"

/** Stands in for the browser's PerformanceObserver. `finish()` reports a finished request. */
let observers: Array<() => void> = []
function finish() {
  for (const notify of observers) notify()
}

beforeEach(() => {
  vi.useFakeTimers()
  observers = []
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(private readonly notify: () => void) {}
      observe() {
        observers.push(this.notify)
      }
      disconnect() {
        observers = observers.filter((notify) => notify !== this.notify)
      }
    },
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("whenPageSettles", () => {
  test("waits until no request finishes for the quiet time", () => {
    const task = vi.fn()
    whenPageSettles(task, { quietMs: 1_000, maxWaitMs: 60_000 })

    vi.advanceTimersByTime(900)
    finish()
    vi.advanceTimersByTime(900)
    expect(task).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    expect(task).toHaveBeenCalledOnce()
  })

  test("runs at the maximum wait when requests never stop", () => {
    const task = vi.fn()
    whenPageSettles(task, { quietMs: 1_000, maxWaitMs: 5_000 })

    for (let elapsed = 0; elapsed < 5_000; elapsed += 500) {
      vi.advanceTimersByTime(500)
      finish()
    }
    vi.advanceTimersByTime(10)
    expect(task).toHaveBeenCalledOnce()
    expect(observers).toHaveLength(0)
  })

  test("waits for the load event", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
    const task = vi.fn()
    whenPageSettles(task, { quietMs: 1_000, maxWaitMs: 60_000 })

    vi.advanceTimersByTime(3_000)
    expect(task).not.toHaveBeenCalled()

    window.dispatchEvent(new Event("load"))
    vi.advanceTimersByTime(1_010)
    expect(task).toHaveBeenCalledOnce()
  })

  test("a cancelled task never runs", () => {
    const task = vi.fn()
    const cancel = whenPageSettles(task, { quietMs: 1_000, maxWaitMs: 5_000 })

    cancel()
    vi.advanceTimersByTime(10_000)
    expect(task).not.toHaveBeenCalled()
    expect(observers).toHaveLength(0)
  })
})
