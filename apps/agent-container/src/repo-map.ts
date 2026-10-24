import {
  createMemoryRepoMapCache,
  type RepoMapCache,
  type RepoMapOptions,
  type RepoMapTelemetry,
} from "@doxahq/agent";

/**
 * Maps kept by this container process. A snapshot key is its source tree
 * hash, so a warm container serves a repeated revision (a retried stage, a
 * regeneration) without rebuilding. A map is a few kilobytes of text.
 */
const HOSTED_REPO_MAP_CACHE_ENTRIES = 32;
const hostedRepoMapCache = createMemoryRepoMapCache(HOSTED_REPO_MAP_CACHE_ENTRIES);

type RepoMapEventEmitter = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => Promise<void>;

export interface HostedRepoMapInput {
  /** The prepared snapshot's tree hash; without one the checkout is fingerprinted. */
  sourceTreeHash?: string;
  emitEvent: RepoMapEventEmitter;
  /** Overrides the process cache, for tests and a future shared (R2) store. */
  cache?: RepoMapCache;
}

export function hostedRepoMapOptions(input: HostedRepoMapInput): RepoMapOptions {
  return {
    cache: input.cache ?? hostedRepoMapCache,
    ...(input.sourceTreeHash ? { sourceTreeHash: input.sourceTreeHash } : {}),
    onTelemetry: (telemetry) => {
      const event = repoMapStageEvent(telemetry);
      return input.emitEvent(event.type, event.message, event.data);
    },
  };
}

export interface RepoMapStageEvent {
  type: "repo_map_ready" | "repo_map_skipped";
  message: string;
  data: Record<string, unknown>;
}

export function repoMapStageEvent(telemetry: RepoMapTelemetry): RepoMapStageEvent {
  if (telemetry.status === "skipped") {
    return {
      type: "repo_map_skipped",
      message: "Repository map unavailable; exploring without it.",
      data: { reason: telemetry.reason, durationMs: telemetry.durationMs },
    };
  }
  const { stats } = telemetry;
  return {
    type: "repo_map_ready",
    message: telemetry.cacheHit
      ? `Repository map loaded from cache (${stats.sourceFileCount} files).`
      : `Repository map built in ${telemetry.durationMs}ms (${stats.sourceFileCount} files).`,
    data: {
      cacheHit: telemetry.cacheHit,
      durationMs: telemetry.durationMs,
      fileCount: stats.fileCount,
      sourceFileCount: stats.sourceFileCount,
      symbolCount: stats.symbolCount,
      areaCount: stats.areaCount,
      renderedFileCount: stats.renderedFileCount,
      tokenEstimate: stats.tokenEstimate,
    },
  };
}
