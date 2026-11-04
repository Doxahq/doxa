// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { HeroSolve } from "~/components/marketing/home/hero-solve"

const art = vi.hoisted(() => ({ attach: vi.fn(), stop: vi.fn() }))

vi.mock("~/lib/marketing/solve-art", () => ({ attachSolveArt: art.attach }))

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

function arrive() {
  act(() => reach([{ isIntersecting: true }]))
}

describe("HeroSolve", () => {
  test("centers the cube over the hero column and starts to play", () => {
    art.attach.mockImplementation(() => fakeArt())
    const { container } = render(<HeroSolve />)

    arrive()

    const [canvas, stage] = art.attach.mock.calls[0]
    expect(canvas).toBe(container.querySelector("canvas.hero__solve"))
    expect(canvas.getAttribute("aria-hidden")).toBe("true")
    expect(stage).toBe(container.querySelector(".hero__stage"))
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy()
  })

  test("the button pauses it and resumes it", async () => {
    art.attach.mockImplementation(() => fakeArt())
    render(<HeroSolve />)
    arrive()

    await userEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(art.attach.mock.results[0].value.playing).toBe(false)

    await userEvent.click(screen.getByRole("button", { name: "Play" }))
    expect(art.attach.mock.results[0].value.playing).toBe(true)
  })

  test("shows no button without WebGL2", () => {
    art.attach.mockReturnValue(null)
    render(<HeroSolve />)

    arrive()

    expect(art.attach).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button")).toBeNull()
  })

  test("stops the art when the hero goes away", () => {
    art.attach.mockImplementation(() => fakeArt())
    const { unmount } = render(<HeroSolve />)
    arrive()

    unmount()

    expect(art.stop).toHaveBeenCalledOnce()
  })
})
