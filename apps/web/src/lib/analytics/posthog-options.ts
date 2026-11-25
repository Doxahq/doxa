import { scrubAnalyticsProperties, scrubAnalyticsUrl, type BrowserAnalyticsMode } from "@doxahq/analytics/browser"
import type { CapturedNetworkRequest, CaptureResult, PostHogConfig } from "posthog-js"

import type { PostHogConnection } from "~/lib/analytics/analytics-config"

/** The modes in which posthog-js runs. `off` never starts it, or opts it out. */
export type RunningAnalyticsMode = Exclude<BrowserAnalyticsMode, "off">

/**
 * The options that change between modes, applied at init and again with
 * `set_config` when the mode changes, so the page never reloads.
 * - `anonymous`: page views only, kept in memory: no cookie, no storage, no replay.
 * - `full`: the PostHog cookie, autocapture, errors and masked replay.
 */
export function postHogModeOptions(mode: RunningAnalyticsMode): Partial<PostHogConfig> {
  const full = mode === "full"
  return {
    // Only the cookie, which the Privacy Policy lists. No localStorage copy.
    persistence: full ? "cookie" : "memory",
    disable_session_recording: !full,
    autocapture: full,
    rageclick: full,
    capture_exceptions: full,
    capture_heatmaps: full,
    capture_dead_clicks: full,
    capture_pageleave: full ? "if_capture_pageview" : false,
  }
}

/** Everything that posthog-js gets at init, for the mode that it starts in. */
export function postHogInitOptions(
  connection: PostHogConnection,
  mode: RunningAnalyticsMode,
  tracingHosts: readonly string[],
): Partial<PostHogConfig> {
  return {
    api_host: connection.apiHost,
    ui_host: connection.uiHost,
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    respect_dnt: true,
    // Links a browser session to the API's server events.
    tracing_headers: [...tracingHosts],
    // The cookie stays on doxa.so. A `.doxa.so` cookie would also reach docs.doxa.so, a hosted docs site.
    cross_subdomain_cookie: false,
    // An opt-out also removes the PostHog cookie.
    opt_out_persistence_by_default: true,
    // Autocapture never records element text or attributes: they name customer projects and pages.
    mask_all_text: true,
    mask_all_element_attributes: true,
    // Page speed can be turned on only at init, so a page that starts anonymous measures it from its next load.
    capture_performance: mode === "full",
    session_recording: {
      maskAllInputs: true,
      // Every text node: dashboard text names customer projects, pages and code.
      maskTextSelector: "*",
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: scrubNetworkRequest,
    },
    before_send: scrubCaptureResult,
    ...postHogModeOptions(mode),
  }
}

/**
 * Runs before posthog-js sends anything. URLs lose their tokens (`/invite/…`,
 * `?token=`), page titles are dropped, and a replay batch recorded on a page
 * whose address holds a secret is dropped, because rrweb stores the full
 * page address inside the replay data.
 */
export function scrubCaptureResult(event: CaptureResult | null, currentHref: string | null = browserHref()): CaptureResult | null {
  if (!event) return null
  if (event.event === "$snapshot" && currentHref !== null && urlHoldsSecret(currentHref)) return null
  return {
    ...event,
    properties: scrubAnalyticsProperties(event.properties),
    ...(event.$set ? { $set: scrubAnalyticsProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: scrubAnalyticsProperties(event.$set_once) } : {}),
  }
}

/** Network timing in replays keeps the request, not the secrets in its URL. */
export function scrubNetworkRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return { ...request, name: scrubAnalyticsUrl(request.name) }
}

/** True when scrubbing would change the address (the fragment aside): it carries a token or a secret path. */
export function urlHoldsSecret(href: string): boolean {
  const withoutFragment = href.split("#")[0] ?? href
  return scrubAnalyticsUrl(withoutFragment) !== withoutFragment
}

function browserHref(): string | null {
  return typeof window === "undefined" ? null : window.location.href
}
