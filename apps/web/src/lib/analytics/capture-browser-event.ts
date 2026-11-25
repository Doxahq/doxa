import {
  parseProductEventProperties,
  type AnalyticsProperties,
  type BrowserEventName,
  type ProductEventProperties,
} from "@doxahq/analytics"

import { browserAnalytics } from "~/lib/analytics/browser-analytics"

/** Where a checked event goes. The page's controller by default; tests pass their own. */
export interface BrowserEventSink {
  capture(name: string, properties: AnalyticsProperties): void
}

/**
 * Sends one of the catalog's browser events. The catalog parses the
 * properties first: invalid input, such as text that is not a machine code,
 * is dropped and never leaves the browser. Returns true when it was sent on.
 */
export function captureBrowserEvent<Name extends BrowserEventName>(
  name: Name,
  properties: ProductEventProperties<Name>,
  sink: BrowserEventSink = browserAnalytics,
): boolean {
  const parsed = parseProductEventProperties(name, properties)
  if (!parsed.ok) {
    // The paths only, never the values: a value can be the content that the catalog keeps out.
    if (import.meta.env.DEV) console.warn(`[analytics] dropped ${name}: ${parsed.paths.join(", ")}`)
    return false
  }
  sink.capture(name, parsed.properties)
  return true
}

/** The click handler of a marketing call to action. */
export function ctaClickHandler(
  location: string,
  cta: string,
  plan?: ProductEventProperties<"cta_clicked">["plan"],
): () => void {
  return () => {
    captureBrowserEvent("cta_clicked", { location, cta, ...(plan ? { plan } : {}) })
  }
}
