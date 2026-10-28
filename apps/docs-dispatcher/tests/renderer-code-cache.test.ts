import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import {
  DocsRendererCodeCache,
  isTrustedRendererCodeRequest,
} from "../src/renderer-code-cache-entrypoint";
import {
  RENDERER_CODE_CACHE_FORMAT,
  createRendererCodeCacheUrl,
  createRendererCodeReaders,
  type RendererCodeCacheProps,
} from "../src/renderer-code-readers";

const BUILD_ID = "build-1";
const OBJECT_KEY = "renderer-code/build-1.json.gz";
const deployEnv = {
  DOXA_RENDERER_BUILD_ID: BUILD_ID,
  DOXA_RENDERER_PACKAGE_KEY: OBJECT_KEY,
};
const props: RendererCodeCacheProps = {
  buildId: BUILD_ID,
  objectKey: OBJECT_KEY,
  format: RENDERER_CODE_CACHE_FORMAT,
};

function createBucket(body: string | null) {
  const get = vi.fn(async (_key: string) =>
    body === null ? null : { body: new Blob([body]).stream() },
  );
  return { bucket: { get } as unknown as R2Bucket, get };
}

function createEntrypoint(
  entryProps: RendererCodeCacheProps,
  bucket: R2Bucket,
): DocsRendererCodeCache {
  return new DocsRendererCodeCache(
    { props: entryProps } as never,
    { ...deployEnv, RENDERER_CODE_BUCKET: bucket } as never,
  );
}

describe("DocsRendererCodeCache", () => {
  test("stores the deployed package bytes for a year", async () => {
    const { bucket, get } = createBucket("gzip-bytes");
    const response = await createEntrypoint(props, bucket).fetch(
      new Request(createRendererCodeCacheUrl(BUILD_ID)),
    );

    expect(get).toHaveBeenCalledWith(OBJECT_KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=31536000");
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(await response.text()).toBe("gzip-bytes");
  });

  test("does not store a missing package", async () => {
    const { bucket } = createBucket(null);
    const response = await createEntrypoint(props, bucket).fetch(
      new Request(createRendererCodeCacheUrl(BUILD_ID)),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each([
    [
      "another build",
      { ...props, buildId: "build-2" },
      createRendererCodeCacheUrl("build-2"),
    ],
    [
      "another key",
      { ...props, objectKey: "renderer-code/other.json.gz" },
      createRendererCodeCacheUrl(BUILD_ID),
    ],
    [
      "another format",
      { ...props, format: RENDERER_CODE_CACHE_FORMAT + 1 },
      createRendererCodeCacheUrl(BUILD_ID),
    ],
    ["another URL", props, "https://renderer-code.internal/v1/other"],
  ])("refuses %s without reading the bucket", async (_case, entryProps, url) => {
    const { bucket, get } = createBucket("gzip-bytes");
    const response = await createEntrypoint(entryProps, bucket).fetch(
      new Request(url),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(get).not.toHaveBeenCalled();
  });

  test("accepts only GET", () => {
    expect(
      isTrustedRendererCodeRequest(
        new Request(createRendererCodeCacheUrl(BUILD_ID), { method: "POST" }),
        props,
        deployEnv,
      ),
    ).toBe(false);
  });
});

describe("createRendererCodeReaders", () => {
  function cacheReturning(response: Response) {
    const fetch = vi.fn(async (_url: string) => response);
    const cache = vi.fn((_options: { props: RendererCodeCacheProps }) => ({
      fetch,
    }));
    return { cache: cache as never, calls: cache, fetch };
  }

  test.each([
    ["HIT", "cache"],
    ["STALE", "cache"],
    ["MISS", "r2"],
    [null, "r2"],
  ])("cf-cache-status %s reports %s", async (status, source) => {
    const { bucket } = createBucket("bucket-bytes");
    const { cache, calls, fetch } = cacheReturning(
      new Response("cached-bytes", {
        headers: status ? { "cf-cache-status": status } : {},
      }),
    );
    const [cached] = createRendererCodeReaders({
      cache,
      bucket,
      buildId: BUILD_ID,
      objectKey: OBJECT_KEY,
    });

    const bytes = await cached?.();

    expect(bytes?.source).toBe(source);
    expect(calls).toHaveBeenCalledWith({ props });
    expect(fetch).toHaveBeenCalledWith(createRendererCodeCacheUrl(BUILD_ID));
  });

  test("the cache reader fails on an error answer, and the bucket reader follows", async () => {
    const { bucket, get } = createBucket("bucket-bytes");
    const { cache } = cacheReturning(new Response("nope", { status: 500 }));
    const [cached, direct] = createRendererCodeReaders({
      cache,
      bucket,
      buildId: BUILD_ID,
      objectKey: OBJECT_KEY,
    });

    await expect(cached?.()).rejects.toThrow("500");
    const bytes = await direct?.();
    expect(bytes?.source).toBe("r2");
    expect(get).toHaveBeenCalledWith(OBJECT_KEY);
  });
});
