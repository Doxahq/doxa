import { useEffect, type RefObject } from "react"

/** Sections start again a little before they scroll into view, so no one sees them start. */
const RESUME_MARGIN = "200px 0px"

/**
 * Pauses the CSS animations of each section of a marketing page while it is off
 * screen: the section gets `data-offscreen`, and shared.css pauses every animation
 * inside it. Infinite animations below the fold otherwise run, and cost CPU, the
 * whole time the page is open.
 */
export function usePauseOffscreenAnimations(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const page = root.current
    if (!page || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting)
      },
      { rootMargin: RESUME_MARGIN },
    )
    for (const section of page.children) observer.observe(section)
    return () => {
      observer.disconnect()
      for (const section of page.children) section.removeAttribute("data-offscreen")
    }
  }, [root])
}
