// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { startArtLoop, type ArtLoop } from "~/lib/marketing/solve-art/loop"

const FRAME_MS = 20

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let now: number
let inWindow: (ratio: number) => void
let observedWith: IntersectionObserverInit | undefined
let hidden: boolean
let loop: ArtLoop | null

/** Art that has this many seconds to go to its rest. */
function fakeArt(toRest: number) {
  const art = {
    toRest,
    update: vi.fn((seconds: number) => {
      art.toRest = Math.max(0, art.toRest - seconds)
    }),
    draw: vi.fn(),
    resize: vi.fn(),
    secondsToRest: () => art.toRest,
  }
  return art
}

function runFrames(count: number) {
  for (let i = 0; i < count; i++) {
    now += FRAME_MS
    const due = [...frames.values()]
    frames.clear()
    for (const callback of due) callback(now)
  }
}

function setHidden(next: boolean) {
  hidden = next
  document.dispatchEvent(new Event("visibilitychange"))
}

const start = (art: Parameters<typeof startArtLoop>[1], options?: Parameters<typeof startArtLoop>[2]) => {
  loop = startArtLoop(document.createElement("canvas"), art, options)
  return loop
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  now = 0
  hidden = false
  loop = null
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal("performance", { now: () => now })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observedWith = options
        inWindow = (ratio) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      observe() {}
      disconnect() {}
    },
  )
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
})

afterEach(() => {
  loop?.stop()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, "hidden")
})

describe("art that has a rest", () => {
  test("goes on to its rest when it leaves the screen, then stops", () => {
    const art = fakeArt(0.2)
    start(art)
    inWindow(1)
    runFrames(1)
    const drawsOnScreen = art.draw.mock.calls.length

    inWindow(0)
    expect(frames.size).toBe(1)
    runFrames(4)
    expect(art.toRest).toBeGreaterThan(0)
    // There is no need for draws that nobody sees.
    expect(art.draw).toHaveBeenCalledTimes(drawsOnScreen)

    runFrames(6)
    expect(art.toRest).toBe(0)
    expect(frames.size).toBe(0)
    // The last frame shows the rest, for the moment the art comes back.
    expect(art.draw).toHaveBeenCalledTimes(drawsOnScreen + 1)
  })

  test("stops at once if it leaves the screen at a rest", () => {
    const art = fakeArt(0)
    start(art)
    inWindow(1)
    expect(frames.size).toBe(1)

    inWindow(0)

    expect(frames.size).toBe(0)
    expect(art.update).not.toHaveBeenCalled()
  })

  test("plays again when it comes back", () => {
    const art = fakeArt(0)
    start(art)
    inWindow(1)
    inWindow(0)

    inWindow(1)
    runFrames(2)

    expect(art.update).toHaveBeenCalledTimes(2)
  })

  test("plays on, with draws, if it comes back on its way to the rest", () => {
    const art = fakeArt(1)
    start(art)
    inWindow(1)
    inWindow(0)
    runFrames(2)
    art.draw.mockClear()

    inWindow(1)
    runFrames(2)

    expect(art.draw).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(1)
  })

  test("jumps to its rest when the page goes hidden, because a hidden page gets no frames", () => {
    const art = fakeArt(3)
    start(art)
    inWindow(1)
    art.draw.mockClear()

    setHidden(true)

    expect(art.update).toHaveBeenCalledWith(3)
    expect(art.toRest).toBe(0)
    expect(art.draw).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })

  test("plays again when the page comes back", () => {
    const art = fakeArt(3)
    start(art)
    inWindow(1)
    setHidden(true)
    art.update.mockClear()

    setHidden(false)
    runFrames(2)

    expect(art.update).toHaveBeenCalledTimes(2)
  })

  test("stays at its rest if the page comes back with the canvas off screen", () => {
    const art = fakeArt(3)
    start(art)
    inWindow(1)
    inWindow(0)
    setHidden(true)
    art.update.mockClear()

    setHidden(false)
    runFrames(2)

    expect(art.update).not.toHaveBeenCalled()
  })

  test("counts as off screen under the share that the art asks for", () => {
    const art = fakeArt(0)
    start(art, { seenShare: 0.2 })
    expect(observedWith?.threshold).toBe(0.2)

    inWindow(0.1)
    expect(frames.size).toBe(0)

    inWindow(0.2)
    expect(frames.size).toBe(1)

    inWindow(0.19)
    expect(frames.size).toBe(0)
  })
})

describe("the Pause button", () => {
  test("stops the art at once, with no wait for its rest", () => {
    const art = fakeArt(5)
    const { setPlaying } = start(art)
    inWindow(1)

    setPlaying(false)
    runFrames(3)

    expect(art.update).not.toHaveBeenCalled()
    expect(art.toRest).toBe(5)
    expect(frames.size).toBe(0)
  })

  test("keeps the art paused when it leaves the screen and comes back", () => {
    const art = fakeArt(5)
    const { setPlaying } = start(art)
    inWindow(1)
    setPlaying(false)

    inWindow(0)
    runFrames(3)
    inWindow(1)
    runFrames(3)

    expect(art.update).not.toHaveBeenCalled()
    expect(art.toRest).toBe(5)
  })

  test("keeps the art paused where it is when the page goes hidden and comes back", () => {
    const art = fakeArt(5)
    const { setPlaying } = start(art)
    inWindow(1)
    setPlaying(false)

    setHidden(true)
    setHidden(false)
    runFrames(3)

    expect(art.update).not.toHaveBeenCalled()
    expect(art.toRest).toBe(5)
  })

  test("stops an art that is on its way to a rest, and shows where it is", () => {
    const art = fakeArt(5)
    const { setPlaying } = start(art)
    inWindow(1)
    inWindow(0)
    runFrames(2)
    art.draw.mockClear()
    art.update.mockClear()

    setPlaying(false)
    runFrames(3)

    expect(art.draw).toHaveBeenCalledOnce()
    expect(art.update).not.toHaveBeenCalled()
  })

  test("Play on a screen goes on from the same place", () => {
    const art = fakeArt(5)
    const { setPlaying } = start(art)
    inWindow(1)
    setPlaying(false)

    setPlaying(true)
    runFrames(2)

    expect(art.update).toHaveBeenCalledTimes(2)
  })

  test("Play with the art off screen only takes it to its rest", () => {
    const art = fakeArt(0.04)
    const { setPlaying } = start(art)
    inWindow(1)
    setPlaying(false)
    inWindow(0)

    setPlaying(true)
    runFrames(5)

    expect(art.toRest).toBe(0)
    expect(frames.size).toBe(0)
  })
})

describe("art with no rest", () => {
  test("stops at once when it leaves the screen", () => {
    const art = { resize: vi.fn(), update: vi.fn(), draw: vi.fn() }
    start(art)
    inWindow(1)

    inWindow(0)
    runFrames(3)

    expect(frames.size).toBe(0)
    expect(art.update).not.toHaveBeenCalled()
  })
})

describe("after stop", () => {
  test("does nothing when the page changes", () => {
    const art = fakeArt(3)
    start(art).stop()
    art.draw.mockClear()

    setHidden(true)
    setHidden(false)
    runFrames(3)

    expect(art.update).not.toHaveBeenCalled()
    expect(art.draw).not.toHaveBeenCalled()
  })
})
