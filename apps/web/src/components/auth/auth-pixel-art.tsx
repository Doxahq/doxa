import { useLayoutEffect, useRef } from "react"

interface Star {
  x: number
  y: number
  phase: number
  speed: number
}

interface Ember {
  x: number
  phase: number
  period: number
  rise: number
}

interface Scene {
  cols: number
  rows: number
  /** One random number per cell, fixed for the life of the scene. */
  seed: Float32Array
  /** The page rectangle, in cells. From `fadeTop` down, the page breaks into pixels. */
  left: number
  right: number
  top: number
  fadeTop: number
  bottom: number
  groundTop: number
  /** The page as it is, and as the next scan line writes it. */
  current: Float32Array
  next: Float32Array
  scans: number
  stars: Star[]
  embers: Ember[]
}

/** The canvas, with the stop function of the art while it runs, and the seed of its scene. */
type ArtCanvas = HTMLCanvasElement & { stopArt?: () => void; artSeed?: number }

/**
 * Starts the art on `canvas` and returns the function that stops it. A call while
 * the art runs returns the same function.
 *
 * The page also runs this function from its source text in an inline script (see
 * `PixelDocsArt`), so the body must not use any name from outside it. Types are
 * fine: they do not exist at run time.
 */
function startPixelArt(canvas: ArtCanvas): () => void {
  if (canvas.stopArt) return canvas.stopArt

  /** One art pixel, in CSS pixels. */
  const CELL = 5
  /** The art redraws at this rate. A low rate suits the pixel look and costs little. */
  const FRAME_MS = 1000 / 24
  /** The first scan line starts this long after the art starts... */
  const FIRST_SCAN_MS = 1500
  /** ...and then a scan line rewrites the page this often... */
  const SCAN_EVERY_MS = 6500
  /** ...and takes this long to run down it. */
  const SCAN_MS = 1800
  /** The broken pixels at the bottom of the page drift up one row per this time. */
  const DRIFT_MS = 200
  /** The website's blues, dark to light (`styles/marketing`). Level 0 is empty, so the page color shows. */
  const PALETTE = [
    [0, 0, 0],
    [14, 23, 48],
    [27, 47, 107],
    [36, 83, 201],
    [61, 123, 255],
    [156, 194, 255],
    [230, 239, 255],
  ]
  const TOP_LEVEL = PALETTE.length - 1
  /** The 4×4 ordered-dither thresholds, as on the dithered art of the landing page. */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)
  /** The page's blocks from the top: paragraphs (`p` and the line count), code blocks and subheadings. */
  const PAGE_BLOCKS = ["p3", "code4", "h2", "p4", "p2", "code3", "h2", "p3", "p4", "code4", "p3"]

  // A seeded random source, so a restart on the same canvas (React's strict mode
  // runs effects twice) draws the same scene.
  if (canvas.artSeed === undefined) canvas.artSeed = Math.floor(Math.random() * 2 ** 32)
  let state = canvas.artSeed
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let r = Math.imul(state ^ (state >>> 15), 1 | state)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }

  const fract = (v: number) => v - Math.floor(v)
  const smooth = (from: number, to: number, v: number) => {
    const k = Math.min(1, Math.max(0, (v - from) / (to - from)))
    return k * k * (3 - 2 * k)
  }
  const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)

  /**
   * The docs page as light values from 0 to 1: a site header, a title, paragraphs,
   * code blocks and subheadings. The layout stays the same from scan to scan; the
   * line lengths change, so each scan reads as an edit of the same page.
   */
  const paintPage = (w: number, h: number) => {
    const paper = new Float32Array(w * h).fill(0.5)
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) paper[y * w + x] = v
      }
    }
    const text = w - 8
    const width = (min: number, max: number) => Math.round(text * (min + random() * (max - min)))

    // The site header: a mark on the left, three links on the right.
    fill(0, 0, w, 6, 0.28)
    fill(3, 2, 6, 4, 1)
    for (let i = 0; i < 3; i++) fill(w - 10 - i * 8, 3, w - 5 - i * 8, 4, 0.75)

    fill(4, 11, 4 + Math.round(text * 0.3), 12, 0.75)
    fill(4, 15, 4 + width(0.45, 0.75), 18, 1)

    let y = 23
    for (let b = 0; y < h; b = (b + 1) % PAGE_BLOCKS.length) {
      const block = PAGE_BLOCKS[b]
      if (block === "h2") {
        fill(4, y, 4 + width(0.3, 0.55), y + 2, 1)
        y += 6
      } else if (block.startsWith("code")) {
        const lines = Number(block.slice(4))
        fill(4, y, w - 4, y + lines * 3 + 3, 0.14)
        for (let i = 0; i < lines; i++) {
          const indent = i > 0 && i < lines - 1 ? 3 : 0
          fill(7 + indent, y + 2 + i * 3, 7 + indent + width(0.2, 0.6), y + 3 + i * 3, i === 0 ? 0.95 : 0.68)
        }
        y += lines * 3 + 7
      } else {
        const lines = Number(block.slice(1))
        for (let i = 0; i < lines; i++) {
          fill(4, y, 4 + (i === lines - 1 ? width(0.3, 0.65) : width(0.82, 1)), y + 1, 0.86)
          y += 3
        }
        y += 3
      }
    }

    // A bright 1-cell frame on the top and sides.
    fill(0, 0, w, 1, 1)
    fill(0, 0, 1, h, 1)
    fill(w - 1, 0, w, h, 1)
    return paper
  }

  const buildScene = (width: number, height: number): Scene => {
    const cols = Math.ceil(width / CELL)
    const rows = Math.ceil(height / CELL)
    const seed = new Float32Array(cols * rows)
    for (let i = 0; i < seed.length; i++) seed[i] = random()

    // The page sits right of the logo's wordmark and keeps a margin from the page edge.
    const left = Math.round(Math.max(150, width * 0.38) / CELL)
    const right = cols - Math.round(Math.max(24, width * 0.06) / CELL)
    const top = Math.round(rows * 0.13)
    const bottom = Math.round(rows * 0.82)
    const w = right - left
    const h = bottom - top

    const stars: Star[] = []
    const logoRow = rows / 2
    for (let n = Math.round((cols * rows) / 380); n > 0; n--) {
      const x = Math.floor(random() * cols)
      const y = Math.floor(random() * rows * 0.8)
      const onPage = x >= left - 2 && x < right + 2 && y >= top - 2
      const onLogo = x < 34 && Math.abs(y - logoRow) < 10
      if (!onPage && !onLogo) stars.push({ x, y, phase: random() * 6.28, speed: 0.6 + random() * 1.6 })
    }

    const embers: Ember[] = []
    for (let n = 0; n < 14; n++) {
      embers.push({ x: left + Math.floor(random() * w), phase: random(), period: 3200 + random() * 2400, rise: 12 + Math.floor(random() * 24) })
    }

    return {
      cols,
      rows,
      seed,
      left,
      right,
      top,
      fadeTop: Math.round(rows * 0.56),
      bottom,
      groundTop: Math.round(rows * 0.86),
      current: paintPage(w, h),
      next: paintPage(w, h),
      scans: 0,
      stars,
      embers,
    }
  }

  /** Light values to palette levels, with the ordered dither between two levels. */
  const put = (data: Uint8ClampedArray, i: number, x: number, y: number, v: number) => {
    const s = Math.max(0, v) * TOP_LEVEL
    let level = Math.floor(s)
    if (s - level > BAYER[(y & 3) * 4 + (x & 3)]) level++
    if (level > TOP_LEVEL) level = TOP_LEVEL
    const o = i * 4
    if (level === 0) {
      data[o + 3] = 0
      return
    }
    data[o] = PALETTE[level][0]
    data[o + 1] = PALETTE[level][1]
    data[o + 2] = PALETTE[level][2]
    data[o + 3] = 255
  }

  const draw = (scene: Scene, image: ImageData, t: number) => {
    const { cols, rows, seed, left, right, top, fadeTop, bottom, groundTop } = scene
    const data = image.data
    const w = right - left
    const h = bottom - top

    // Every SCAN_EVERY_MS a scan line runs down the page. Above it the page shows its
    // next text, below it the current one. A new cycle keeps the text the scan wrote.
    const since = t - FIRST_SCAN_MS
    let scanRow = Number.NEGATIVE_INFINITY
    if (since > 0) {
      const cycle = Math.floor(since / SCAN_EVERY_MS)
      if (cycle > scene.scans) {
        scene.scans = cycle
        scene.current = scene.next
        scene.next = paintPage(w, h)
      }
      const into = since % SCAN_EVERY_MS
      scanRow = into < SCAN_MS ? top + easeInOut(into / SCAN_MS) * (bottom - top) : Number.POSITIVE_INFINITY
    }

    const haloX = (left + right) / 2
    const haloY = top + h * 0.4
    const haloR = Math.max(w, h) * 0.6
    const drift = Math.floor(t / DRIFT_MS)

    for (let y = 0; y < rows; y++) {
      // Below one palette step (1/6), so the sky stays a dither and never a flat band.
      const sky = 0.15 * smooth(0.4, 1, y / rows)
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x

        // The night sky: dark at the top, navy toward the bottom, with a glow behind the page.
        const dx = (x - haloX) / haloR
        const dy = (y - haloY) / haloR
        const d2 = dx * dx + dy * dy
        let v = sky + (d2 < 1 ? 0.14 * (1 - d2) * (1 - d2) : 0)

        if (x >= left && x < right && y >= top && y < bottom) {
          // From `fadeTop` down, the page breaks into blocks that grow and thin out.
          const depth = y < fadeTop ? 0 : (y - fadeTop) / (bottom - fadeTop)
          const size = depth < 0.3 ? 1 : depth < 0.65 ? 2 : 3
          const qx = depth === 0 ? x : x - ((x - left) % size)
          const qy = depth === 0 ? y : y - ((y - fadeTop) % size)
          const live = depth === 0 || fract(seed[((qy + drift) % rows) * cols + qx] * 7.3) > depth
          if (live) {
            const px = qx - left
            const py = qy - top
            const paper = qy < scanRow ? scene.next : scene.current
            v = paper[py * w + px] * (0.8 + 0.3 * (1 - py / h))
            if (qy <= scanRow && qy > scanRow - 2) v = 1
            else if (qy <= scanRow - 2 && qy > scanRow - 6) v += 0.12
          }
        }

        // The ground: the broken pixels pile up in a dithered band at the bottom.
        if (y >= groundTop) {
          const g = (y - groundTop) / (rows - groundTop)
          const q = (y - (y % 2)) * cols + (x - (x % 2))
          const under = x >= left - 4 && x < right + 4 ? 0.3 : 0
          if (fract(seed[q] * 13.7 + t * 0.00004) < g * (0.55 + under)) v = Math.max(v, 0.2 + fract(seed[q] * 51.3) * 0.8)
        }

        put(data, i, x, y, v)
      }
    }

    // Stars twinkle.
    for (const star of scene.stars) {
      const lit = Math.sin((t / 1000) * star.speed + star.phase)
      if (lit > -0.2) put(data, star.y * cols + star.x, star.x, star.y, lit > 0.6 ? 1 : 0.75)
    }

    // Embers rise from the ground toward the page and fade.
    for (const ember of scene.embers) {
      const k = fract(t / ember.period + ember.phase)
      const y = Math.round(groundTop - k * ember.rise)
      if (y >= 0 && y < rows && k < 0.85) put(data, y * cols + ember.x, ember.x, y, k < 0.5 ? 1 : 0.8)
    }
  }

  const ctx = canvas.getContext("2d")
  const box = canvas.parentElement
  if (!ctx || !box) return () => {}

  let scene: Scene | null = null
  let image: ImageData | null = null
  const start = performance.now()
  let last = 0
  let frame = 0

  const paint = (now: number) => {
    if (!scene || !image) return
    last = now
    draw(scene, image, now - start)
    ctx.putImageData(image, 0, 0)
  }

  const resize = () => {
    const { width, height } = box.getBoundingClientRect()
    if (width === 0 || height === 0) return
    // The first observer callback reports the size the art already has.
    if (scene && scene.cols === Math.ceil(width / CELL) && scene.rows === Math.ceil(height / CELL)) return
    scene = buildScene(width, height)
    canvas.width = scene.cols
    canvas.height = scene.rows
    canvas.style.width = `${scene.cols * CELL}px`
    canvas.style.height = `${scene.rows * CELL}px`
    image = ctx.createImageData(scene.cols, scene.rows)
    // Draw now, so no frame shows the canvas empty.
    paint(performance.now())
  }

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    if (now - last >= FRAME_MS) paint(now)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(box)
  resize()
  frame = requestAnimationFrame(tick)

  const stop = () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    canvas.stopArt = undefined
  }
  canvas.stopArt = stop
  return stop
}

/** Starts the art on the canvas in the element just before the script, while the HTML loads. */
const START_SCRIPT = `(${startPixelArt.toString()})(document.currentScript.previousElementSibling.firstElementChild)`

/**
 * The login panel's pixel art: the website's dithered, pixelated look applied to a
 * docs page. The page glows blue in a night sky, breaks into pixels toward the
 * bottom, and a scan line rewrites it every few seconds. Drawn on a canvas one cell
 * per canvas pixel, then scaled up with `image-rendering: pixelated`.
 *
 * On a full page load, the inline script starts the art while the HTML loads, so it
 * shows with the first paint, before React hydrates. On a visit from another page of
 * the app the script does not run, and the layout effect starts the art before the
 * first paint instead.
 */
export function PixelDocsArt({ className }: { className?: string }) {
  const canvasRef = useRef<ArtCanvas>(null)

  // After a full page load the art already runs, and this call takes it over.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    return canvas ? startPixelArt(canvas) : undefined
  }, [])

  return (
    <>
      <div className={className}>
        {/* The script sets the canvas size before React hydrates. */}
        <canvas ref={canvasRef} className="block [image-rendering:pixelated]" suppressHydrationWarning />
      </div>
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: START_SCRIPT }} />
    </>
  )
}
