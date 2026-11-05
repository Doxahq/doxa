import type {
  DocsSearchRemoteProvider,
  DocsSearchUsageOutcome,
} from "@doxahq/contracts/docs-search";

/**
 * Records one search for the cost report. No field holds the search text or
 * the visitor's address. A metric must never fail a search. `responseBytes` is
 * what the visitor received: for an `answered` search it also estimates the
 * provider's traffic, and a `cached` answer costs the provider nothing.
 */
export function recordSearchUsage(
  dataset: AnalyticsEngineDataset | undefined,
  point: {
    siteId: string;
    provider: DocsSearchRemoteProvider;
    outcome: DocsSearchUsageOutcome;
    elapsedMs: number;
    responseBytes: number;
  },
): void {
  try {
    dataset?.writeDataPoint({
      indexes: [point.siteId],
      blobs: [point.siteId, point.provider, point.outcome],
      doubles: [point.elapsedMs, point.responseBytes],
    });
  } catch {
    // Nothing to do.
  }
}
