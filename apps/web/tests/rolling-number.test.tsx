// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { RollingNumber } from "~/components/dashboard/rolling-number"

afterEach(cleanup)

/** The offset of each digit column, left to right. */
function offsets(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[style]")].map((column) => column.style.transform)
}

describe("RollingNumber", () => {
  test("slides each digit column to its digit and keeps separators as text", () => {
    const { container } = render(<RollingNumber text="1,205" />)
    expect(offsets(container)).toEqual(["translateY(-1.25em)", "translateY(-2.5em)", "translateY(0em)", "translateY(-6.25em)"])
    expect(container.querySelector("[aria-hidden]")?.textContent).toContain(",")
    expect(container.querySelector(".sr-only")?.textContent).toBe("1,205")
  })

  test("a longer number keeps the existing columns: places key from the right", () => {
    const { container, rerender } = render(<RollingNumber text="999" />)
    const ones = container.querySelectorAll("[style]")[2]
    rerender(<RollingNumber text="1,000" />)
    const columns = container.querySelectorAll<HTMLElement>("[style]")
    // The same element now shows 0, so it rolls from 9 to 0 instead of mounting fresh.
    expect(columns[3]).toBe(ones)
    expect(columns[3]?.style.transform).toBe("translateY(0em)")
  })
})
