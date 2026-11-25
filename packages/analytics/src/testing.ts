import { ProductAnalyticsClient, type AnalyticsDrop, type OptOutCheck } from "./product-analytics-client";
import { MemoryAnalyticsSink } from "./providers/memory/memory-sink";

export { MEMORY_PROVIDER, MemoryAnalyticsSink } from "./providers/memory/memory-sink";

export interface TestProductAnalytics {
  readonly analytics: ProductAnalyticsClient;
  readonly sink: MemoryAnalyticsSink;
  /** Every drop, so a test can see a record that the catalog refused. */
  readonly drops: AnalyticsDrop[];
}

/** A real client over a memory sink. Call `await analytics.flush()` before reading the sink. */
export function createTestProductAnalytics(options: { readonly isOptedOut?: OptOutCheck } = {}): TestProductAnalytics {
  const sink = new MemoryAnalyticsSink();
  const drops: AnalyticsDrop[] = [];
  const analytics = new ProductAnalyticsClient({
    sink,
    onDrop: (drop) => drops.push(drop),
    ...(options.isOptedOut ? { isOptedOut: options.isOptedOut } : {}),
  });
  return { analytics, sink, drops };
}
