import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

import { useSidebar } from "~/components/ui/sidebar"
import {
  clampSidebarWidth,
  resolveSidebarDrag,
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "~/lib/dashboard/sidebar-width"

/** A pointer must move this far before a press counts as a drag. */
const DRAG_THRESHOLD = 3

/**
 * The right edge of the sidebar. Drag it to resize the sidebar between the
 * minimum and maximum width. Drag it near the window edge to close the
 * sidebar, and drag it back out to open the sidebar again. A double click
 * resets the default width.
 */
export function SidebarResizeHandle({
  width,
  onWidthChange,
  onReset,
}: {
  width: number
  onWidthChange: (width: number) => void
  onReset: () => void
}) {
  const { open, setOpen, isMobile } = useSidebar()

  // On mobile the sidebar is a drawer with a fixed width.
  if (isMobile) return null

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const handle = event.currentTarget
    const shell = handle.closest<HTMLElement>("[data-dashboard-shell]")
    if (!shell) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)

    const startX = event.clientX
    let moved = false
    let isOpen = open
    let next = width
    // The sidebar follows the pointer with no width transition.
    shell.dataset.resizing = "true"
    document.documentElement.style.cursor = "col-resize"
    document.documentElement.style.userSelect = "none"

    function onMove(moveEvent: PointerEvent) {
      if (!moved && Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD) return
      moved = true
      const result = resolveSidebarDrag(moveEvent.clientX)
      if (result.kind === "collapse") {
        if (isOpen) {
          isOpen = false
          setOpen(false)
        }
        return
      }
      if (!isOpen) {
        isOpen = true
        setOpen(true)
      }
      next = result.width
      shell?.style.setProperty("--sidebar-width", `${next}px`)
    }

    function onEnd() {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onEnd)
      handle.removeEventListener("pointercancel", onEnd)
      if (shell) delete shell.dataset.resizing
      document.documentElement.style.cursor = ""
      document.documentElement.style.userSelect = ""
      // A click on the edge of a closed sidebar opens it.
      if (!moved) {
        if (!isOpen) setOpen(true)
        return
      }
      if (next !== width) onWidthChange(next)
    }

    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onEnd)
    handle.addEventListener("pointercancel", onEnd)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault()
      if (!open) setOpen(true)
      else onWidthChange(clampSidebarWidth(width + SIDEBAR_KEYBOARD_STEP))
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      // At the minimum width, one more step closes the sidebar.
      if (open && width <= SIDEBAR_MIN_WIDTH) setOpen(false)
      else if (open) onWidthChange(clampSidebarWidth(width - SIDEBAR_KEYBOARD_STEP))
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={0}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={open ? width : 0}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={
        // The line is the focus indicator, so the global outline is off here.
        "absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none outline-none " +
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors " +
        "hover:after:bg-primary/60 hover:after:delay-150 focus-visible:after:bg-primary " +
        "group-data-[resizing=true]/sidebar-wrapper:after:bg-primary"
      }
    />
  )
}
