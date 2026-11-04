// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { HeroFrisbee } from "~/components/marketing/about/hero-frisbee"

const art = vi.hoisted(() => ({ attach: vi.fn(), stop: vi.fn() }))

vi.mock("~/lib/marketing/frisbee-art", () => ({ attachFrisbeeArt: art.attach }))

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

/** Sets the window width that the media query sees, and returns a way to change it. */
function windowIs(wide: boolean) {
  const listeners = new Set<() => void>()
  const media = {
    matches: wide,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal("matchMedia", () => media)
  return (next: boolean) => {
    media.matches = next
    for (const listener of listeners) listener()
  }
}

function hero() {
  return render(
    <header>
      <HeroFrisbee />
      <div className="ab-hero" />
    </header>,
  )
}

beforeEach(() => {
  art.attach.mockReset()
  art.stop.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("HeroFrisbee", () => {
  test("starts to play by itself on a wide window, beside the hero content", async () => {
    windowIs(true)
    art.attach.mockImplementation(() => fakeArt())
    const { container } = hero()

    await screen.findByRole("button", { name: "Pause" })
    expect(art.attach).toHaveBeenCalledOnce()
    const [canvas, content] = art.attach.mock.calls[0]
    expect(canvas).toBe(container.querySelector("canvas.hero__frisbee"))
    expect(canvas.getAttribute("aria-hidden")).toBe("true")
    expect(content).toBe(container.querySelector(".ab-hero"))
  })

  test("the button pauses it and resumes it", async () => {
    windowIs(true)
    art.attach.mockImplementation(() => fakeArt())
    hero()

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }))
    expect(art.attach.mock.results[0].value.playing).toBe(false)

    await userEvent.click(screen.getByRole("button", { name: "Play" }))
    expect(art.attach.mock.results[0].value.playing).toBe(true)
  })

  test("loads nothing on a narrow window, and starts if the window grows", async () => {
    const resize = windowIs(false)
    art.attach.mockImplementation(() => fakeArt())
    hero()

    await act(async () => {
      await Promise.resolve()
    })
    expect(art.attach).not.toHaveBeenCalled()
    expect(screen.queryByRole("button")).toBeNull()

    act(() => resize(true))
    await waitFor(() => expect(art.attach).toHaveBeenCalledOnce())
  })

  test("shows no button without WebGL2", async () => {
    windowIs(true)
    art.attach.mockReturnValue(null)
    hero()

    await waitFor(() => expect(art.attach).toHaveBeenCalled())
    expect(screen.queryByRole("button")).toBeNull()
  })

  test("stops the art when the hero goes away", async () => {
    windowIs(true)
    art.attach.mockImplementation(() => fakeArt())
    const { unmount } = hero()
    await screen.findByRole("button", { name: "Pause" })

    unmount()

    expect(art.stop).toHaveBeenCalledOnce()
  })
})
