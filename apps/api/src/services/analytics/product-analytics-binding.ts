import { ProductAnalyticsClient, type AnalyticsDrop, type AnalyticsSink, type ProductAnalytics } from "@doxahq/analytics";
import type { Env } from "../../env";
import { PrivacySettingsRepository } from "../../repositories/privacy-settings";
import type { PrivacySettingsStore } from "../privacy/privacy-settings-store";
import { cachedOptOutCheck, type AnalyticsOptOutCache } from "./opt-out-cache";
import type { ProductAnalyticsBinding } from "./product-analytics";

export interface ProductAnalyticsBindingOptions {
  readonly sink: AnalyticsSink;
  readonly optOuts: AnalyticsOptOutCache;
  /** Default: the env's `user_privacy_settings` table. */
  readonly privacySettingsFor?: (env: Env) => PrivacySettingsStore;
  /** Default: `logAnalyticsDrop`. */
  readonly onDrop?: (drop: AnalyticsDrop) => void;
}

/**
 * The binding that both composition roots share: one client for each env
 * over one sink, with the opt-out check reading that env's database.
 */
export function createProductAnalyticsBinding(options: ProductAnalyticsBindingOptions): ProductAnalyticsBinding {
  const { sink, optOuts, onDrop } = options;
  const privacySettingsFor = options.privacySettingsFor ?? PrivacySettingsRepository.fromEnv;
  const clients = new WeakMap<Env, ProductAnalytics>();
  return {
    forEnv(env) {
      const existing = clients.get(env);
      if (existing) return existing;
      const client = new ProductAnalyticsClient({
        sink,
        isOptedOut: cachedOptOutCheck(optOuts, () => privacySettingsFor(env)),
        ...(onDrop ? { onDrop } : {}),
      });
      clients.set(env, client);
      return client;
    },
    optOutChanged: (userId, optedOut) => optOuts.remember(userId, optedOut),
  };
}
