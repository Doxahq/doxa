import { NOOP_PRODUCT_ANALYTICS, type ProductAnalytics } from "@doxahq/analytics";
import type { Env } from "../../env";

/**
 * Product analytics, as the composition root provides it. The Node origin
 * keeps one PostHog sink for the process (`runtime/node`); a Worker such as
 * `doxa-mcp` builds one for each request and flushes it with `waitUntil`.
 * Feature code never builds a sink: it calls `productAnalyticsOf(env)`.
 */
export interface ProductAnalyticsBinding {
  /**
   * The analytics of one request or cron tick. The opt-out check reads that
   * env's database scope. The same env returns the same client, so one
   * `flush()` covers every record of the request.
   */
  forEnv(env: Env): ProductAnalytics;
  /**
   * The person changed their privacy settings in this process, so its
   * opt-out cache takes the new value at once.
   */
  optOutChanged?(userId: string, optedOut: boolean): void;
}

/** The env's product analytics, or a no-op when the runtime has none (local Worker dev, self-hosting). */
export function productAnalyticsOf(env: Env): ProductAnalytics {
  return env.PRODUCT_ANALYTICS?.forEnv(env) ?? NOOP_PRODUCT_ANALYTICS;
}
