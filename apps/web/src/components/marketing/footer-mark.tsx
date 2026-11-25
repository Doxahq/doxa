import { useEffect, useRef } from "react"
import { FOOTER_MARK_ROWS, PIXEL_TONES, pixelCells, pixelGridSize, pixelPaths } from "~/lib/marketing/footer-mark"
import { startFooterGlow } from "~/lib/marketing/footer-mark-glow"

const GRID = pixelGridSize(FOOTER_MARK_ROWS)
const PATHS = pixelPaths(FOOTER_MARK_ROWS)
const CELLS = pixelCells(FOOTER_MARK_ROWS)

/** The footer renders once per page, so fixed ids are unique. */
const CELL_PATTERN_ID = "foot-mark-cell"
const CELL_MASK_ID = "foot-mark-mask"

/** The share of each cell that a pixel fills. The rest is the gap to the next pixel. */
const PIXEL_SIZE = 0.8

/** The share of the mark height that hangs below the bottom edge of the page. */
const BOTTOM_OVERFLOW = 0.15

/**
 * The large pixel "DOXA" at the bottom of the footer. It is an inline SVG, so it draws
 * with the first paint, scales with the column, and takes its colors from the theme.
 * A canvas on top lights the pixels near the cursor (footer-mark-glow.ts).
 */
export function FooterMark() {
  const artRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const art = artRef.current
    const canvas = canvasRef.current
    if (!art || !canvas) return
    return startFooterGlow({
      canvas,
      // The whole mark area reacts, so the glow also follows the cursor over the "Onboard your agent" button.
      surface: art.closest<HTMLElement>(".foot__mark") ?? art,
      cells: CELLS,
      cols: GRID.cols,
      rows: GRID.rows,
      pixelSize: PIXEL_SIZE,
    })
  }, [])

  return (
    <div
      ref={artRef}
      className="foot__art"
      // A negative bottom margin crops the lower part of the mark, so it rises from the page edge.
      // A percentage margin resolves against the column width, so scale it by the height-to-width ratio.
      style={{ marginBottom: `${(-BOTTOM_OVERFLOW * 100 * GRID.rows) / GRID.cols}%` }}
    >
      <svg className="foot__wordmark" viewBox={`0 0 ${GRID.cols} ${GRID.rows}`} aria-hidden="true" focusable="false">
        <defs>
          <pattern id={CELL_PATTERN_ID} width="1" height="1" patternUnits="userSpaceOnUse">
            <rect width={PIXEL_SIZE} height={PIXEL_SIZE} fill="#fff" />
          </pattern>
          <mask id={CELL_MASK_ID} maskUnits="userSpaceOnUse" x="0" y="0" width={GRID.cols} height={GRID.rows}>
            <rect width={GRID.cols} height={GRID.rows} fill={`url(#${CELL_PATTERN_ID})`} />
          </mask>
        </defs>
        <g mask={`url(#${CELL_MASK_ID})`}>
          {PIXEL_TONES.map((tone) => (
            <path key={tone} className={`foot__pixels foot__pixels--${tone}`} d={PATHS[tone]} />
          ))}
        </g>
      </svg>
      <canvas ref={canvasRef} className="foot__glow" aria-hidden="true" />
    </div>
  )
}
