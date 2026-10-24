import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

vi.mock("../src/renderer-code-package", () => ({
  loadRendererCodePackage: vi.fn(async () => ({
    schemaVersion: 1,
    buildId: "build-1",
    compatibilityDate: "2026-06-12",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: { "index.js": "export default {}" },
  })),
}));

import worker, { DocsHostCache } from "../src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("docs dispatcher worker", () => {
  test("adds fresh dispatcher timings without exposing cached timing metadata", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const resolution = {
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
    const ctx = {
      exports: {
        DocsHostCache: () => ({
          fetch: async () =>
            Response.json(resolution, {
              headers: { "cf-cache-status": "HIT" },
            }),
        }),
        DocsHtmlCache: () => ({
          fetch: async () =>
            new Response("cached html", {
              headers: {
                "cf-cache-status": "HIT",
                "server-timing": "stale_renderer;dur=900",
                "x-doxa-internal-server-timing": "doxa_code;dur=800",
              },
            }),
        }),
      },
    };
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      {
        DEBUG: "true",
        DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
        DOXA_RENDERER_BUILD_ID: "build-1",
      } as never,
      ctx as never,
    );

    expect(response.headers.get("server-timing")).toMatch(
      /doxa_resolve;dur=.*doxa_html;dur=.*doxa_total;dur=/,
    );
    expect(response.headers.get("server-timing")).not.toContain("stale");
    expect(response.headers.get("server-timing")).not.toContain("doxa_code");
    expect(response.headers.has("x-doxa-internal-server-timing")).toBe(false);
  });

  test.each(["MISS", "BYPASS"])(
    "exposes fresh renderer timings when the HTML cache reports %s",
    async (cacheStatus) => {
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const resolution = {
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
      const ctx = {
        exports: {
          DocsHostCache: () => ({
            fetch: async () => Response.json(resolution),
          }),
          DocsHtmlCache: () => ({
            fetch: async () =>
              new Response("fresh html", {
                headers: {
                  "cf-cache-status": cacheStatus,
                  "x-doxa-internal-server-timing":
                    "doxa_code;dur=12, doxa_render;dur=18",
                },
              }),
          }),
        },
      };

      const response = await worker.fetch(
        new Request("https://docs.example.com/guide", {
          headers: { accept: "text/html" },
        }),
        {
          DEBUG: "true",
          DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
          DOXA_RENDERER_BUILD_ID: "build-1",
        } as never,
        ctx as never,
      );

      expect(response.headers.get("server-timing")).toContain(
        "doxa_code;dur=12",
      );
      expect(response.headers.get("server-timing")).toContain(
        "doxa_render;dur=18",
      );
      expect(response.headers.has("x-doxa-internal-server-timing")).toBe(false);
      expect(JSON.parse(String(info.mock.calls[0]?.[0])).timings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "doxa_code", durationMs: 12 }),
          expect.objectContaining({ name: "doxa_render", durationMs: 18 }),
        ]),
      );
    },
  );

  test("writes structured timing logs only when DEBUG is true", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sharedRenderer = {
      fetch: async () => new Response("shared"),
    };
    const request = () => new Request("https://docs.example.com/guide");

    const enabledResponse = await worker.fetch(
      request(),
      {
        DEBUG: "true",
        SHARED_RENDERER: sharedRenderer,
        DOXA_PROD_DYNAMIC_RENDERER_MODE: "off",
      } as never,
      {} as never,
    );
    const disabledResponse = await worker.fetch(
      request(),
      {
        DEBUG: "false",
        SHARED_RENDERER: sharedRenderer,
        DOXA_PROD_DYNAMIC_RENDERER_MODE: "off",
      } as never,
      {} as never,
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(enabledResponse.headers.get("server-timing")).toContain(
      "doxa_total;dur=",
    );
    expect(disabledResponse.headers.has("server-timing")).toBe(false);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event: "docs_request_timing",
      hostname: "docs.example.com",
      method: "GET",
      status: 200,
      rendererMode: "shared",
      cache: { host: "BYPASS", html: "BYPASS" },
      timings: expect.arrayContaining([
        expect.objectContaining({
          name: "doxa_render",
          description: "SHARED",
        }),
        expect.objectContaining({ name: "doxa_total" }),
      ]),
    });
  });

  test("host cache misses fetch resolution over the private HTTP binding", async () => {
    const resolverFetch = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({
        kind: "host",
        value: "docs.example.com",
      });
      return Response.json({ resolution: null });
    });
    const cache = new DocsHostCache(
      { props: { hostname: "docs.example.com" } } as never,
      { DOCS_RESOLVER: { fetch: resolverFetch } } as never,
    );
    const response = await cache.fetch();
    expect(await response.json()).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("uses trusted cache props while keeping the public gateway uncacheable", async () => {
    const resolution = {
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
    const hostFetch = vi.fn(async () => Response.json(resolution));
    const htmlFetch = vi.fn(
      async (_request: Request) =>
        new Response("cached html", {
          headers: {
            "cache-control": "public, max-age=86400",
            "cf-cache-status": "HIT",
          },
        }),
    );
    const ctx = {
      exports: {
        DocsHostCache: vi.fn(() => ({ fetch: hostFetch })),
        DocsHtmlCache: vi.fn(() => ({ fetch: htmlFetch })),
      },
    };
    const env = {
      DOCS_RESOLVER: { fetch: vi.fn() },
      SHARED_RENDERER: { fetch: vi.fn() },
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_RENDERER_BUILD_ID: "build-1",
    };
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: {
          accept: "text/html",
          "x-forwarded-host": "untrusted.example",
        },
      }),
      env as never,
      ctx as never,
    );

    expect(await response.text()).toBe("cached html");
    expect(env.DOCS_RESOLVER.fetch).not.toHaveBeenCalled();
    expect(ctx.exports.DocsHostCache).toHaveBeenCalledWith({
      props: { hostname: "docs.example.com" },
    });
    expect(ctx.exports.DocsHtmlCache).toHaveBeenCalledWith({
      props: {
        hostname: "docs.example.com",
        rendererBuildId: "build-1",
        resolution,
        lifetime: "versioned",
        deliveryRenderId: null,
      },
    });
    const forwarded = htmlFetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("x-forwarded-host")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "private, no-store",
    );
    expect(response.headers.get("x-doxa-html-cache")).toBe("HIT");
  });

  test("does not cache the shared fallback after a cached renderer fails", async () => {
    const resolution = {
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
    const ctx = {
      exports: {
        DocsHostCache: () => ({ fetch: async () => Response.json(resolution) }),
        DocsHtmlCache: () => ({
          fetch: async () => new Response("failed", { status: 500 }),
        }),
      },
    };
    const env = {
      SHARED_RENDERER: {
        fetch: vi.fn(
          async () =>
            new Response("fallback", {
              headers: { "cache-control": "public, max-age=60" },
            }),
        ),
      },
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_RENDERER_BUILD_ID: "build-1",
    };
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      env as never,
      ctx as never,
    );
    expect(await response.text()).toBe("fallback");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe(
      "shared-fallback",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("loads production code with a narrow content binding and no outbound access", async () => {
    let loadCode: (() => Promise<WorkerLoaderWorkerCode>) | undefined;
    const scopedContent = { request: vi.fn() };
    const loaderGet = vi.fn(
      (
        workerId: string | null,
        getCode: () => Promise<WorkerLoaderWorkerCode>,
      ) => {
        loadCode = getCode;
        return {
          getEntrypoint: () => ({
            fetch: vi.fn(async () => new Response("dynamic")),
          }),
        } as unknown as WorkerStub;
      },
    );
    const env = {
      DOCS_RESOLVER: {
        fetch: vi.fn(async () =>
          Response.json({
            resolution: {
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
            },
          }),
        ),
      },
      DOCS_RUNTIME: { request: vi.fn() },
      SHARED_RENDERER: { fetch: vi.fn() },
      LOADER: { get: loaderGet },
      RENDERER_CODE_BUCKET: {},
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
      DOXA_API_BASE_URL: "https://api.doxa.so",
      DOXA_DASHBOARD_BASE_URL: "https://doxa.so",
      DOXA_DOCS_BASE_DOMAIN: "doxa.page",
    };
    const ctx = {
      exports: {
        DocsHostCache: ({ props }: { props: { hostname: string } }) =>
          new DocsHostCache({ props } as never, env as never),
        ScopedDocsContent: vi.fn(() => scopedContent),
      },
    };

    const response = await worker.fetch(
      new Request("https://docs.example.com/guide"),
      env as never,
      ctx as never,
    );

    expect(await response.text()).toBe("dynamic");
    expect(loaderGet).toHaveBeenCalledWith(
      "docs:site-1:version-1:build-1",
      expect.any(Function),
    );
    expect(loadCode).toBeDefined();
    const code = await loadCode?.();
    expect(code?.globalOutbound).toBeNull();
    expect(code?.env).toMatchObject({
      DOXA_DOCS_RUNTIME_SOURCE: "binding",
      DOXA_DOCS_CONTENT_BINDING: scopedContent,
      DOXA_DOCS_CONTENT_RESOLUTION: {
        siteId: "site-1",
        publishedVersionId: "version-1",
      },
    });
    expect(code?.env).not.toHaveProperty("RENDERER_CODE_BUCKET");
    expect(code?.env).not.toHaveProperty("API");
    expect(code?.env).not.toHaveProperty("DOCS_RESOLVER");
    expect(code?.env).not.toHaveProperty("DOCS_RUNTIME");
  });
});
