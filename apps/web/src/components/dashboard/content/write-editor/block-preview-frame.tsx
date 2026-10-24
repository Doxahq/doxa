import { useEffect, useRef, type ReactNode } from "react"

import { blockPreviewHeight, rememberBlockPreviewHeight } from "~/lib/editor/block-preview-heights"

const PLACEHOLDER_ATTRIBUTE = "data-block-preview-placeholder"

/**
 * The space a locked block's preview takes before it draws: an empty box with
 * the height that source had the last time it drew. It is not a loading
 * state. It only keeps the page from moving.
 */
export function BlockPreviewPlaceholder({ source }: { source: string }) {
  return <div {...{ [PLACEHOLDER_ATTRIBUTE]: "" }} aria-hidden="true" style={{ height: blockPreviewHeight(source) }} />
}

/**
 * The box around a locked block's preview. It records the drawn height of
 * the preview, so the next placeholder for the same source has that height.
 */
export function BlockPreviewFrame({ source, children }: { source: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      // Only a drawn preview counts. The placeholder's own height is a guess.
      if (!entry || element.querySelector(`[${PLACEHOLDER_ATTRIBUTE}]`)) return
      rememberBlockPreviewHeight(source, entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [source])

  return (
    <div ref={ref} className="px-4 py-1">
      {children}
    </div>
  )
}
