/** A heartbeat ping must not hold the cron tick open when the monitor is slow. */
export const CRON_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface CronHeartbeatSummary {
  jobs: number;
  failed: number;
}

/**
 * Tells the uptime monitor that a cron tick ran to the end. It waits for every
 * job of the tick, then sends one POST to the heartbeat URL with the count of
 * failed jobs. A failed job still counts as a completed tick: the jobs log
 * their own errors, and a missing ping is kept for a tick that stops or never
 * starts. Without a URL it does nothing, so local and test runs send nothing.
 */
export async function reportCronHeartbeat(
  url: string | undefined,
  jobs: readonly Promise<unknown>[],
  fetchImpl: typeof fetch = fetch,
): Promise<CronHeartbeatSummary | null> {
  if (!url) return null;
  const results = await Promise.allSettled(jobs);
  const summary = {
    jobs: results.length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(CRON_HEARTBEAT_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`The cron heartbeat got status ${response.status}.`);
  } catch (cause) {
    console.warn("The cron heartbeat failed.", cause instanceof Error ? cause.message : cause);
  }
  return summary;
}
