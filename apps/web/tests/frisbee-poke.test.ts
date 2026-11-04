// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { listenForPokes, spotHand, type HandLine, type HandSpot } from "~/lib/marketing/frisbee-art/poke"

const LEFT: HandLine = [
  [100, 200],
  [200, 200],
]
const RIGHT: HandLine = [
  [900, 200],
  [800, 200],
]

describe("spotHand", () => {
  test("finds a hand near its middle line, and nothing far from it", () => {
    expect(spotHand(150, 220, [LEFT, RIGHT], 40)?.hand).toBe(0)
    expect(spotHand(850, 180, [LEFT, RIGHT], 40)?.hand).toBe(1)
    expect(spotHand(150, 300, [LEFT, RIGHT], 40)).toBeNull()
    expect(spotHand(500, 200, [LEFT, RIGHT], 40)).toBeNull()
  })

  test("a hit pushes the hand away from the pointer", () => {
    // From above: the pointer is at a smaller y on the screen, so the hand goes down.
    const above = spotHand(150, 180, [LEFT, RIGHT], 40) as HandSpot
    expect(above.x).toBeCloseTo(0)
    expect(above.y).toBeCloseTo(-1)
    const below = spotHand(150, 220, [LEFT, RIGHT], 40) as HandSpot
    expect(below.y).toBeCloseTo(1)
    // From past the end of the hand.
    const beyond = spotHand(70, 200, [LEFT, RIGHT], 40) as HandSpot
    expect(beyond.x).toBeCloseTo(1)
    expect(beyond.y).toBeCloseTo(0)
  })

  test("a hit on the middle of the hand knocks it down", () => {
    expect(spotHand(150, 201, [LEFT, RIGHT], 40)).toEqual({ hand: 0, x: 0, y: -1 })
  })

  test("takes the nearer hand when both are in reach", () => {
    const close: HandLine = [
      [230, 200],
      [330, 200],
    ]
    expect(spotHand(205, 200, [LEFT, close], 40)?.hand).toBe(0)
    expect(spotHand(226, 200, [LEFT, close], 40)?.hand).toBe(1)
  })
})

describe("listenForPokes", () => {
  let host: HTMLElement
  let content: HTMLElement
  let link: HTMLElement
  let canvas: HTMLElement
  let kick: ReturnType<typeof vi.fn>
  let active: boolean
  let stop: () => void
  const HAND: HandSpot = { hand: 1, x: 0, y: -1 }

  /** The hand is at (50, 60) on the canvas. The canvas starts at (10, 20) on the page. */
  const find = (x: number, y: number) => (Math.hypot(x - 50, y - 60) < 20 ? HAND : null)

  const pointer = (target: Element, type: string, clientX: number, clientY: number, button = 0) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY, button }))

  beforeEach(() => {
    document.body.innerHTML = `<header id="host"><canvas id="art"></canvas><a id="link" href="#">Log in</a><div id="content"><p>Copy</p></div></header>`
    host = document.getElementById("host") as HTMLElement
    content = document.getElementById("content") as HTMLElement
    link = document.getElementById("link") as HTMLElement
    canvas = document.getElementById("art") as HTMLElement
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 800, height: 400 } as DOMRect)
    kick = vi.fn()
    active = true
    stop = listenForPokes({ host, canvas, content, find, kick, active: () => active })
  })

  afterEach(() => {
    stop()
    vi.restoreAllMocks()
    document.body.innerHTML = ""
  })

  test("a press on a hand kicks it, in canvas pixels", () => {
    pointer(host, "pointerdown", 60, 80)
    expect(kick).toHaveBeenCalledOnce()
    expect(kick).toHaveBeenCalledWith(HAND)
  })

  test("a press beside a hand does nothing", () => {
    pointer(host, "pointerdown", 400, 300)
    expect(kick).not.toHaveBeenCalled()
  })

  test("only the main button counts", () => {
    pointer(host, "pointerdown", 60, 80, 2)
    expect(kick).not.toHaveBeenCalled()
  })

  test("the page keeps its own clicks: content and links are never a hand", () => {
    pointer(content.querySelector("p") as Element, "pointerdown", 60, 80)
    pointer(link, "pointerdown", 60, 80)
    expect(kick).not.toHaveBeenCalled()
  })

  test("a paused art takes no kicks", () => {
    active = false
    pointer(host, "pointerdown", 60, 80)
    expect(kick).not.toHaveBeenCalled()
    pointer(host, "pointermove", 60, 80)
    expect(host.style.cursor).toBe("")
  })

  test("the pointer shows a hand can be clicked, and only over a hand", () => {
    pointer(host, "pointermove", 60, 80)
    expect(host.style.cursor).toBe("pointer")
    pointer(host, "pointermove", 400, 300)
    expect(host.style.cursor).toBe("")
    pointer(host, "pointermove", 60, 80)
    host.dispatchEvent(new MouseEvent("pointerleave"))
    expect(host.style.cursor).toBe("")
  })

  test("stops when the art goes away", () => {
    pointer(host, "pointermove", 60, 80)
    stop()
    expect(host.style.cursor).toBe("")
    pointer(host, "pointerdown", 60, 80)
    expect(kick).not.toHaveBeenCalled()
  })
})
