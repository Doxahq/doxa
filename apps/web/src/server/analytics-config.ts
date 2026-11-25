import {
  analyticsConfigFor,
  readWebPostHogSettings,
  type AnalyticsConfig,
  type WebAnalyticsEnv,
} from "~/lib/analytics/analytics-config"

export interface AnalyticsConfigOptions {
  /** The Worker variables. `worker.js` copies them into `process.env` on each request. */
  readonly env?: WebAnalyticsEnv
  /** Says that analytics is off. Only development passes one, and it speaks once. */
  readonly warn?: (message: string) => void
}

let warnedOnce = false

/** In local development only: a production Worker stays quiet about a missing key. */
function warnOnceInDevelopment(message: string): void {
  if (!import.meta.env.DEV || warnedOnce) return
  warnedOnce = true
  console.warn(`[analytics] ${message}`)
}

/**
 * The visitor's country. Cloudflare puts it on `request.cf`; the
 * `cf-ipcountry` header carries the same code when `cf` is missing (for
 * example behind another proxy). Null when neither has it.
 */
export function requestCountry(request: Request): string | null {
  const cf: unknown = Reflect.get(request, "cf")
  if (typeof cf === "object" && cf !== null && "country" in cf && typeof cf.country === "string") return cf.country
  return request.headers.get("cf-ipcountry")
}

function processEnv(): WebAnalyticsEnv {
  return { POSTHOG_KEY: process.env.POSTHOG_KEY, POSTHOG_INGEST_HOSTNAME: process.env.POSTHOG_INGEST_HOSTNAME }
}

/** The body of `GET /api/analytics-config` for this request. */
export function analyticsConfigForRequest(request: Request, options: AnalyticsConfigOptions = {}): AnalyticsConfig {
  const settings = readWebPostHogSettings(options.env ?? processEnv())
  if (!settings.enabled) (options.warn ?? warnOnceInDevelopment)(settings.warning)
  return analyticsConfigFor(requestCountry(request), settings)
}

/**
 * `GET /api/analytics-config`. The answer depends on the visitor's country,
 * so no shared cache may keep it.
 */
export function analyticsConfigResponse(request: Request, options: AnalyticsConfigOptions = {}): Response {
  return Response.json(analyticsConfigForRequest(request, options), {
    headers: { "Cache-Control": "private, no-store" },
  })
}
