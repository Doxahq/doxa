import { postHogSettingsFromEnv, type AnalyticsEnv } from "@doxahq/analytics";
import { PostHogSink } from "@doxahq/analytics/posthog";
import type { Env } from "../../env";
import type { PrivacySettingsStore } from "../privacy/privacy-settings-store";
import type { AnalyticsOptOutCache } from "./opt-out-cache";
import type { ProductAnalyticsBinding } from "./product-analytics";
import { createProductAnalyticsBinding } from "./product-analytics-binding";

export interface WorkerProductAnalytics {
  /** Unset when analytics is off: `productAnalyticsOf` is then a no-op. */
  readonly binding?: ProductAnalyticsBinding;
  /**
   * Sends every record of the request. It never rejects. The Worker passes
   * it to `waitUntil`, before it closes the request's database scope: the
   * opt-out check still reads that database.
   */
  flush(): Promise<void>;
}

export interface WorkerProductAnalyticsOptions {
  /** One cache for the isolate, so each request does not read the settings again. */
  readonly optOuts: AnalyticsOptOutCache;
  readonly privacySettingsFor?: (env: Env) => PrivacySettingsStore;
}

/**
 * Product analytics for one Worker request, such as a `doxa-mcp` request. A
 * Worker can stop before a background send runs, so the sink sends each
 * record at once and the request flushes it in `waitUntil`.
 */
export function createWorkerProductAnalytics(
  vars: AnalyticsEnv,
  options: WorkerProductAnalyticsOptions,
): WorkerProductAnalytics {
  const settings = postHogSettingsFromEnv(vars);
  if (!settings.enabled) return { flush: async () => {} };
  const sink = new PostHogSink({ settings: settings.settings, delivery: "immediate" });
  const binding = createProductAnalyticsBinding({
    sink,
    optOuts: options.optOuts,
    ...(options.privacySettingsFor ? { privacySettingsFor: options.privacySettingsFor } : {}),
  });
  const used = new Set<Env>();
  return {
    binding: {
      forEnv(env) {
        used.add(env);
        return binding.forEnv(env);
      },
      optOutChanged: binding.optOutChanged,
    },
    flush: async () => {
      await Promise.all([...used].map((env) => binding.forEnv(env).flush()));
    },
  };
}
