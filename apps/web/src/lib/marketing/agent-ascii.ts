/**
 * The ASCII grid behind the Doxa Agent hero art, in the page's own language:
 * dotted guide lines with a "+" where two lines cross. Slow pulses ring out from
 * the agent core and light the grid as they pass, like a radar that reads the
 * repository.
 *
 * Cost: the still grid is drawn once to an offscreen layer and copied in one
 * call per frame. Only the cells under a ring are drawn on top. Glyphs come from
 * a pre-rendered strip (one row per opacity step), 15 frames a second, and
 * nothing while the canvas is off screen. With reduced motion, the still grid
 * draws once and the rings stay off.
 *
 * Returns a function that stops the loop and the observers.
 */
export function attachAsciiGrid(canvas: HTMLCanvasElement, core: HTMLElement | null): () => void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return () => {}

  const CW = 8
  const CH = 14
  const GRID_X = 12
  const GRID_Y = 6
  const FPS = 15
  // Rings: px per second, px between two rings, px of soft edge on each side of a crest.
  const SPEED = 26
  const SPACING = 150
  const WIDTH = 40
  // Rings are ellipses, wider than tall, like the panel.
  const SQUASH = 1.55
  const GLYPHS = [".", ":", "-", "+"]
  const LEVELS = 10
  const MAX_ALPHA = 0.5
  // Still grid opacity: "." on a guide line, "+" where two lines cross.
  const LINE_ALPHA = 0.06
  const CROSS_ALPHA = 0.12
  const smooth = (a: number, b: number, x: number) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return k * k * (3 - 2 * k)
  }
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

  let dpr = 1
  let w = 0
  let h = 0
  let cols = 0
  let rows = 0
  let atlas: HTMLCanvasElement | null = null
  let base: HTMLCanvasElement | null = null
  let dist = new Float32Array(0)
  let amp = new Float32Array(0)
  let kind = new Uint8Array(0)
  let seed = new Float32Array(0)
  let raf = 0
  let last = 0
  let stopped = false

  // GLYPHS across, LEVELS of opacity down, so drawing never changes globalAlpha.
  const buildAtlas = () => {
    atlas = document.createElement("canvas")
    atlas.width = GLYPHS.length * CW * dpr
    atlas.height = LEVELS * CH * dpr
    const a = atlas.getContext("2d")
    if (!a) return
    a.scale(dpr, dpr)
    a.font = '400 11px "JetBrains Mono", ui-monospace, monospace'
    a.textAlign = "center"
    a.textBaseline = "middle"
    for (let l = 0; l < LEVELS; l++) {
      a.fillStyle = `rgba(156, 194, 255, ${(((l + 1) / LEVELS) * MAX_ALPHA).toFixed(3)})`
      GLYPHS.forEach((g, i) => a.fillText(g, i * CW + CW / 2, l * CH + CH / 2 + 0.5))
    }
  }

  const level = (alpha: number) => Math.min(LEVELS - 1, Math.max(0, Math.round((alpha / MAX_ALPHA) * LEVELS) - 1))
  const glyphAt = (target: CanvasRenderingContext2D, g: number, alpha: number, c: number, r: number) => {
    if (!atlas) return
    target.drawImage(atlas, g * CW * dpr, level(alpha) * CH * dpr, CW * dpr, CH * dpr, c * CW, r * CH, CW, CH)
  }

  // The still grid: "." along every guide line, "+" where two lines cross.
  const buildBase = () => {
    base = document.createElement("canvas")
    base.width = canvas.width
    base.height = canvas.height
    const b = base.getContext("2d")
    if (!b) return
    b.scale(dpr, dpr)
    for (let i = 0; i < kind.length; i++) {
      if (kind[i] === 0) continue
      const cross = kind[i] === 2
      glyphAt(b, cross ? 3 : 0, cross ? CROSS_ALPHA : LINE_ALPHA, i % cols, Math.floor(i / cols))
    }
  }

  const layout = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    w = Math.max(1, canvas.clientWidth)
    h = Math.max(1, canvas.clientHeight)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    cols = Math.ceil(w / CW)
    rows = Math.ceil(h / CH)
    // Rings start at the agent core, wherever the layout puts it.
    let cx = w / 2
    let cy = h / 2
    const box = canvas.getBoundingClientRect()
    if (core && box.width > 0) {
      const r = core.getBoundingClientRect()
      const scale = box.width / w
      cx = (r.left + r.width / 2 - box.left) / scale
      cy = (r.top + r.height / 2 - box.top) / scale
    }
    const far = Math.max(
      Math.hypot(cx, cy * SQUASH),
      Math.hypot(w - cx, cy * SQUASH),
      Math.hypot(cx, (h - cy) * SQUASH),
      Math.hypot(w - cx, (h - cy) * SQUASH),
    )
    const n = cols * rows
    dist = new Float32Array(n)
    amp = new Float32Array(n)
    kind = new Uint8Array(n)
    seed = new Float32Array(n)
    // Seeded, so the dither is the same on every load.
    let s = 97
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const e = Math.hypot(c * CW + CW / 2 - cx, (r * CH + CH / 2 - cy) * SQUASH)
        dist[i] = e
        // Rings appear just outside the core frame and fade before the far edges.
        amp[i] = smooth(110, 170, e) * (1 - smooth(far * 0.55, far * 0.95, e))
        const onX = c % GRID_X === 0
        const onY = r % GRID_Y === 0
        kind[i] = onX && onY ? 2 : onX || onY ? 1 : 0
        s = (s * 16807) % 2147483647
        seed[i] = (s - 1) / 2147483646
      }
    }
    buildAtlas()
    buildBase()
  }

  const draw = (now: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (base) ctx.drawImage(base, 0, 0, w, h)
    if (still) return
    const travel = (now / 1000) * SPEED
    for (let i = 0; i < dist.length; i++) {
      const a = amp[i]
      if (a < 0.02) continue
      const p = (dist[i] - travel) / SPACING
      const off = Math.abs(p - Math.round(p)) * SPACING
      if (off >= WIDTH) continue
      let v = (1 - smooth(0, WIDTH, off)) * a
      const c = i % cols
      const r = (i - c) / cols
      if (kind[i] === 0) {
        // Between the lines: a sparse, dithered edge of the ring.
        v = v * 0.85 - seed[i] * 0.3
        if (v < 0.08) continue
        glyphAt(ctx, v > 0.45 ? 1 : 0, 0.08 + 0.3 * v, c, r)
      } else {
        if (v < 0.04) continue
        // On a line: replace the still glyph with a brighter, heavier one.
        ctx.clearRect(c * CW, r * CH, CW, CH)
        const g = kind[i] === 2 ? 3 : v > 0.66 ? 2 : v > 0.3 ? 1 : 0
        glyphAt(ctx, g, (kind[i] === 2 ? CROSS_ALPHA : LINE_ALPHA) + 0.3 * v, c, r)
      }
    }
  }

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop)
    if (now - last < 1000 / FPS - 2) return
    last = now
    draw(now)
  }
  const start = () => {
    if (!raf && !still) raf = requestAnimationFrame(loop)
  }
  const stop = () => {
    cancelAnimationFrame(raf)
    raf = 0
  }

  layout()
  // The grid draws as soon as the page runs, before the loop starts.
  draw(performance.now())
  const resize =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          layout()
          draw(performance.now())
        })
  resize?.observe(canvas)
  const view =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()))
  if (view) view.observe(canvas)
  else start()
  // Redraw the glyphs once JetBrains Mono has loaded.
  void document.fonts?.ready.then(() => {
    if (stopped) return
    buildAtlas()
    buildBase()
    draw(performance.now())
  })

  return () => {
    stopped = true
    stop()
    resize?.disconnect()
    view?.disconnect()
  }
}
