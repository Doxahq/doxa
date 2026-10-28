import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker, {
  DocsHostCache,
  DocsHtmlCache,
  DocsRouteDataCache,
} from "../src/index";
import {
  DOCS_HOST_CACHE_FORMAT,
  createDocsCacheTags,
} from "../src/cache-policy";
import { createExpectedPrerenderIdentity } from "../src/prerender-policy";
import type { RouteDataCacheProps } from "../src/route-data-cache-entrypoint";
import { createRouteData } from "./fixtures/route-data";

const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "artifacts/v1",
  manifestPath: "artifacts/v1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

function createEnv(value: DocsDomainResolution | null = resolution) {
  const render = vi.fn(
    async (_request: Request) =>
      new Response("<h1>Guide</h1>", {
        headers: { "content-type": "text/html" },
      }),
  );
  return {
    DOCS_RESOLVER: {
      fetch: vi.fn(async (_request: Request) =>
        Response.json({ resolution: value }),
      ),
    },
    SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
    LOADER: {
      get: vi.fn(() => ({ getEntrypoint: () => ({ fetch: render }) })),
    },
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    render,
  };
}

function htmlRequest(init: RequestInit = {}) {
  return new Request("https://docs.example.com/guide", {
    ...init,
    headers: { accept: "text/html", ...init.headers },
  });
}

