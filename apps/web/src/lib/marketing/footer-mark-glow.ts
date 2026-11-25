import type { PixelCell } from "~/lib/marketing/footer-mark"

/** The radius of the glow around the cursor, in cells. */
const GLOW_RADIUS = 6.5
/** The time for a lit cell to fade to about a third of its light, in milliseconds. */
const FADE_MS = 420
/** A cell with less light than this is dark again. */
const MIN_LIGHT = 0.02
/** The largest share of a cell that a fully lit pixel fills. */
const LIT_PIXEL_SIZE = 0.94
/** The peak opacity of each tone at full light. Edge cells cover less of the glyph, so they glow less. */
const TONE_STRENGTH: Readonly<Record<PixelCell["tone"], number>> = { solid: 0.85, edge: 0.45, spark: 1 }

type GlowOptions = {
  canvas: HTMLCanvasElement
  /** The element that receives the pointer events. */
  surface: HTMLElement
  cells: readonly PixelCell[]
  cols: number
  rows: number
  /** The share of a cell that an unlit pixel fills. */
  pixelSize: number
}

/**
 * Lights the footer pixels near the cursor. The cells under the cursor swell into the gaps
 * and turn the ice accent, then fade out, so a quick move leaves a short trail.
 * The canvas draws only the lit cells on top of the SVG, and the loop stops when all cells are dark.
 * Returns the cleanup function.
 */
export function startFooterGlow({ canvas, surface, cells, cols, rows, pixelSize }: GlowOptions): () => void {
  const context = canvas.getContext("2d")
  if (!context) return () => {}

  const light = new Float32Array(cells.length)
  let cellPx = 0
  let color = "156 194 255"
  let frame = 0
  let lastTime = 0

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(rect.height * ratio)
    cellPx = (rect.width * ratio) / cols
    color = getComputedStyle(canvas).getPropertyValue("--ice-rgb").trim() || color
    draw()
  }

  function lightAround(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    const px = ((clientX - rect.left) / rect.width) * cols
    const py = ((clientY - rect.top) / rect.height) * rows
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      const distance = Math.hypot(cell.x + 0.5 - px, cell.y + 0.5 - py)
      if (distance >= GLOW_RADIUS) continue
      const falloff = 1 - distance / GLOW_RADIUS
      const next = falloff * falloff
      if (next > light[i]) light[i] = next
    }
  }

  function draw() {
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < cells.length; i++) {
      const value = light[i]
      if (value < MIN_LIGHT) continue
      const cell = cells[i]
      const size = (pixelSize + (LIT_PIXEL_SIZE - pixelSize) * value) * cellPx
      const inset = ((pixelSize - size / cellPx) / 2) * cellPx
      context.fillStyle = `rgb(${color} / ${value * TONE_STRENGTH[cell.tone]})`
      context.fillRect(cell.x * cellPx + inset, cell.y * cellPx + inset, size, size)
    }
  }

  function tick(time: number) {
    const elapsed = lastTime ? time - lastTime : 16
    lastTime = time
    const keep = Math.exp(-elapsed / FADE_MS)
    let lit = false
    for (let i = 0; i < light.length; i++) {
      if (light[i] < MIN_LIGHT) {
        light[i] = 0
        continue
      }
      light[i] *= keep
      lit = true
    }
    draw()
    frame = lit ? requestAnimationFrame(tick) : 0
    if (!lit) lastTime = 0
  }

  function onPointerMove(event: PointerEvent) {
    lightAround(event.clientX, event.clientY)
    if (!frame) frame = requestAnimationFrame(tick)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  // The theme switch changes `data-theme` on <html>, which changes the accent color.
  const themeObserver = new MutationObserver(resize)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  surface.addEventListener("pointermove", onPointerMove)

  return () => {
    observer.disconnect()
    themeObserver.disconnect()
    surface.removeEventListener("pointermove", onPointerMove)
    if (frame) cancelAnimationFrame(frame)
  }
}
