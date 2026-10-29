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

import worker, { DocsHostCache, DocsRouteDataCache } from "../src/index";
import { createExpectedPrerenderIdentity } from "../src/prerender-policy";
import type { RouteDataCacheProps } from "../src/route-data-cache-entrypoint";
import { createRouteData } from "./fixtures/route-data";

const releaseId = "a".repeat(64);

const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

describe("route-data endpoint with the lazy route-data cache", () => {
  test("serves live route data through the route-data cache entrypoint", async () => {
    const fixture = await createFixture();
    const response = await fetchRouteData(fixture, {
      render: fixture.renderId,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      schemaVersion: 1,
      renderId: fixture.renderId,
      data: createRouteData(),
    });
    expect(response.headers.get("x-doxa-route-data-cache")).toBe("MISS");
    expect(response.headers.get("x-doxa-representation-source")).toBe(
      "dynamic",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fixture.routeDataCacheProps).toEqual([
      {
        expected: expect.objectContaining({ renderId: fixture.renderId }),
        hostname: "docs.example.com",
        pathname: "/guide",
        resolution,
      },
    ]);
    expect(fixture.routeDataCacheUrls).toEqual([
      "https://docs.example.com/_doxa/route-data/v1/guide",
    ]);
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  test("stores the live result with the versioned lifetime", async () => {
    const fixture = await createFixture();
    await fetchRouteData(fixture);

    expect(
      fixture.routeDataCacheResponses[0]?.headers.get("cache-control"),
    ).toBe(
      "public, max-age=2592000, stale-while-revalidate=604800, stale-if-error=604800",
    );
  });

  test("prepares a visitor-specific request live without the shared cache", async () => {
    const fixture = await createFixture();
    const response = await fetchRouteData(
      fixture,
      {},
      {
        cookie: "session=private",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-doxa-route-data-cache")).toBe("BYPASS");
    expect(fixture.ctx.exports.DocsRouteDataCache).not.toHaveBeenCalled();
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  test("rejects a stale render hint before reading any route data", async () => {
    const fixture = await createFixture();
    const response = await fetchRouteData(fixture, { render: "f".repeat(64) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "version_mismatch" });
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  test("returns an uncached 503 when live preparation fails", async () => {
    const fixture = await createFixture();
    fixture.prepare.mockRejectedValue(new Error("MDX parse failure"));
    const response = await fetchRouteData(fixture);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      retryable: true,
    });
    expect(
      fixture.routeDataCacheResponses[0]?.headers.get("cache-control"),
    ).toBe("private, no-store");
  });

  test("answers HEAD with headers only", async () => {
    const fixture = await createFixture();
    const response = await fetchRouteData(fixture, {}, {}, "HEAD");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("keeps the client fallback signal when no rollout is enabled", async () => {
    const fixture = await createFixture({
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: "off",
    });
    const response = await fetchRouteData(fixture);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: "unavailable",
      retryable: true,
    });
    expect(fixture.env.DOCS_RESOLVER.fetch).not.toHaveBeenCalled();
  });

  test("keeps the client fallback signal for a site outside the rollout", async () => {
    const fixture = await createFixture({
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: "allowlist",
      DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS: "site-2",
    });
    const response = await fetchRouteData(fixture);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: "unavailable",
      retryable: false,
    });
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
});

describe("HTML delivery capability", () => {
  test("pins HTML to the delivery render ID when the route-data cache is on", async () => {
    const fixture = await createFixture();
    const htmlFetch = vi.fn(
      async (_request: Request) =>
        new Response("<h1>Guide</h1>", {
          headers: { "content-type": "text/html", "cf-cache-status": "HIT" },
        }),
    );
    const htmlCache = vi.fn(() => ({ fetch: htmlFetch }));
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      { ...fixture.env, DOXA_PROD_DYNAMIC_RENDERER_MODE: "all" } as never,
      {
        exports: { ...fixture.ctx.exports, DocsHtmlCache: htmlCache },
      } as never,
    );

    expect(await response.text()).toBe("<h1>Guide</h1>");
    expect(htmlCache).toHaveBeenCalledWith({
      props: expect.objectContaining({ deliveryRenderId: fixture.renderId }),
    });
    expect(
      htmlFetch.mock.calls[0]?.[0].headers.get("x-doxa-internal-render-id"),
    ).toBe(fixture.renderId);
  });

  test("sends no render ID while every delivery rollout is off", async () => {
    const fixture = await createFixture({
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: "off",
    });
    const htmlFetch = vi.fn(
      async (_request: Request) =>
        new Response("<h1>Guide</h1>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const htmlCache = vi.fn(() => ({ fetch: htmlFetch }));
    await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      { ...fixture.env, DOXA_PROD_DYNAMIC_RENDERER_MODE: "all" } as never,
      {
        exports: { ...fixture.ctx.exports, DocsHtmlCache: htmlCache },
      } as never,
    );

    expect(htmlCache).toHaveBeenCalledWith({
      props: expect.objectContaining({ deliveryRenderId: null }),
    });
    expect(
      htmlFetch.mock.calls[0]?.[0].headers.has("x-doxa-internal-render-id"),
    ).toBe(false);
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(envOverrides: Record<string, string> = {}) {
  const identity = await createExpectedPrerenderIdentity({
    siteId: resolution.siteId,
    artifactPrefix: resolution.artifactPrefix,
    manifestPath: resolution.manifestPath,
    rendererReleaseId: releaseId,
    trustedRequestOrigin: "https://docs.example.com",
  });
  const prepare = vi.fn(async () => createRouteData());
  const routeDataCacheProps: RouteDataCacheProps[] = [];
  const routeDataCacheUrls: string[] = [];
  const routeDataCacheResponses: Response[] = [];
  const env = {
    DOCS_RESOLVER: {
      fetch: vi.fn(async () => Response.json({ resolution })),
    },
    SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOXA_RENDERER_RELEASE_ID: releaseId,
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "off",
    DOXA_PROD_ROUTE_DATA_CACHE_MODE: "all",
    ...envOverrides,
  };
  const ctx = {
    exports: {
      DocsHostCache: ({ props }: { props: { hostname: string } }) =>
        new DocsHostCache({ props } as never, env as never),
      DocsRouteDataCache: vi.fn(
        ({ props }: { props: RouteDataCacheProps }) => ({
          fetch: async (request: Request) => {
            routeDataCacheProps.push(props);
            routeDataCacheUrls.push(request.url);
            const stored = await new DocsRouteDataCache(
              { props, exports: ctx.exports } as never,
              env as never,
            ).fetch(request);
            routeDataCacheResponses.push(stored.clone());
            const headers = new Headers(stored.headers);
            headers.set("cf-cache-status", "MISS");
            return new Response(stored.body, {
              status: stored.status,
              headers,
            });
          },
        }),
      ),
      PrerenderRendererApi: () => ({ prepare }),
    },
  };
  return {
    ctx,
    env,
    prepare,
    renderId: identity.renderId,
    routeDataCacheProps,
    routeDataCacheResponses,
    routeDataCacheUrls,
  };
}

function fetchRouteData(
  fixture: Fixture,
  query: { render?: string } = {},
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  const search = new URLSearchParams({ path: "/guide", ...query });
  return worker.fetch(
    new Request(`https://docs.example.com/_doxa/route-data/v1?${search}`, {
      method,
      headers: { accept: "application/json", ...headers },
    }),
    fixture.env as never,
    fixture.ctx as never,
  );
}
