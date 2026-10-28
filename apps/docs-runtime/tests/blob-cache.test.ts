import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadFrozenArtifactSetByName } from "@doxahq/docs-artifact-fixtures";
import {
  VERSION_OBJECT_CACHE_ORIGIN,
  versionTreeKey,
  type VersionObjectFetcher,
} from "@doxahq/docs-engine";
import { DocsBlobCache } from "../src/blob-cache";
import {
  readBlobCacheRollout,
  usesBlobCache,
} from "../src/blob-cache-rollout";
import { RuntimeSourceApi } from "../src/index";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { testExecutionContext } from "./support/execution-context";
import { createTreeBucket } from "./support/tree-bucket";

const set = loadFrozenArtifactSetByName(2, "starter");
const page = set.manifest.pages.find((item) => item.href !== "/");

beforeEach(() => resetRuntimeSourceCachesForTests());
afterEach(() => {
  resetRuntimeSourceCachesForTests();
  vi.restoreAllMocks();
});

function createEnv(
  bucket: R2Bucket,
  vars: Partial<RuntimeSourceEnv> = {},
): RuntimeSourceEnv {
  return {
    DOCS_BUCKET: bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
    ...vars,
  };
}

/**
 * The Workers Cache in front of a `DocsBlobCache` over `bucket`: a miss runs
 * the entrypoint and keeps a cacheable 200; a hit does not.
 */
function tieredCacheOver(bucket: R2Bucket) {
  const entrypoint = new DocsBlobCache(
    testExecutionContext(),
    createEnv(bucket),
  );
  const entries = new Map<string, Uint8Array>();
  const cache: VersionObjectFetcher = {
    fetch: vi.fn(async (request: Request) => {
      const cached = entries.get(request.url);
      if (cached) {
        return new Response(cached.slice(), {
          headers: { "cf-cache-status": "HIT" },
        });
      }
      const response = await entrypoint.fetch(request);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.headers.get("cache-control")?.startsWith("public")) {
        entries.set(request.url, bytes);
      }
      return new Response(bytes, {
        status: response.status,
        headers: { "cf-cache-status": "MISS" },
      });
    }),
  };
  return { cache, entries };
}

function routeData(env: RuntimeSourceEnv, cache: VersionObjectFetcher | null) {
  return runResolvedRuntimeRequest(
    env,
    {
      resolution: set.resolution,
      operation: "getRouteData",
      payload: { pathname: page!.href },
    },
    cache,
  );
}

function loggedReads(info: { mock: { calls: unknown[][] } }) {
  const lines = info.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("docs_runtime_reads"));
  return JSON.parse(lines.at(-1)!);
}

describe("blob cache rollout", () => {
  test("is off by default", () => {
    expect(readBlobCacheRollout({}).mode).toBe("off");
  });

  test("includes every site in all mode", () => {
    const rollout = readBlobCacheRollout({ DOXA_PROD_BLOB_CACHE_MODE: "all" });
    expect(usesBlobCache(rollout, "any-site")).toBe(true);
  });

  test("includes only listed sites in allowlist mode", () => {
    const rollout = readBlobCacheRollout({
      DOXA_PROD_BLOB_CACHE_MODE: "allowlist",
      DOXA_PROD_BLOB_CACHE_SITE_IDS: " site-a, site-b ,",
    });
    expect(usesBlobCache(rollout, "site-a")).toBe(true);
    expect(usesBlobCache(rollout, "site-b")).toBe(true);
    expect(usesBlobCache(rollout, "site-c")).toBe(false);
  });

  test("falls back to off with one warning for an invalid mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { DOXA_PROD_BLOB_CACHE_MODE: "ALL" };

    expect(readBlobCacheRollout(env).mode).toBe("off");
    expect(readBlobCacheRollout(env).mode).toBe("off");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "docs_runtime_blob_cache_invalid_mode",
      value: "ALL",
      fallback: "off",
    });
  });
});

describe("DocsBlobCache", () => {
  test("serves the tree of a version folder", async () => {
    const { bucket } = createTreeBucket(set.objects);
    const entrypoint = new DocsBlobCache(
      testExecutionContext(),
      createEnv(bucket),
    );

    const response = await entrypoint.fetch(
      new Request(
        `${VERSION_OBJECT_CACHE_ORIGIN}/${versionTreeKey(set.artifactPrefix)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("refuses a logical key", async () => {
    const { bucket } = createTreeBucket(set.objects);
    const entrypoint = new DocsBlobCache(
      testExecutionContext(),
      createEnv(bucket),
    );

    const response = await entrypoint.fetch(
      new Request(
        `${VERSION_OBJECT_CACHE_ORIGIN}/${set.artifactPrefix}/manifest.json`,
      ),
    );

    expect(response.status).toBe(400);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});

describe("route data through the blob cache", () => {
  test("a new isolate reads every tree and blob from the tiered cache", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { bucket } = createTreeBucket(set.objects);
    const { cache } = tieredCacheOver(bucket);
    const vars = { DOXA_PROD_BLOB_CACHE_MODE: "all" };

    expect(await routeData(createEnv(bucket, vars), cache)).toMatchObject({
      ok: true,
    });
    const warm = loggedReads(info);
    expect(warm.r2Reads).toBeGreaterThan(0);
    expect(warm.blobCacheHits).toBe(0);

    // Another bucket object stands for another isolate: its memory is empty.
    resetRuntimeSourceCachesForTests();
    const cold: R2Bucket = Object.create(bucket);
    vi.mocked(bucket.get).mockClear();

    expect(await routeData(createEnv(cold, vars), cache)).toMatchObject({
      ok: true,
    });
    const logged = loggedReads(info);
    expect(logged).toMatchObject({ edgeCacheHits: 0, r2Reads: 0 });
    expect(logged.blobCacheHits).toBe(warm.r2Reads);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  test("reads R2 directly when the rollout is off", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { bucket } = createTreeBucket(set.objects);
    const { cache } = tieredCacheOver(bucket);

    expect(await routeData(createEnv(bucket), cache)).toMatchObject({
      ok: true,
    });
    expect(cache.fetch).not.toHaveBeenCalled();
    expect(loggedReads(info).blobCacheHits).toBe(0);
  });

  test("reads R2 directly for a site outside the allowlist", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { bucket } = createTreeBucket(set.objects);
    const { cache } = tieredCacheOver(bucket);
    const env = createEnv(bucket, {
      DOXA_PROD_BLOB_CACHE_MODE: "allowlist",
      DOXA_PROD_BLOB_CACHE_SITE_IDS: "another-site",
    });

    expect(await routeData(env, cache)).toMatchObject({ ok: true });
    expect(cache.fetch).not.toHaveBeenCalled();
  });

  test("RuntimeSourceApi reads through the DocsBlobCache of its own ctx", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { bucket } = createTreeBucket(set.objects);
    const { cache } = tieredCacheOver(bucket);
    const api = new RuntimeSourceApi(
      testExecutionContext({ DocsBlobCache: cache }),
      createEnv(bucket, {
        DOXA_PROD_BLOB_CACHE_MODE: "allowlist",
        DOXA_PROD_BLOB_CACHE_SITE_IDS: set.resolution.siteId,
      }),
    );

    expect(
      await api.request({
        resolution: set.resolution,
        operation: "getRouteData",
        payload: { pathname: page!.href },
      }),
    ).toMatchObject({ ok: true });
    expect(cache.fetch).toHaveBeenCalled();
  });
});
