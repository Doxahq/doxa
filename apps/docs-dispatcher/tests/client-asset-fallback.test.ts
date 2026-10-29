import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  // The warm Durable Objects (M28) are exported from the same module.
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import {
  CLIENT_ASSET_KEY_PREFIX,
  DocsClientAssetCache,
  clientAssetObjectKey,
  isTrustedClientAssetRequest,
} from "../src/client-asset-cache-entrypoint";
import {
  CLIENT_ASSET_CACHE_FORMAT,
  createClientAssetCacheUrl,
  handleClientAssetFallback,
  matchClientAssetRequest,
  parseClientAssetFallbackMode,
  type ClientAssetCacheProps,
} from "../src/client-asset-fallback";
import worker from "../src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (path: string, init?: RequestInit) =>
  new Request(`https://docs.example.com${path}`, init);

function createBucket(body: string | null) {
  const get = vi.fn(async (_key: string) =>
    body === null
      ? null
      : {
          body: new Blob([body]).stream(),
          // An uploaded object's metadata must never reach a response.
          httpMetadata: {
            contentType: "text/html",
            cacheControl: "no-store",
            contentDisposition: "attachment",
          },
          customMetadata: { "set-cookie": "a=b" },
        },
  );
  return { bucket: { get } as unknown as R2Bucket, get };
}

function createEntrypoint(props: ClientAssetCacheProps, bucket: R2Bucket) {
  return new DocsClientAssetCache(
    { props } as never,
    { RENDERER_CODE_BUCKET: bucket } as never,
  );
}

const props = (file: string): ClientAssetCacheProps => ({
  file,
  format: CLIENT_ASSET_CACHE_FORMAT,
});

describe("client asset path pattern", () => {
  // Real names from apps/docs-template/dist/client/assets.
  test.each([
    "cytoscape.esm-D3_iZ_3b.js",
    "_-CirsNNBV.js",
    "component-TV8FFGA4.js",
    "chunk-2GRJ4B5K-BhPn5XqH.js",
    "cose-bilkent-JH36ORCC-B-cINXDF.js",
    "styles-B1c2D3e4.css",
  ])("accepts %s", (file) => {
    expect(matchClientAssetRequest(request(`/assets/${file}`))).toBe(file);
    expect(
      matchClientAssetRequest(request(`/assets/${file}`, { method: "HEAD" })),
    ).toBe(file);
  });

  test.each([
    // Traversal and encoded names.
    "/assets/a..b-AAAAAAAA.js",
    "/assets/..-AAAAAAAA.js",
    "/assets/%2e%2e-AAAAAAAA.js",
    "/assets/a%2Fb-AAAAAAAA.js",
    "/assets/a%20b-AAAAAAAA.js",
    // A slash: no nested path, no other prefix.
    "/assets/sub/a-AAAAAAAA.js",
    "/assets/renderer-code/build-AAAAAAAA.js",
    "/renderer-code/build-AAAAAAAA.js",
    "/releases/a-AAAAAAAA.js",
    // Wrong extension or hash.
    "/assets/a-AAAAAAAA.mjs",
    "/assets/a-AAAAAAAA.json",
    "/assets/a-AAAAAAAA.json.gz",
    "/assets/a-AAAAAAAA.js.map",
    "/assets/a-AAAAAAA.js",
    "/assets/a-AAAAAAAAA.js",
    "/assets/aAAAAAAAA.js",
    "/assets/.hidden-AAAAAAAA.js",
    "/assets/-AAAAAAAA.js",
    // Customer images still go to the version assets.
    "/assets/diagram.png",
    "/assets/my-diagram.svg",
    "/assets/screenshot-12345678.png",
  ])("rejects %s", (path) => {
    expect(matchClientAssetRequest(request(path))).toBeNull();
  });

  test("rejects a traversal that the URL parser resolves away", () => {
    expect(
      matchClientAssetRequest(request("/assets/../renderer-code/a-AAAAAAAA.js")),
    ).toBeNull();
    expect(
      matchClientAssetRequest(request("/assets/%2e%2e/releases/a-AAAAAAAA.js")),
    ).toBeNull();
  });

  test("rejects a name stem over 120 characters", () => {
    const file = `${"a".repeat(121)}-AAAAAAAA.js`;
    expect(matchClientAssetRequest(request(`/assets/${file}`))).toBeNull();
    expect(
      matchClientAssetRequest(request(`/assets/${file.slice(1)}`)),
    ).not.toBeNull();
  });

  test.each(["POST", "PUT", "DELETE", "OPTIONS"])("rejects %s", (method) => {
    expect(
      matchClientAssetRequest(request("/assets/a-AAAAAAAA.js", { method })),
    ).toBeNull();
  });
});

