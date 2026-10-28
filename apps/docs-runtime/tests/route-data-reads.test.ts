import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listFrozenArtifactSets } from "@doxahq/docs-artifact-fixtures";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { createTreeBucket } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const READ_DELAY_MS = 20;

beforeEach(() => {
  resetRuntimeSourceCachesForTests();
});

afterEach(() => {
  resetRuntimeSourceCachesForTests();
  vi.restoreAllMocks();
});

/**
 * Wraps the tree bucket so every read takes READ_DELAY_MS and records how many
 * reads run at the same time. A cold R2 read from a far data center takes
 * hundreds of milliseconds, so reads that wait for each other add up.
 */
function createSlowBucket(objects: Record<string, string>) {
  const { bucket } = createTreeBucket(objects);
  const stats = { reads: 0, inFlight: 0, maxInFlight: 0 };
  const realGet = bucket.get.bind(bucket);
  const slow = {
    ...bucket,
    async get(...args: Parameters<R2Bucket["get"]>) {
      stats.reads += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
        return await realGet(...args);
      } finally {
        stats.inFlight -= 1;
      }
    },
  } as unknown as R2Bucket;
  return { bucket: slow, stats };
}

function showcaseSet() {
  const set = listFrozenArtifactSets().find(
    (item) => item.name === "component-showcase",
  );
  if (!set) throw new Error("The component-showcase fixture is missing.");
  return set;
}

describe("getRouteData reads", () => {
  test("starts the independent artifact reads together", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();
    const page = set.manifest.pages.find((item) => item.href !== "/");
    expect(page).toBeDefined();
    const { bucket, stats } = createSlowBucket({ ...set.objects });
    const env: RuntimeSourceEnv = {
      DOCS_BUCKET: bucket,
      DOCS_CONTENT_TOKEN: "test-runtime-token",
      DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
    };

    const result = await runResolvedRuntimeRequest(env, {
      resolution: set.resolution,
      operation: "getRouteData",
      payload: { pathname: page!.href },
    });

    expect(result).toMatchObject({ ok: true });
    // Sections, site config and the home page reads overlap the page read.
    expect(stats.maxInFlight).toBeGreaterThanOrEqual(3);
  });

  test("logs one read summary line without the timing flag", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();
    const { bucket, stats } = createSlowBucket({ ...set.objects });

    await runResolvedRuntimeRequest(
      {
        DOCS_BUCKET: bucket,
        DOCS_CONTENT_TOKEN: "test-runtime-token",
        DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
      },
      {
        resolution: set.resolution,
        operation: "getRouteData",
        payload: { pathname: "/" },
      },
    );

    const lines = info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("docs_runtime_reads"));
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!);
    expect(logged).toMatchObject({
      event: "docs_runtime_reads",
      operation: "getRouteData",
      siteId: set.resolution.siteId,
      publishedVersionId: set.resolution.publishedVersionId,
      ok: true,
    });
    // Each logical read goes through the tree reader, which can issue more
    // than one bucket call (the tree, then the blob).
    expect(logged.reads).toBeGreaterThan(0);
    expect(logged.reads).toBeLessThanOrEqual(stats.reads);
    expect(logged.readMs).toBeGreaterThanOrEqual(READ_DELAY_MS);
  });
});
