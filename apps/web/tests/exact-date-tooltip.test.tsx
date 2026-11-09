// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { ExactDateTooltip, RelativeDate } from "~/components/dashboard/exact-date-tooltip"
import { formatExactDate, formatRelativeAge } from "~/lib/dashboard/relative-time"

const DATE = "2026-11-03T14:05:09Z"

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

describe("formatExactDate", () => {
  test("gives the year and the time to the second", () => {
    const exact = formatExactDate(DATE)
    expect(exact).toContain("2026")
    expect(exact).toContain(":05:09")
  })
})

describe("RelativeDate", () => {
  test("shows the relative text and keeps the machine date", () => {
    const { container } = render(<RelativeDate date={DATE} />)
    const time = container.querySelector("time")
    expect(time?.getAttribute("datetime")).toBe(DATE)
    expect(time?.textContent).toBe(formatRelativeAge(DATE))
  })

  test("shows the exact date in a tooltip on hover", async () => {
    render(<ExactDateTooltip date={DATE}>Edited recently</ExactDateTooltip>)
    expect(screen.queryByRole("tooltip")).toBeNull()

    await userEvent.hover(screen.getByText("Edited recently"))

    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip.textContent).toBe(formatExactDate(DATE))
  })
})
