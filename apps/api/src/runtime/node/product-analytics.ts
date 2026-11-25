import { postHogSettingsFromEnv, type AnalyticsSink, type PostHogSettings } from "@doxahq/analytics";
import { PostHogSink } from "@doxahq/analytics/posthog";
import { AnalyticsOptOutCache } from "../../services/analytics/opt-out-cache";
import type { ProductAnalyticsBinding } from "../../services/analytics/product-analytics";
import { createProductAnalyticsBinding } from "../../services/analytics/product-analytics-binding";
import type { ApiVars } from "./config";

/** Product analytics of the Node origin, and what must close at shutdown. */
export interface NodeProductAnalytics {
  /** Unset when analytics is off: `productAnalyticsOf` is then a no-op. */
  readonly binding?: ProductAnalyticsBinding;
  /** Sends what is queued and stops the sink. It never rejects. */
  close(): Promise<void>;
}

export interface NodeProductAnalyticsOptions {
  /** Tests pass a memory sink. */
  readonly createSink?: (settings: PostHogSettings) => AnalyticsSink;
  readonly optOuts?: AnalyticsOptOutCache;
  readonly warn?: (message: string) => void;
}

/**
 * Reads the PostHog settings once at start-up. The process keeps one batched
 * sink: the SDK sends in the background, and each request or cron tick gets
 * its own client over it. A missing key turns analytics off; outside
 * production the origin says so once.
 */
export function createNodeProductAnalytics(
  vars: Pick<ApiVars, "POSTHOG_KEY" | "POSTHOG_HOST" | "DOXA_RUNTIME_ENVIRONMENT">,
  options: NodeProductAnalyticsOptions = {},
): NodeProductAnalytics {
  const settings = postHogSettingsFromEnv(vars);
  if (!settings.enabled) {
    if (vars.DOXA_RUNTIME_ENVIRONMENT !== "production") (options.warn ?? console.warn)(settings.warning);
    return { close: async () => {} };
  }
  const createSink = options.createSink ?? ((postHog) => new PostHogSink({ settings: postHog, delivery: "batched" }));
  const sink = createSink(settings.settings);
  return {
    binding: createProductAnalyticsBinding({ sink, optOuts: options.optOuts ?? new AnalyticsOptOutCache() }),
    close: () => sink.shutdown().catch(() => undefined),
  };
}