describe("parseClientAssetFallbackMode", () => {
  test("is off unless exactly on, and warns about an invalid value", () => {
    const warn = vi.fn();
    expect(parseClientAssetFallbackMode(undefined, warn)).toBe("off");
    expect(parseClientAssetFallbackMode("off", warn)).toBe("off");
    expect(parseClientAssetFallbackMode("on", warn)).toBe("on");
    expect(warn).not.toHaveBeenCalled();
    expect(parseClientAssetFallbackMode("ON", warn)).toBe("off");
    expect(parseClientAssetFallbackMode("all", warn)).toBe("off");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("DocsClientAssetCache", () => {
  test.each([
    ["app-AAAAAAAA.js", "text/javascript; charset=utf-8"],
    ["styles-AAAAAAAA.css", "text/css; charset=utf-8"],
  ])("serves %s with allowlisted headers only", async (file, contentType) => {
    const { bucket, get } = createBucket("body");
    const response = await createEntrypoint(props(file), bucket).fetch(
      new Request(createClientAssetCacheUrl(file)),
    );

    expect(get).toHaveBeenCalledWith(`client-assets/v1/assets/${file}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body");
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-type",
      "x-content-type-options",
    ]);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("stores a miss for one minute", async () => {
    const { bucket } = createBucket(null);
    const response = await createEntrypoint(
      props("gone-AAAAAAAA.js"),
      bucket,
    ).fetch(new Request(createClientAssetCacheUrl("gone-AAAAAAAA.js")));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.body).toBeNull();
  });

  test.each([
    {
      name: "a traversal name",
      entryProps: props("../renderer-code/build.json.gz"),
      url: createClientAssetCacheUrl("../renderer-code/build.json.gz"),
    },
    {
      name: "a release key",
      entryProps: props("releases/a-AAAAAAAA.js"),
      url: createClientAssetCacheUrl("releases/a-AAAAAAAA.js"),
    },
    {
      name: "a renderer package name",
      entryProps: props("build-AAAAAAAA.json.gz"),
      url: createClientAssetCacheUrl("build-AAAAAAAA.json.gz"),
    },
    {
      name: "another URL",
      entryProps: props("a-AAAAAAAA.js"),
      url: createClientAssetCacheUrl("b-AAAAAAAA.js"),
    },
    {
      name: "another format",
      entryProps: { file: "a-AAAAAAAA.js", format: 2 },
      url: createClientAssetCacheUrl("a-AAAAAAAA.js"),
    },
  ])("rejects $name without reading R2", async ({ entryProps, url }) => {
    const { bucket, get } = createBucket("body");
    const response = await createEntrypoint(entryProps, bucket).fetch(
      new Request(url),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(get).not.toHaveBeenCalled();
  });

  test("accepts only GET at the internal URL", () => {
    const url = createClientAssetCacheUrl("a-AAAAAAAA.js");
    expect(isTrustedClientAssetRequest(new Request(url), props("a-AAAAAAAA.js"))).toBe(true);
    expect(
      isTrustedClientAssetRequest(
        new Request(url, { method: "HEAD" }),
        props("a-AAAAAAAA.js"),
      ),
    ).toBe(false);
  });

  test("keys every object under the client-assets prefix", () => {
    expect(CLIENT_ASSET_KEY_PREFIX).toBe("client-assets/v1/assets/");
    expect(clientAssetObjectKey("a-AAAAAAAA.js")).toBe(
      "client-assets/v1/assets/a-AAAAAAAA.js",
    );
  });
});

describe("handleClientAssetFallback", () => {
  function createCache(response: () => Response) {
    const fetch = vi.fn(async (_request: Request) => response());
    const entrypoint = vi.fn((_options: { props: ClientAssetCacheProps }) => ({
      fetch,
    }));
    return { cache: () => entrypoint, entrypoint, fetch };
  }

  test("reads the cache with fixed props and URL, and logs the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { cache, entrypoint, fetch } = createCache(
      () =>
        new Response("js", {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cf-cache-status": "HIT",
          },
        }),
    );

    const response = await handleClientAssetFallback(
      request("/assets/cytoscape.esm-D3_iZ_3b.js?x=1", {
        headers: { cookie: "a=b" },
      }),
      { mode: "on", cache },
    );

    expect(entrypoint).toHaveBeenCalledWith({
      props: { file: "cytoscape.esm-D3_iZ_3b.js", format: 1 },
    });
    const forwarded = fetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://client-assets.internal/v1/cytoscape.esm-D3_iZ_3b.js",
    );
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.headers.has("cookie")).toBe(false);
    expect(await response?.text()).toBe("js");
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      event: "docs_client_asset_fallback",
      file: "cytoscape.esm-D3_iZ_3b.js",
      status: 200,
      cacheStatus: "HIT",
    });
  });

  test("answers HEAD from a GET without a body", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { cache, fetch } = createCache(
      () =>
        new Response("js", {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        }),
    );

    const response = await handleClientAssetFallback(
      request("/assets/a-AAAAAAAA.js", { method: "HEAD" }),
      { mode: "on", cache },
    );

    expect(fetch.mock.calls[0]?.[0].method).toBe("GET");
    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
    expect(response?.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  test("does nothing when the mode is off", async () => {
    const { cache, entrypoint } = createCache(() => new Response("js"));
    await expect(
      handleClientAssetFallback(request("/assets/a-AAAAAAAA.js"), {
        mode: "off",
        cache,
      }),
    ).resolves.toBeNull();
    expect(entrypoint).not.toHaveBeenCalled();
  });

  test("leaves customer images to the version assets", async () => {
    const { cache, entrypoint } = createCache(() => new Response("js"));
    await expect(
      handleClientAssetFallback(request("/assets/diagram.png"), {
        mode: "on",
        cache,
      }),
    ).resolves.toBeNull();
    expect(entrypoint).not.toHaveBeenCalled();
  });

  test("runs in the dispatcher before host resolution", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { cache, entrypoint } = createCache(
      () => new Response("old js", { headers: { "cf-cache-status": "MISS" } }),
    );
    const env = {
      DOCS_RESOLVER: { fetch: vi.fn() },
      SHARED_RENDERER: { fetch: vi.fn() },
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE: "on",
    };
    const ctx = {
      exports: { DocsClientAssetCache: cache(), DocsHostCache: vi.fn() },
    };

    const response = await worker.fetch(
      request("/assets/a-AAAAAAAA.js"),
      env as never,
      ctx as never,
    );

    expect(await response.text()).toBe("old js");
    expect(entrypoint).toHaveBeenCalledOnce();
    expect(ctx.exports.DocsHostCache).not.toHaveBeenCalled();
    expect(env.SHARED_RENDERER.fetch).not.toHaveBeenCalled();
  });
});
