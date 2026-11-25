import type { AnalyticsRecord } from "@doxahq/analytics";
import { createTestProductAnalytics, type TestProductAnalytics } from "@doxahq/analytics/testing";
import type { ProductAnalyticsBinding } from "../../src/services/analytics/product-analytics";

type EventRecord = Extract<AnalyticsRecord, { kind: "event" }>;

export interface RecordingProductAnalytics extends TestProductAnalytics {
  /** Set as `env.PRODUCT_ANALYTICS`: every env gets this one client. */
  readonly binding: ProductAnalyticsBinding;
  /** The events that passed the catalog, after the client's background work. */
  events(): Promise<EventRecord[]>;
}

/** A real analytics client over a memory sink, for tests of the API's events. */
export function recordingProductAnalytics(): RecordingProductAnalytics {
  const test = createTestProductAnalytics();
  return {
    ...test,
    binding: { forEnv: () => test.analytics },
    async events() {
      await test.analytics.flush();
      return test.sink.recordsOf("event");
    },
  };
}
