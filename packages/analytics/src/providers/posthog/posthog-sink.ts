import { PostHog, type PostHogOptions } from "posthog-node";
import type { PostHogSettings } from "../../config";
import type { AnalyticsGroups } from "../../product-analytics";
import type { AnalyticsRecord, AnalyticsSink } from "../../sink";

export const POSTHOG_PROVIDER = "posthog";

/**
 * `batched` suits a long-lived process such as the Node origin: the SDK sends
 * in the background. `immediate` suits a Worker, which can stop before a
 * background send runs; the Worker passes `flush()` to `waitUntil`.
 */
export type PostHogDelivery = "batched" | "immediate";

const DELIVERY_OPTIONS = {
  batched: {},
  immediate: { flushAt: 1, flushInterval: 0 },
} as const satisfies Record<PostHogDelivery, PostHogOptions>;

/** How long `shutdown` waits for queued records before it gives up. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface PostHogSinkOptions {
  readonly settings: PostHogSettings;
  readonly delivery: PostHogDelivery;
  /** Delivery errors. Default: one structured warning each. */
  readonly onError?: (error: unknown) => void;
}

/** Sends records through `posthog-node`. Records come only from `ProductAnalyticsClient`. */
export class PostHogSink implements AnalyticsSink {
  readonly provider = POSTHOG_PROVIDER;
  readonly #client: PostHog;

  constructor(options: PostHogSinkOptions) {
    this.#client = new PostHog(options.settings.projectKey, {
      host: options.settings.host,
      ...DELIVERY_OPTIONS[options.delivery],
      // The server's own address says nothing about where the person is.
      disableGeoip: true,
      // Doxa reports its errors itself, with route context (`captureException`).
      enableExceptionAutocapture: false,
    });
    this.#client.on("error", options.onError ?? logPostHogError);
  }

  send(record: AnalyticsRecord): void {
    switch (record.kind) {
      case "event":
        this.#client.capture({
          distinctId: record.distinctId,
          event: record.event,
          properties: { ...record.properties },
          groups: definedGroups(record.groups),
        });
        return;
      case "person":
        this.#client.setPersonProperties({
          distinctId: record.distinctId,
          properties: { ...record.properties },
          propertiesOnce: { ...record.firstProperties },
        });
        return;
      case "group":
        this.#client.groupIdentify({
          groupType: record.groupType,
          groupKey: record.groupKey,
          properties: { ...record.properties },
        });
        return;
      case "exception":
        // Without a distinct ID, PostHog stores the error without a person.
        this.#client.captureException(record.error, {
          ...(record.distinctId ? { distinctId: record.distinctId } : {}),
          properties: { ...record.properties, ...(record.sessionId ? { $session_id: record.sessionId } : {}) },
        });
        return;
    }
  }

  flush(): Promise<void> {
    return this.#client.flush();
  }

  shutdown(): Promise<void> {
    return this.#client.shutdown(SHUTDOWN_TIMEOUT_MS);
  }
}

function definedGroups(groups: AnalyticsGroups): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [type, key] of Object.entries(groups)) {
    if (key !== undefined) defined[type] = key;
  }
  return defined;
}

function logPostHogError(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(JSON.stringify({ service: "analytics", event: "analytics.provider_error", provider: POSTHOG_PROVIDER, reason }));
}
