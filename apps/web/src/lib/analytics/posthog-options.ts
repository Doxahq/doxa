import { scrubAnalyticsProperties, scrubAnalyticsUrl, type BrowserAnalyticsMode } from "@doxahq/analytics/browser"
import type { CapturedNetworkRequest, CaptureResult, PostHogConfig } from "posthog-js"

import type { PostHogConnection } from "~/lib/analytics/analytics-config"
import { maskReplayAttribute, REPLAY_MASK_TEXT_SELECTOR, scrubReplayBatch } from "~/lib/analytics/replay-privacy"

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
      // Only sensitive text: docs, code, secrets, emails and payment details (`replay-privacy.ts`).
      maskTextSelector: REPLAY_MASK_TEXT_SELECTOR,
      maskAttributeFn: maskReplayAttribute,
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
 * `?token=`) and page titles are dropped. A replay batch keeps every event:
 * its page addresses are scrubbed (`scrubReplayBatch`). A batch is dropped
 * only on a page whose path is a secret, as a second guard after the
 * project's replay URL blocklist.
 *
 * Never drop a batch for a query string: rrweb sends DOM changes as deltas,
 * so one lost batch freezes the rest of the replay until the next full
 * snapshot (the Content page keeps `?page=` in the address).
 */
export function scrubCaptureResult(event: CaptureResult | null, currentHref: string | null = browserHref()): CaptureResult | null {
  if (!event) return null
  const isSnapshot = event.event === "$snapshot"
  if (isSnapshot && currentHref !== null && pathHoldsSecret(currentHref)) return null
  const properties = scrubAnalyticsProperties(event.properties)
  return {
    ...event,
    properties: isSnapshot ? scrubReplayBatch(properties) : properties,
    ...(event.$set ? { $set: scrubAnalyticsProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: scrubAnalyticsProperties(event.$set_once) } : {}),
  }
}

/** Network timing in replays keeps the request, not the secrets in its URL. */
export function scrubNetworkRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return { ...request, name: scrubAnalyticsUrl(request.name) }
}

/** True when the path itself is a secret or a one-time ID (`/invite/…`, `/approve/…`). The query and fragment do not count. */
export function pathHoldsSecret(href: string): boolean {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  const pathOnly = `${url.origin}${url.pathname}`
  return scrubAnalyticsUrl(pathOnly) !== pathOnly
}

function browserHref(): string | null {
  return typeof window === "undefined" ? null : window.location.href
}
