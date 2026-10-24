import { describe, expect, test } from "vitest";
import { createMemoryRepoMapCache, type RepoMapStats } from "@doxahq/agent";
import { hostedRepoMapOptions, repoMapStageEvent } from "../src/repo-map";

const stats: RepoMapStats = {
  fileCount: 120,
  sourceFileCount: 80,
  symbolCount: 400,
  areaCount: 5,
  renderedFileCount: 30,
  tokenEstimate: 1_480,
};

describe("repository map stage events", () => {
  test("reports a built map with its size and build time", () => {
    expect(repoMapStageEvent({ status: "ready", cacheHit: false, durationMs: 42, stats })).toEqual({
      type: "repo_map_ready",
      message: "Repository map built in 42ms (80 files).",
      data: { cacheHit: false, durationMs: 42, ...stats },
    });
  });

  test("reports a cache hit", () => {
    expect(repoMapStageEvent({ status: "ready", cacheHit: true, durationMs: 1, stats })).toMatchObject({
      type: "repo_map_ready",
      message: "Repository map loaded from cache (80 files).",
      data: { cacheHit: true },
    });
  });

  test("reports why a map was skipped", () => {
    expect(repoMapStageEvent({ status: "skipped", reason: "too many files", durationMs: 5 })).toEqual({
      type: "repo_map_skipped",
      message: "Repository map unavailable; exploring without it.",
      data: { reason: "too many files", durationMs: 5 },
    });
  });
});

describe("hosted repository map options", () => {
  test("keys by the snapshot tree hash and forwards telemetry as a stage event", async () => {
    const cache = createMemoryRepoMapCache();
    const emitted: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const options = hostedRepoMapOptions({
      sourceTreeHash: "f".repeat(40),
      cache,
      emitEvent: async (type, _message, data) => {
        emitted.push({ type, data });
      },
    });

    expect(options.sourceTreeHash).toBe("f".repeat(40));
    expect(options.cache).toBe(cache);
    await options.onTelemetry?.({ status: "skipped", reason: "limit", durationMs: 3 });
    expect(emitted).toEqual([{ type: "repo_map_skipped", data: { reason: "limit", durationMs: 3 } }]);
  });

  test("fingerprints the checkout when there is no snapshot", () => {
    const options = hostedRepoMapOptions({ emitEvent: async () => {} });
    expect(options).not.toHaveProperty("sourceTreeHash");
    expect(options.cache).toBeDefined();
  });
});
