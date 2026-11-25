/**
 * The variables that configure PostHog on a server. A Worker `Env` and the
 * Node origin's variables extend this interface. Both are optional: without a
 * key, analytics is off and Doxa runs as before.
 *
 * Never commit a value. This repo is public: production values come from the
 * ops repo (Wrangler `${OPS_POSTHOG_*}` placeholders, and the Node origin's
 * environment in Terraform).
 */
export interface AnalyticsEnv {
  /** The PostHog project key (`phc_…`). */
  POSTHOG_KEY?: string;
  /** The ingestion host. Default: PostHog US Cloud. */
  POSTHOG_HOST?: string;
}

export const POSTHOG_US_HOST = "https://us.i.posthog.com";

export interface PostHogSettings {
  readonly projectKey: string;
  readonly host: string;
}

/** The names of the two settings, so a warning names the variable that the reader must set. */
export interface PostHogSettingNames {
  readonly key: string;
  readonly host: string;
}

export const SERVER_POSTHOG_SETTING_NAMES: PostHogSettingNames = { key: "POSTHOG_KEY", host: "POSTHOG_HOST" };

export type PostHogSettingsResult =
  | { readonly enabled: true; readonly settings: PostHogSettings }
  | {
      readonly enabled: false;
      readonly reason: "missing_key" | "invalid_host";
      /** Say it outside production. In production, analytics stays off without a word. */
      readonly warning: string;
    };

/**
 * Reads the PostHog settings. A missing key or a bad host turns analytics
 * off instead of stopping start-up: analytics must never take Doxa down.
 */
export function readPostHogSettings(
  values: { readonly key: string | undefined; readonly host: string | undefined },
  names: PostHogSettingNames = SERVER_POSTHOG_SETTING_NAMES,
): PostHogSettingsResult {
  const projectKey = filledValue(values.key);
  if (!projectKey) {
    return {
      enabled: false,
      reason: "missing_key",
      warning:
        `${names.key} variable required by PostHog is missing or un-configured, this causes events to be ` +
        `silently missed. This error stops appearing once ${names.key} is configured`,
    };
  }
  const host = filledValue(values.host) ?? POSTHOG_US_HOST;
  if (!isIngestionHost(host)) {
    return {
      enabled: false,
      reason: "invalid_host",
      warning: `${names.host} is not an https URL, so analytics is off. Set it to an ingestion host such as ${POSTHOG_US_HOST}.`,
    };
  }
  return { enabled: true, settings: { projectKey, host: host.replace(/\/+$/, "") } };
}

export function postHogSettingsFromEnv(env: AnalyticsEnv): PostHogSettingsResult {
  return readPostHogSettings({ key: env.POSTHOG_KEY, host: env.POSTHOG_HOST });
}

/**
 * The trimmed value, or undefined when it is blank or still holds an unfilled
 * `${OPS_*}` placeholder: a checkout that the ops repo did not fill, such as
 * local development or a self-hosted copy.
 */
function filledValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

/** An https URL, or plain http on a loopback host for a local PostHog. */
function isIngestionHost(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}
