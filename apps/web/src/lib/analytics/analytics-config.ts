import { readPostHogSettings, type PostHogSettingNames, type PostHogSettingsResult } from "@doxahq/analytics"
import { isConsentRequired } from "@doxahq/analytics/browser"
import { z } from "zod"

/** The path of the server route that answers the region and the PostHog connection. */
export const ANALYTICS_CONFIG_PATH = "/api/analytics-config"

/** PostHog's own app, for links such as the toolbar. Events go to the ingestion host instead. */
export const POSTHOG_UI_HOST = "https://us.posthog.com"

/** The web app's variable names, so a warning names the variable to set. */
export const WEB_POSTHOG_SETTING_NAMES: PostHogSettingNames = { key: "POSTHOG_KEY", host: "POSTHOG_INGEST_HOSTNAME" }

/**
 * The Worker variables (copied into `process.env` by `worker.js`). The deploy
 * fills them from the ops repo; locally they come from `.env.local`.
 */
export interface WebAnalyticsEnv {
  readonly POSTHOG_KEY?: string
  /** A bare hostname, such as a reverse proxy subdomain. Wrangler vars are plain text, so it has no scheme. */
  readonly POSTHOG_INGEST_HOSTNAME?: string
}

const postHogConnectionSchema = z.object({
  key: z.string().min(1),
  apiHost: z.url(),
  uiHost: z.url(),
})

export const analyticsConfigSchema = z.object({
  /** True in the EEA and the UK, and when the country is unknown. */
  consentRequired: z.boolean(),
  /** Null when analytics is off, for example in a checkout without a PostHog key. */
  posthog: postHogConnectionSchema.nullable(),
})

export type PostHogConnection = z.infer<typeof postHogConnectionSchema>
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>

/** Reads the PostHog settings of the web app. A missing or unfilled key turns analytics off. */
export function readWebPostHogSettings(env: WebAnalyticsEnv): PostHogSettingsResult {
  const hostname = env.POSTHOG_INGEST_HOSTNAME?.trim()
  // A value with a scheme (a local PostHog on http://localhost) is used as it is.
  const host = hostname && !/^https?:\/\//i.test(hostname) ? `https://${hostname}` : hostname
  return readPostHogSettings({ key: env.POSTHOG_KEY, host }, WEB_POSTHOG_SETTING_NAMES)
}

/** The answer of the config route for a visitor from `country`. */
export function analyticsConfigFor(country: string | null, settings: PostHogSettingsResult): AnalyticsConfig {
  return {
    consentRequired: isConsentRequired(country),
    posthog: settings.enabled
      ? { key: settings.settings.projectKey, apiHost: settings.settings.host, uiHost: POSTHOG_UI_HOST }
      : null,
  }
}
