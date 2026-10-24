import { useEffect, useRef, type CSSProperties } from "react"
import { bandRows, type BandSpec } from "~/lib/marketing/bands"

interface BandProps {
  spec: BandSpec
  /** Draws the dashed guide line on the top edge too. */
  top?: boolean
  style?: CSSProperties
}

/** Starts slow, then lands softly. */
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)"
/** How long one line takes to draw in or out. */
const DRAW_MS = 900
/** On reveal, each line starts at a random moment within this time. */
const SPREAD_MS = 1600
/** While the band is on screen, a line draws out after a pause in this range... */
const ERASE_GAP_MS = { min: 2000, max: 4000 }
/** ...stays gone for this long, then draws back in. */
const GONE_MS = { min: 1200, max: 3200 }
/** No more than this many lines of one band are drawn out at the same time. */
const MAX_GONE = 2

const random = (min: number, max: number) => min + Math.random() * (max - min)
/** The edge a line grows from or shrinks into: left or right, at random. */
const side = () => (Math.random() < 0.5 ? "0% 50%" : "100% 50%")

/**
 * A full-width strip of grid lines. When the band scrolls into view, each line
 * draws in from its left or right end at a random moment. While the band is on
 * screen, a few lines at a time draw out and back in. The lines fold away once
 * the band leaves the screen, so they draw in again next time.
 */
export function Band({ spec, top = true, style }: BandProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const band = ref.current
    if (!band) return
    const cells = [...band.querySelectorAll<HTMLElement>(".cell")]
    if (cells.length === 0) return
    // Like baseten.co, the lines fill in even with reduced motion. The fill is short
    // and runs along one axis only.

    let shown: Animation[] = []
    const gone = new Map<HTMLElement, Animation>()
    let timer = 0

    const eraseOne = () => {
      const free = cells.filter((cell) => !gone.has(cell))
      if (gone.size >= MAX_GONE || free.length === 0) return
      const cell = free[Math.floor(Math.random() * free.length)]
      const out = side()
      const back = side()
      const hidden = random(GONE_MS.min, GONE_MS.max)
      const total = DRAW_MS * 2 + hidden
      const anim = cell.animate(
        [
          { transform: "scaleX(1)", transformOrigin: out, easing: EASE },
          { transform: "scaleX(0)", transformOrigin: out, offset: DRAW_MS / total },
          { transform: "scaleX(0)", transformOrigin: back, offset: (DRAW_MS + hidden) / total, easing: EASE },
          { transform: "scaleX(1)", transformOrigin: back },
        ],
        { duration: total },
      )
      gone.set(cell, anim)
      anim.onfinish = () => gone.delete(cell)
    }

    const queueErase = (after: number) => {
      timer = window.setTimeout(() => {
        eraseOne()
        queueErase(random(ERASE_GAP_MS.min, ERASE_GAP_MS.max))
      }, after)
    }

    const show = () => {
      shown = cells.map((cell) => {
        const from = side()
        const frames = [
          { transform: "scaleX(0)", transformOrigin: from },
          { transform: "scaleX(1)", transformOrigin: from },
        ]
        return cell.animate(frames, {
          duration: DRAW_MS,
          delay: Math.random() * SPREAD_MS,
          easing: EASE,
          fill: "both",
        })
      })
      queueErase(SPREAD_MS + DRAW_MS + random(ERASE_GAP_MS.min, ERASE_GAP_MS.max))
    }

    const hide = () => {
      window.clearTimeout(timer)
      for (const a of gone.values()) a.cancel()
      gone.clear()
      for (const a of shown) a.cancel()
      shown = []
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.3) {
          if (shown.length === 0) show()
        } else if (!entry.isIntersecting) {
          // Fully off screen: fold the lines so they draw in again next time.
          hide()
        }
      },
      { threshold: [0, 0.3] },
    )
    observer.observe(band)
    return () => {
      observer.disconnect()
      hide()
    }
  }, [])

  return (
    <div ref={ref} className={top ? "band band--top" : "band"} aria-hidden="true" style={style}>
      {bandRows(spec).map((cells, r) => (
        <div className="band__row" key={r}>
          {cells.map((cell) => (
            <span
              key={cell.left}
              className={`cell ${cell.kind}`}
              style={{ left: cell.left, width: cell.width }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