describe("cache entrypoints", () => {
  test("normalizes hostname tags and cannot inject another site's tag", () => {
    expect(
      createDocsCacheTags({
        siteId: "site-1,docs-site:site-2",
        hostname: "DOCS.Example.COM.",
      }),
    ).toEqual([
      "docs-site:site-1%2Cdocs-site%3Asite-2",
      "docs-host:docs.example.com",
    ]);
  });

  test("purges the owning hostname entrypoint by site and hostname tags", async () => {
    const purge = vi.fn(async () => ({ success: true, errors: [] }));
    const entrypoint = new DocsHostCache(
      { cache: { purge } } as never,
      createEnv() as never,
    );
    await entrypoint.invalidate({
      siteId: "site-1",
      hostname: "docs.example.com",
    });
    expect(purge).toHaveBeenCalledWith({
      tags: ["docs-site:site-1", "docs-host:docs.example.com"],
    });
  });

  test("rejects a purge that Cloudflare did not accept", async () => {
    const purge = vi.fn(async () => ({
      success: false,
      errors: [{ code: 429, message: "limited" }],
    }));
    const entrypoint = new DocsHostCache(
      { cache: { purge } } as never,
      createEnv() as never,
    );
    await expect(entrypoint.invalidate({ siteId: "site-1" })).rejects.toThrow(
      "purge failed",
    );
  });

  test("does not acknowledge purges without a Workers Cache context", async () => {
    const entrypoint = new DocsHostCache({} as never, createEnv() as never);
    await expect(entrypoint.invalidate({ siteId: "site-1" })).rejects.toThrow(
      "unavailable",
    );
  });

  test("looks up the hostname from trusted props", async () => {
    const env = createEnv();
    const entrypoint = new DocsHostCache(
      { props: { hostname: "docs.example.com" } } as never,
      env as never,
    );
    const response = await entrypoint.fetch();
    expect(await env.DOCS_RESOLVER.fetch.mock.calls[0]?.[0].json()).toEqual({
      kind: "host",
      value: "docs.example.com",
    });
    expect(await response.json()).toEqual(resolution);
    expect(response.headers.get("cache-tag")).toBe(
      "docs-site:site-1,docs-host:docs.example.com",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-if-error=604800",
    );
  });

  test("does not convert an API error into a cached hostname miss", async () => {
    const env = createEnv();
    env.DOCS_RESOLVER.fetch.mockRejectedValue(new Error("API unavailable"));
    const entrypoint = new DocsHostCache(
      { props: { hostname: "docs.example.com" } } as never,
      env as never,
    );
    await expect(entrypoint.fetch()).rejects.toThrow("API unavailable");
  });

  test("pins an HTML cache fill to the resolved production version", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv();
    const ctx = {
      props: {
        hostname: resolution.hostname,
        rendererBuildId: "build-1",
        resolution,
        lifetime: "versioned" as const,
        deliveryRenderId: null,
      },
      exports: { ScopedDocsContent: vi.fn(() => ({ request: vi.fn() })) },
    };
    const entrypoint = new DocsHtmlCache(ctx as never, env as never);
    const response = await entrypoint.fetch(htmlRequest());
    expect(await response.text()).toBe("<h1>Guide</h1>");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, stale-while-revalidate=604800, stale-if-error=604800",
    );
    expect(env.LOADER.get).toHaveBeenCalledWith(
      "docs:site-1:version-1:build-1",
      expect.any(Function),
    );
    expect(env.DOCS_RESOLVER.fetch).not.toHaveBeenCalled();
    // Logged without DEBUG. The mock loader keeps an isolate, so no code loads.
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toEqual({
      event: "docs_renderer_load",
      entrypoint: "fetch",
      siteId: "site-1",
      publishedVersionId: "version-1",
      isolateScope: "site",
      rendererBuildId: "build-1",
      state: "WARM",
      totalMs: expect.any(Number),
      ok: true,
      status: 200,
      bodyMs: expect.any(Number),
      bytes: "<h1>Guide</h1>".length,
    });
    info.mockRestore();
  });

  test("logs the renderer's timing split and keeps its header out of the cache", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv();
    const now = Date.now();
    env.render.mockResolvedValueOnce(
      new Response("<h1>Guide</h1>", {
        headers: {
          "content-type": "text/html",
          "x-doxa-renderer-timing": JSON.stringify({
            isolateId: "a1b2c3d4",
            isolateRequests: 3,
            isolateAgeMs: 4_000,
            requestStartedAt: now,
            routeDataMs: 120,
            siteConfigMs: 0,
            contentCalls: 1,
            contentMs: 120,
            longestContentMs: 120,
            respondedAt: now + 130,
          }),
        },
      }),
    );
    const entrypoint = new DocsHtmlCache(
      {
        props: {
          hostname: resolution.hostname,
          rendererBuildId: "build-1",
          resolution,
          lifetime: "versioned" as const,
          deliveryRenderId: null,
        },
        exports: { ScopedDocsContent: () => ({ request: vi.fn() }) },
      } as never,
      env as never,
    );

    const response = await entrypoint.fetch(htmlRequest());

    expect(response.headers.has("x-doxa-renderer-timing")).toBe(false);
    expect(await response.text()).toBe("<h1>Guide</h1>");
    const logged = JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(logged).toMatchObject({
      event: "docs_renderer_load",
      renderer: {
        isolateId: "a1b2c3d4",
        isolateRequests: 3,
        isolateAgeMs: 4_000,
      },
      phases: {
        handlerMs: 130,
        routeDataMs: 120,
        siteConfigMs: 0,
        contentCalls: 1,
        contentMs: 120,
        longestContentMs: 120,
      },
    });
    expect(typeof logged.phases.beforeHandlerMs).toBe("number");
    expect(typeof logged.phases.afterHandlerMs).toBe("number");
    info.mockRestore();
  });

  test("stores renderer timings as private cache metadata when DEBUG is true", async () => {
    const env = { ...createEnv(), DEBUG: "true" };
    env.render.mockResolvedValueOnce(
      new Response("<h1>Guide</h1>", {
        headers: {
          "content-type": "text/html",
          "server-timing": "renderer_runtime;dur=7",
        },
      }),
    );
    const entrypoint = new DocsHtmlCache(
      {
        props: {
          hostname: resolution.hostname,
          rendererBuildId: "build-1",
          resolution,
          lifetime: "versioned" as const,
          deliveryRenderId: null,
        },
        exports: { ScopedDocsContent: () => ({ request: vi.fn() }) },
      } as never,
      env as never,
    );

    const response = await entrypoint.fetch(htmlRequest());

    expect(response.headers.has("server-timing")).toBe(false);
    expect(response.headers.get("x-doxa-internal-server-timing")).toContain(
      "renderer_runtime;dur=7",
    );
    expect(response.headers.get("x-doxa-internal-server-timing")).toContain(
      "doxa_render;dur=",
    );
    expect(response.headers.get("x-doxa-internal-server-timing")).toContain(
      "doxa_loader;dur=",
    );
  });

  test("does not store measurement metadata when DEBUG is false", async () => {
    const env = { ...createEnv(), DEBUG: "false" };
    env.render.mockResolvedValueOnce(
      new Response("<h1>Guide</h1>", {
        headers: {
          "content-type": "text/html",
          "server-timing": "renderer_runtime;dur=7",
        },
      }),
    );
    const entrypoint = new DocsHtmlCache(
      {
        props: {
          hostname: resolution.hostname,
          rendererBuildId: "build-1",
          resolution,
          lifetime: "versioned" as const,
          deliveryRenderId: null,
        },
        exports: { ScopedDocsContent: () => ({ request: vi.fn() }) },
      } as never,
      env as never,
    );

    const response = await entrypoint.fetch(htmlRequest());

    expect(response.headers.has("server-timing")).toBe(false);
    expect(response.headers.has("x-doxa-internal-server-timing")).toBe(false);
  });

  test.each([
    {
      name: "hostname mismatch",
      props: {
        hostname: "other.example.com",
        rendererBuildId: "build-1",
        resolution,
        lifetime: "versioned" as const,
        deliveryRenderId: null,
      },
    },
    {
      name: "stale build",
      props: {
        hostname: resolution.hostname,
        rendererBuildId: "old-build",
        resolution,
        lifetime: "versioned" as const,
        deliveryRenderId: null,
      },
    },
    {
      name: "private version",
      props: {
        hostname: resolution.hostname,
        rendererBuildId: "build-1",
        resolution: { ...resolution, accessPolicy: "authenticated" as const },
        lifetime: "versioned" as const,
        deliveryRenderId: null,
      },
    },
  ])("rejects $name before rendering", async ({ props }) => {
    const env = createEnv();
    const entrypoint = new DocsHtmlCache({ props } as never, env as never);
    const response = await entrypoint.fetch(htmlRequest());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(env.LOADER.get).not.toHaveBeenCalled();
  });

  test.each<RequestInit>([
    { headers: { cookie: "session=private" } },
    { headers: { authorization: "Bearer private" } },
    { headers: { "cache-control": "no-cache" } },
    { method: "POST" },
  ])(
    "bypasses the HTML cache but shares the hostname cache for visitor-specific requests: %j",
    async (init) => {
      const env = createEnv();
      const ctx = {
        exports: {
          DocsHostCache: vi.fn(
            ({ props }: { props: { hostname: string } }) =>
              new DocsHostCache({ props } as never, env as never),
          ),
          DocsHtmlCache: vi.fn(),
          ScopedDocsContent: vi.fn(() => ({ request: vi.fn() })),
        },
      };
      const response = await worker.fetch(
        htmlRequest(init),
        env as never,
        ctx as never,
      );
      expect(env.DOCS_RESOLVER.fetch).toHaveBeenCalledOnce();
      expect(ctx.exports.DocsHostCache).toHaveBeenCalledWith({
        props: { hostname: "docs.example.com", format: DOCS_HOST_CACHE_FORMAT },
      });
      expect(ctx.exports.DocsHtmlCache).not.toHaveBeenCalled();
      expect(env.render).toHaveBeenCalledOnce();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test.each([
    null,
    {
      ...resolution,
      renderTarget: "preview" as const,
      accessPolicy: "authenticated" as const,
    },
    { ...resolution, renderTarget: "generation_snapshot" as const },
  ])(
    "keeps unknown hosts or previews on the uncached shared renderer: %j",
    async (value) => {
      const env = createEnv(value);
      const hostEntrypoint = new DocsHostCache(
        { props: { hostname: resolution.hostname } } as never,
        env as never,
      );
      const ctx = {
        exports: {
          DocsHostCache: () => hostEntrypoint,
          DocsHtmlCache: vi.fn(),
        },
      };
      const response = await worker.fetch(
        htmlRequest(),
        env as never,
        ctx as never,
      );
      expect(await response.text()).toBe("shared");
      expect(ctx.exports.DocsHtmlCache).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect((await hostEntrypoint.fetch()).headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect((await hostEntrypoint.fetch()).headers.has("cache-tag")).toBe(
        false,
      );
    },
  );

  test("keeps mode off outside the hostname cache", async () => {
    const env = { ...createEnv(), DOXA_PROD_DYNAMIC_RENDERER_MODE: "off" };
    const response = await worker.fetch(
      htmlRequest(),
      env as never,
      {} as never,
    );
    expect(await response.text()).toBe("shared");
    expect(env.DOCS_RESOLVER.fetch).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("rejects an HTML fill whose render ID differs from the key", async () => {
    const env = createEnv();
    const entrypoint = new DocsHtmlCache(
      {
        props: {
          hostname: resolution.hostname,
          rendererBuildId: "build-1",
          resolution,
          lifetime: "versioned" as const,
          deliveryRenderId: "a".repeat(64),
        },
      } as never,
      env as never,
    );
    const response = await entrypoint.fetch(
      htmlRequest({ headers: { "x-doxa-internal-render-id": "b".repeat(64) } }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(env.LOADER.get).not.toHaveBeenCalled();
  });

  test("resolves a server-function request through the hostname cache", async () => {
    const env = createEnv();
    const hostCache = vi.fn(
      ({ props }: { props: { hostname: string } }) =>
        new DocsHostCache({ props } as never, env as never),
    );
    const ctx = {
      exports: {
        DocsHostCache: hostCache,
        DocsHtmlCache: vi.fn(),
        ScopedDocsContent: vi.fn(() => ({ request: vi.fn() })),
      },
    };
    const response = await worker.fetch(
      new Request("https://docs.example.com/_serverFn/abc?payload=%7B%7D"),
      env as never,
      ctx as never,
    );
    expect(hostCache).toHaveBeenCalledWith({
      props: { hostname: "docs.example.com", format: DOCS_HOST_CACHE_FORMAT },
    });
    expect(ctx.exports.DocsHtmlCache).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("route-data cache entrypoint", () => {
  const routeDataUrl = "https://docs.example.com/_doxa/route-data/v1/guide";

  async function createRouteDataProps(): Promise<RouteDataCacheProps> {
    return {
      expected: await createExpectedPrerenderIdentity({
        siteId: resolution.siteId,
        artifactPrefix: resolution.artifactPrefix,
        manifestPath: resolution.manifestPath,
        rendererReleaseId: "a".repeat(64),
        trustedRequestOrigin: "https://docs.example.com",
      }),
      hostname: resolution.hostname,
      pathname: "/guide",
      resolution,
    };
  }

  function createRouteDataCache(
    props: RouteDataCacheProps,
    envOverrides: Record<string, string> = {},
  ) {
    const prepare = vi.fn(async () => createRouteData());
    const entrypoint = new DocsRouteDataCache(
      {
        props,
        exports: { PrerenderRendererApi: () => ({ prepare }) },
      } as never,
      {
        DOXA_PROD_ROUTE_DATA_CACHE_MODE: "all",
        ...envOverrides,
      } as never,
    );
    return { entrypoint, prepare };
  }

  test("stores live route data with the versioned lifetime", async () => {
    const { entrypoint, prepare } = createRouteDataCache(
      await createRouteDataProps(),
    );
    const response = await entrypoint.fetch(new Request(routeDataUrl));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(createRouteData());
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, stale-while-revalidate=604800, stale-if-error=604800",
    );
    expect(prepare).toHaveBeenCalledWith({
      resolution: expect.objectContaining({ siteId: "site-1" }),
      pathname: "/guide",
    });
  });

  test("never stores a failed preparation", async () => {
    const { entrypoint, prepare } = createRouteDataCache(
      await createRouteDataProps(),
    );
    prepare.mockRejectedValue(new Error("MDX parse failure"));
    const response = await entrypoint.fetch(new Request(routeDataUrl));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each<{
    name: string;
    change: (props: RouteDataCacheProps) => RouteDataCacheProps;
    url?: string;
    method?: string;
    env?: Record<string, string>;
  }>([
    {
      name: "rollout off",
      change: (props) => props,
      env: { DOXA_PROD_ROUTE_DATA_CACHE_MODE: "off" },
    },
    {
      name: "saved delivery has priority",
      change: (props) => props,
      env: { DOXA_PROD_PRERENDER_MODE: "all" },
    },
    {
      name: "private site",
      change: (props) => ({
        ...props,
        resolution: { ...props.resolution, accessPolicy: "authenticated" },
      }),
    },
    {
      name: "hostname mismatch",
      change: (props) => ({ ...props, hostname: "other.example.com" }),
    },
    {
      name: "identity for another site",
      change: (props) => ({
        ...props,
        expected: { ...props.expected, siteId: "site-2" },
      }),
    },
    {
      name: "identity for another version",
      change: (props) => ({
        ...props,
        expected: {
          ...props.expected,
          artifactPrefix: "sites/site-1/versions/old",
        },
      }),
    },
    {
      name: "identity for another origin",
      change: (props) => ({
        ...props,
        expected: {
          ...props.expected,
          trustedRequestOrigin: "https://other.example.com",
        },
      }),
    },
    {
      name: "HTML path",
      change: (props) => props,
      url: "https://docs.example.com/guide",
    },
    {
      name: "query string",
      change: (props) => props,
      url: `${routeDataUrl}?path=/other`,
    },
    { name: "HEAD request", change: (props) => props, method: "HEAD" },
  ])("rejects a $name request before rendering", async (scenario) => {
    const props = scenario.change(await createRouteDataProps());
    const { entrypoint, prepare } = createRouteDataCache(props, scenario.env);
    const response = await entrypoint.fetch(
      new Request(scenario.url ?? routeDataUrl, {
        method: scenario.method ?? "GET",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(prepare).not.toHaveBeenCalled();
  });
});
