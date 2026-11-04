// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { AboutSolve } from "~/components/marketing/about/about-solve"

const art = vi.hoisted(() => ({
  attach: vi.fn(),
  stop: vi.fn(),
}))

vi.mock("~/lib/marketing/solve-art", () => ({ attachSolveArt: art.attach }))

/** The art as it attaches: it always starts to play. */
function fakeArt() {
  const value = {
    playing: true,
    setPlaying(next: boolean) {
      value.playing = next
    },
    stop: art.stop,
  }
  return value
}

let reach: (entries: Array<{ isIntersecting: boolean }>) => void

beforeEach(() => {
  art.attach.mockReset()
  art.stop.mockReset()
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof reach) {
        reach = callback
      }
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function comeNear() {
  await act(async () => {
    reach([{ isIntersecting: true }])
    await Promise.resolve()
  })
}

describe("AboutSolve", () => {
  test("shows no button before the art has drawn", () => {
    render(<AboutSolve />)

    expect(screen.queryByRole("button")).toBeNull()
  })

  test("shows the button as the only control, with no status label", async () => {
    art.attach.mockImplementation(() => fakeArt())
    render(<AboutSolve />)
    await comeNear()

    const button = await screen.findByRole("button", { name: "Pause" })
    expect(button.parentElement?.children).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/solving|in sync|code changed/i)
  })

  test("starts to play by itself, and the button pauses it and resumes it", async () => {
    art.attach.mockImplementation(() => fakeArt())
    render(<AboutSolve />)
    await comeNear()

    const pause = await screen.findByRole("button", { name: "Pause" })
    expect(art.attach.mock.results[0].value.playing).toBe(true)

    await userEvent.click(pause)
    expect(art.attach.mock.results[0].value.playing).toBe(false)

    await userEvent.click(screen.getByRole("button", { name: "Play" }))
    expect(art.attach.mock.results[0].value.playing).toBe(true)
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy()
  })

  test("keeps the controls hidden without WebGL2", async () => {
    art.attach.mockReturnValue(null)
    render(<AboutSolve />)
    await comeNear()

    await waitFor(() => expect(art.attach).toHaveBeenCalled())
    expect(screen.queryByRole("button")).toBeNull()
  })

  test("stops the art when the section goes away", async () => {
    art.attach.mockImplementation(() => fakeArt())
    const { unmount } = render(<AboutSolve />)
    await comeNear()
    await screen.findByRole("button", { name: "Pause" })

    unmount()

    expect(art.stop).toHaveBeenCalledOnce()
  })
})
