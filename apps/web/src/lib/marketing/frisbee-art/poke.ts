import type { HandIndex } from "~/lib/marketing/frisbee-art/motion"

/** What a pointer found: a hand, and the way of the hit on the screen, with y up and a length of 1. */
export interface HandSpot {
  hand: HandIndex
  x: number
  y: number
}

/** A hand on the canvas, in CSS pixels: the ends of its middle line. */
export type HandLine = readonly [readonly [number, number], readonly [number, number]]

/** A hit near the middle of a hand has no clear way, so it goes down. */
const CENTER_PIXELS = 6

/** The hand under this point of the canvas, or null. `radius` is how far from its middle line a hand reaches. */
export function spotHand(x: number, y: number, lines: readonly [HandLine, HandLine], radius: number): HandSpot | null {
  let best: HandSpot | null = null
  let bestDistance = radius
  lines.forEach(([[ax, ay], [bx, by]], index) => {
    const dx = bx - ax
    const dy = by - ay
    const k = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    const toX = ax + dx * k - x
    const toY = ay + dy * k - y
    const distance = Math.hypot(toX, toY)
    if (distance > bestDistance) return
    bestDistance = distance
    // The hit pushes the hand away from the pointer. On the screen, y grows downward.
    best = distance < CENTER_PIXELS ? { hand: index as HandIndex, x: 0, y: -1 } : { hand: index as HandIndex, x: toX / distance, y: -toY / distance }
  })
  return best
}

const CLICKABLE = "a, button, input, select, textarea, label, summary, [role='button']"

/**
 * Listens on `host` for a pointer on a hand. The canvas stays out of the way of the page:
 * it takes no pointer events, and this code ignores anything over `content` and anything
 * that has its own click. Returns the way to stop.
 */
export function listenForPokes(options: {
  host: HTMLElement
  canvas: HTMLElement
  content: HTMLElement
  /** The hand at this point of the canvas, in CSS pixels. */
  find(x: number, y: number): HandSpot | null
  kick(spot: HandSpot): void
  /** False while the visitor has paused the art. */
  active(): boolean
}): () => void {
  const { host, canvas, content, find, kick, active } = options

  const spotOf = (event: PointerEvent) => {
    const target = event.target
    if (!active() || !(target instanceof Element) || content.contains(target) || target.closest(CLICKABLE)) return null
    const box = canvas.getBoundingClientRect()
    return find(event.clientX - box.left, event.clientY - box.top)
  }
  const moved = (event: PointerEvent) => {
    host.style.cursor = spotOf(event) ? "pointer" : ""
  }
  const left = () => {
    host.style.cursor = ""
  }
  const pressed = (event: PointerEvent) => {
    if (event.button !== 0) return
    const spot = spotOf(event)
    if (spot) kick(spot)
  }

  host.addEventListener("pointermove", moved)
  host.addEventListener("pointerleave", left)
  host.addEventListener("pointerdown", pressed)
  return () => {
    host.removeEventListener("pointermove", moved)
    host.removeEventListener("pointerleave", left)
    host.removeEventListener("pointerdown", pressed)
    left()
  }
}
