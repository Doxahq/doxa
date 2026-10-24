import { useCallback, useEffect, useState, type CSSProperties } from "react"

/** The default width: the old 17rem (272px) plus 20%. */
export const SIDEBAR_DEFAULT_WIDTH = 326
export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 480
/** A drag that goes nearer the window edge than this closes the sidebar. */
export const SIDEBAR_COLLAPSE_WIDTH = 160
/** One arrow key press on the resize handle. */
export const SIDEBAR_KEYBOARD_STEP = 16

const STORAGE_KEY = "doxa:sidebar-width"
/** Set on <html> before the first paint, so a saved width does not jump. */
const SAVED_WIDTH_VAR = "--sidebar-saved-width"

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export type SidebarDragResult = { kind: "collapse" } | { kind: "resize"; width: number }

/** The sidebar for a drag handle at `pointerX`, measured from the left window edge. */
export function resolveSidebarDrag(pointerX: number): SidebarDragResult {
  if (pointerX < SIDEBAR_COLLAPSE_WIDTH) return { kind: "collapse" }
  return { kind: "resize", width: clampSidebarWidth(pointerX) }
}

function isValidWidth(width: number): boolean {
  return Number.isFinite(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH
}

export function readSidebarWidth(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) return null
    const width = Number(stored)
    return isValidWidth(width) ? width : null
  } catch {
    return null
  }
}

export function writeSidebarWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

/**
 * A head script that applies the saved width before the first paint. React
 * reads the same value after it mounts.
 */
export const SIDEBAR_WIDTH_SCRIPT = `(function(){try{var w=Number(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));if(w>=${SIDEBAR_MIN_WIDTH}&&w<=${SIDEBAR_MAX_WIDTH})document.documentElement.style.setProperty(${JSON.stringify(SAVED_WIDTH_VAR)},w+"px")}catch(e){}})()`

/**
 * The width of the dashboard sidebar, saved in this browser.
 *
 * A drag changes the CSS variable directly and calls `setWidth` once at the
 * end, so the dashboard does not render again for each pointer move.
 */
export function useSidebarWidth() {
  const [width, setWidthState] = useState<number | null>(null)

  useEffect(() => setWidthState(readSidebarWidth()), [])

  const setWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next)
    setWidthState(clamped)
    writeSidebarWidth(clamped)
  }, [])

  const resetWidth = useCallback(() => {
    setWidthState(SIDEBAR_DEFAULT_WIDTH)
    writeSidebarWidth(null)
  }, [])

  const style: CSSProperties & { "--sidebar-width": string } = {
    // Before mount, the head script value (or the default) applies.
    "--sidebar-width":
      width === null ? `var(${SAVED_WIDTH_VAR}, ${SIDEBAR_DEFAULT_WIDTH}px)` : `${width}px`,
  }

  return { width: width ?? SIDEBAR_DEFAULT_WIDTH, style, setWidth, resetWidth }
}
