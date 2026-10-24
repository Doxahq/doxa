import type { ReactNode } from "react"
import type { MarketingPage as MarketingPageName } from "~/lib/marketing/links"

/**
 * The root of a marketing page: the `.pg` scope for the shared styles, the
 * page scope (`.pg--home`, …) for the page styles, and the two column rails.
 */
export function MarketingPage({ page, children }: { page: MarketingPageName; children: ReactNode }) {
  return (
    <div className={`pg pg--${page}`}>
      <div className="rails" aria-hidden="true" />
      {children}
    </div>
  )
}
