import { useRef, type ReactNode } from "react"
import type { MarketingPage as MarketingPageName } from "~/lib/marketing/links"
import { usePauseOffscreenAnimations } from "~/lib/marketing/use-pause-offscreen-animations"

/**
 * The root of a marketing page: the `.pg` scope for the shared styles, the
 * page scope (`.pg--home`, …) for the page styles, and the two column rails.
 * The CSS animations of a section pause while it is off screen.
 */
export function MarketingPage({ page, children }: { page: MarketingPageName; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  usePauseOffscreenAnimations(root)
  return (
    <div ref={root} className={`pg pg--${page}`}>
      <div className="rails" aria-hidden="true" />
      {children}
    </div>
  )
}
