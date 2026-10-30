import { describe, expect, test } from "vitest";

import {
  cacheControlFor,
  createHtmlCacheProps,
  isCacheableDocsRequest,
  isContentCacheLifetime,
  isPrerenderableDocsRequest,
  RENDERER_API_ROUTES,
  withHtmlCachePolicy,
  withHostCachePolicy,
  withRouteDataCachePolicy,
  withoutResponseCaching,
} from "../src/cache-policy";

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
  hostname: "docs.example.com",
  domainKind: "custom_domain" as const,
  renderTarget: "production" as const,
};

function htmlRequest(path = "/guide", init: RequestInit = {}) {
  return new Request(`https://docs.example.com${path}`, {
    ...init,
    headers: { accept: "text/html", ...init.headers },
  });
}

describe("docs cache policy", () => {
  test.each(["GET", "HEAD"])("allows anonymous HTML %s requests", (method) => {
    expect(isCacheableDocsRequest(htmlRequest("/guide", { method }))).toBe(
      true,
    );
  });

  test.each<{ name: string; path: string; init: RequestInit }>([
    { name: "POST", path: "/guide", init: { method: "POST" } },
    {
      name: "authorization",
      path: "/guide",
      init: { headers: { authorization: "Bearer private" } },
    },
    {
      name: "reload",
      path: "/guide",
      init: { headers: { "cache-control": "no-cache" } },
    },
    {
      name: "legacy reload",
      path: "/guide",
      init: { headers: { pragma: "no-cache" } },
    },
    {
      name: "range",
      path: "/guide",
      init: { headers: { range: "bytes=0-10" } },
    },
    {
      name: "upgrade",
      path: "/guide",
      init: { headers: { upgrade: "websocket" } },
    },
    {
      name: "JSON",
      path: "/guide",
      init: { headers: { accept: "application/json" } },
    },
    { name: "demo query", path: "/guide?demo=true", init: {} },
    { name: "search", path: "/api/search", init: {} },
    { name: "API playground", path: "/api/echo/v1/notes", init: {} },
    { name: "upper-case search", path: "/API/search", init: {} },
    { name: "server function", path: "/_serverFn/id", init: {} },
    { name: "health", path: "/.well-known/doxa-health", init: {} },
    { name: "markdown", path: "/guide.md", init: {} },
    { name: "encoded API route", path: "/%61pi/search", init: {} },
    { name: "malformed encoding", path: "/%zz", init: {} },
  ])("bypasses $name requests", ({ path, init }) => {
    expect(isCacheableDocsRequest(htmlRequest(path, init))).toBe(false);
  });

  test("caches a request with a cookie: public sites never read cookies (RES-1)", () => {
    const request = htmlRequest("/guide", {
      headers: { cookie: "_ga=GA1.1.123.456; theme=dark" },
    });

    expect(isCacheableDocsRequest(request)).toBe(true);
    expect(isPrerenderableDocsRequest(request)).toBe(true);
  });

  test.each(["/api", "/api/notes/create", "/reference/api/search", "/apis/search"])(
    "caches the docs page %s under an api path (RES-2)",
    (path) => {
      expect(isCacheableDocsRequest(htmlRequest(path))).toBe(true);
    },
  );

  test("bypasses exactly the renderer's own server routes (RES-2)", async () => {
    const { readdir } = await import("node:fs/promises");
    const routes = await readdir(
      new URL("../../docs-template/src/routes/", import.meta.url),
    );
    const apiRoutes = routes
      .filter((file) => /^api\..+\.tsx?$/.test(file) && !file.includes(".test."))
      .map((file) => file.split(".")[1]);

    expect(new Set(apiRoutes)).toEqual(new Set(RENDERER_API_ROUTES));
  });

  test.each<{ name: string; headers: Record<string, string> }>([
    { name: "browser reload", headers: { "cache-control": "max-age=0" } },
    {
      name: "explicit revalidation",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
    },
  ])(
    "keeps a $name eligible for pre-rendering",
    ({ headers }) => {
      const request = htmlRequest("/guide", { headers });

      expect(isCacheableDocsRequest(request)).toBe(false);
      expect(isPrerenderableDocsRequest(request)).toBe(true);
    },
  );

  test.each<{ name: string; headers: Record<string, string> }>([
    {
      name: "authorization",
      headers: { authorization: "Bearer private" },
    },
    { name: "range", headers: { range: "bytes=0-10" } },
    { name: "upgrade", headers: { upgrade: "websocket" } },
  ])(
    "keeps a $name request outside pre-rendering",
    ({ headers }) => {
      expect(
        isPrerenderableDocsRequest(htmlRequest("/guide", { headers })),
      ).toBe(false);
    },
  );

  test("keeps local development outside the cache", () => {
    expect(
      isCacheableDocsRequest(
        new Request("http://demo.localhost:3002/", {
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe(false);
  });

  test("bounds the public production hostname response freshness", async () => {
    const response = withHostCachePolicy(resolution);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-if-error=604800",
    );
    expect(await response.json()).toEqual(resolution);
  });

  test.each([
    { name: "unknown", value: null },
    {
      name: "private",
      value: { ...resolution, accessPolicy: "authenticated" as const },
    },
    {
      name: "preview",
      value: { ...resolution, renderTarget: "preview" as const },
    },
    {
      name: "snapshot",
      value: { ...resolution, renderTarget: "generation_snapshot" as const },
    },
    { name: "legacy", value: { ...resolution, renderTarget: undefined } },
  ])("does not cache $name hostname results", ({ value }) => {
    expect(withHostCachePolicy(value).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  test("partitions HTML by the trusted site, version, host, build and render", () => {
    const identity = { rendererBuildId: "build-1", deliveryRenderId: null };
    const props = createHtmlCacheProps(htmlRequest(), resolution, identity);
    expect(props).toEqual({
      hostname: "docs.example.com",
      rendererBuildId: "build-1",
      resolution,
      lifetime: "versioned",
      deliveryRenderId: null,
    });
    for (const different of [
      createHtmlCacheProps(
        htmlRequest(),
        { ...resolution, siteId: "site-2" },
        identity,
      ),
      createHtmlCacheProps(
        htmlRequest(),
        { ...resolution, publishedVersionId: "promoted-version" },
        identity,
      ),
      createHtmlCacheProps(
        new Request("https://other.example.com/guide"),
        resolution,
        identity,
      ),
      createHtmlCacheProps(htmlRequest(), resolution, {
        ...identity,
        rendererBuildId: "build-2",
      }),
      // A client-asset-only release keeps the build but changes the render.
      createHtmlCacheProps(htmlRequest(), resolution, {
        ...identity,
        deliveryRenderId: "a".repeat(64),
      }),
    ]) {
      expect(different).not.toEqual(props);
    }
  });

  test("makes only successful HTML cacheable internally", async () => {
    const response = withHtmlCachePolicy(
      new Response("<h1>Guide</h1>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=2592000, stale-while-revalidate=604800, stale-if-error=604800",
    );
    expect(await response.text()).toBe("<h1>Guide</h1>");
  });

  test("uses a short internal TTL for successful live pre-render fallback", () => {
    const props = createHtmlCacheProps(htmlRequest(), resolution, {
      rendererBuildId: "build-1",
      deliveryRenderId: null,
      lifetime: "liveFallback",
    });
    const response = withHtmlCachePolicy(
      new Response("<h1>Guide</h1>", {
        headers: { "content-type": "text/html" },
      }),
      props.lifetime,
    );

    expect(props.lifetime).toBe("liveFallback");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=30, must-revalidate",
    );
  });

  test.each([
    {
      lifetime: "hostname" as const,
      expected: "public, max-age=86400, stale-if-error=604800",
    },
    {
      lifetime: "liveFallback" as const,
      expected: "public, max-age=30, must-revalidate",
    },
    {
      lifetime: "versioned" as const,
      expected:
        "public, max-age=2592000, stale-while-revalidate=604800, stale-if-error=604800",
    },
  ])("uses one exact header for the $lifetime lifetime", ({ lifetime, expected }) => {
    expect(cacheControlFor(lifetime)).toBe(expected);
  });

  test("keeps every directive that disables stale serving out of versioned output", () => {
    expect(cacheControlFor("versioned")).not.toMatch(
      /must-revalidate|s-maxage|proxy-revalidate/,
    );
  });

  test("accepts only rendered-output lifetimes for content caches", () => {
    expect(isContentCacheLifetime("versioned")).toBe(true);
    expect(isContentCacheLifetime("liveFallback")).toBe(true);
    expect(isContentCacheLifetime("hostname")).toBe(false);
    expect(isContentCacheLifetime(86_400)).toBe(false);
  });

  test("applies the requested lifetime to successful route data only", () => {
    const stored = withRouteDataCachePolicy(
      Response.json({ type: "page" }),
      "versioned",
    );
    const failed = withRouteDataCachePolicy(
      Response.json({ type: "page" }, { status: 503 }),
      "versioned",
    );

    expect(stored.headers.get("cdn-cache-control")).toBe(
      cacheControlFor("versioned"),
    );
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each<{ name: string; status: number; headers: Record<string, string> }>([
    { name: "error", status: 503, headers: { "content-type": "text/html" } },
    {
      name: "redirect",
      status: 307,
      headers: { location: "/guide", "content-type": "text/html" },
    },
    {
      name: "non-HTML",
      status: 200,
      headers: { "content-type": "application/json" },
    },
    {
      name: "session",
      status: 200,
      headers: { "content-type": "text/html", "set-cookie": "session=private" },
    },
    {
      name: "private",
      status: 200,
      headers: { "content-type": "text/html", "cache-control": "private" },
    },
    {
      name: "no-store",
      status: 200,
      headers: { "content-type": "text/html", "cache-control": "no-store" },
    },
    {
      name: "CDN privacy",
      status: 200,
      headers: { "content-type": "text/html", "cdn-cache-control": "private" },
    },
    {
      name: "Vary",
      status: 200,
      headers: { "content-type": "text/html", vary: "Cookie" },
    },
  ])("does not cache $name responses", ({ status, headers }) => {
    expect(
      withHtmlCachePolicy(
        new Response("body", { status, headers }),
      ).headers.get("cache-control"),
    ).toBe("private, no-store");
  });

  test("prevents gateway caching even when upstream sends CDN overrides", async () => {
    const response = withoutResponseCaching(
      new Response("docs", {
        headers: {
          "cache-control": "public, max-age=86400",
          "cdn-cache-control": "public, max-age=86400",
          "cloudflare-cdn-cache-control": "public, max-age=86400",
          "cache-tag": "internal",
        },
      }),
    );
    for (const header of [
      "cache-control",
      "cdn-cache-control",
      "cloudflare-cdn-cache-control",
    ]) {
      expect(response.headers.get(header)).toBe("private, no-store");
    }
    expect(response.headers.has("cache-tag")).toBe(false);
    expect(await response.text()).toBe("docs");
  });
});
