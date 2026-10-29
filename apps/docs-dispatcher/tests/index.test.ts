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

vi.mock("../src/renderer-code-package", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer-code-package")>()),
  loadRendererCodePackage: vi.fn(async () => ({
    code: {
      schemaVersion: 1,
      buildId: "build-1",
      compatibilityDate: "2026-06-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
      modules: { "index.js": "export default {}" },
    },
    source: "cache",
  })),
}));

import { DOCS_HOST_CACHE_FORMAT } from "../src/cache-policy";
import worker, {
  DocsHostCache,
  PrerenderRendererApi,
  ScopedDocsContent,
} from "../src/index";
import { createRouteData } from "./fixtures/route-data";

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

  test("writes timing logs with DEBUG and one cache-status line without it", async () => {
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

    expect(info).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(info.mock.calls[1]?.[0]))).toEqual({
      event: "docs_request_cache",
      hostname: "docs.example.com",
      path: "/guide",
      status: 200,
      cache: { host: "BYPASS", html: "BYPASS" },
    });
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
      props: { hostname: "docs.example.com", format: DOCS_HOST_CACHE_FORMAT },
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

describe("route-data prefetch on a cold renderer start", () => {
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
  const routeData = { ok: true as const, data: { type: "page" } };

  /**
   * A renderer that asks its content binding for route data, like
   * docs-template, and a loader that is cold or warm.
   */
  function render(options: { mode: string; cold: boolean }) {
    const runtimeRequest = vi.fn(async () => routeData);
    const waitUntil = vi.fn();
    const env = {
      DOCS_RESOLVER: { fetch: vi.fn(async () => Response.json({ resolution })) },
      DOCS_RUNTIME: { request: runtimeRequest },
      SHARED_RENDERER: { fetch: vi.fn() },
      LOADER: { get: vi.fn() },
      RENDERER_CODE_BUCKET: {},
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_PROD_ROUTE_DATA_PREFETCH_MODE: options.mode,
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    };
    const contentProps: unknown[] = [];
    const ctx = {
      waitUntil,
      exports: {
        DocsHostCache: ({ props }: { props: { hostname: string } }) =>
          new DocsHostCache({ props } as never, env as never),
        ScopedDocsContent: ({ props }: { props: unknown }) => {
          contentProps.push(props);
          return new ScopedDocsContent({ props } as never, env as never);
        },
        DocsRendererCodeCache: vi.fn(),
      },
    };
    env.LOADER.get.mockImplementation(
      (_id: string, getCode: () => Promise<WorkerLoaderWorkerCode>) => {
        const started = options.cold ? getCode() : undefined;
        return {
          getEntrypoint: () => ({
            fetch: async () => {
              const code = await started;
              const content = code?.env?.DOXA_DOCS_CONTENT_BINDING;
              const binding =
                content instanceof ScopedDocsContent
                  ? content
                  : new ScopedDocsContent(
                      { props: contentProps[0] } as never,
                      env as never,
                    );
              const answer = await binding.request({
                operation: "getRouteData",
                payload: { pathname: "/guide" },
              });
              return new Response(JSON.stringify(answer));
            },
          }),
        };
      },
    );
    const response = worker.fetch(
      new Request("https://docs.example.com/guide/", {
        // no-cache skips the HTML cache entrypoint and renders directly.
        headers: { accept: "text/html", "cache-control": "no-cache" },
      }),
      env as never,
      ctx as never,
    );
    return { response, runtimeRequest, waitUntil, contentProps };
  }

  function rendererLoadLine(info: ReturnType<typeof vi.spyOn>) {
    const line = info.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .find((value) => value.event === "docs_renderer_load");
    expect(line).toBeDefined();
    return line;
  }

  test("a cold start sends one getRouteData and hands it to the renderer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { response, runtimeRequest, waitUntil, contentProps } = render({
      mode: "all",
      cold: true,
    });

    const result = await response;
    expect(await result.json()).toEqual(routeData);
    expect(runtimeRequest).toHaveBeenCalledOnce();
    expect(runtimeRequest).toHaveBeenCalledWith({
      resolution: expect.objectContaining({
        siteId: "site-1",
        artifactPrefix: "sites/site-1/versions/version-1",
      }),
      operation: "getRouteData",
      payload: { pathname: "/guide" },
      trace: { id: expect.stringMatching(UUID), caller: "prefetch" },
    });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(contentProps[0]).toHaveProperty("routeDataPrefetchId");
    expect(rendererLoadLine(info).routeDataPrefetch).toMatchObject({
      outcome: "handedOff",
    });
  });

  test("a warm renderer prefetches nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { response, runtimeRequest, waitUntil } = render({
      mode: "all",
      cold: false,
    });

    await (await response).text();
    expect(runtimeRequest).toHaveBeenCalledOnce();
    expect(waitUntil).not.toHaveBeenCalled();
    // Only a started prefetch reports; WARM tells why none started.
    expect(rendererLoadLine(info)).not.toHaveProperty("routeDataPrefetch");
    expect(rendererLoadLine(info).state).toBe("WARM");
  });

  test("mode off keeps the content props and the call path unchanged", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { response, runtimeRequest, waitUntil, contentProps } = render({
      mode: "off",
      cold: true,
    });

    await (await response).text();
    expect(runtimeRequest).toHaveBeenCalledOnce();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(contentProps[0]).toEqual({
      resolution: expect.objectContaining({ siteId: "site-1" }),
    });
    expect(rendererLoadLine(info)).not.toHaveProperty("routeDataPrefetch");
  });
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const publicResolution = {
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

const INJECTED_HEADERS = {
  "x-doxa-cache-probe": "1",
  "x-doxa-internal-render-id": "f".repeat(64),
  "x-doxa-host": "victim.example.com",
  "x-doxa-project-id": "project-2",
};

describe("inbound x-doxa-* headers", () => {
  function createEnv(mode: string) {
    const env = {
      DOCS_RESOLVER: {
        fetch: vi.fn(async () => Response.json({ resolution: publicResolution })),
      },
      DOCS_RUNTIME: { request: vi.fn() },
      SHARED_RENDERER: {
        fetch: vi.fn(async (_request: Request) => new Response("shared")),
      },
      LOADER: { get: vi.fn() },
      RENDERER_CODE_BUCKET: {},
      DOXA_PROD_DYNAMIC_RENDERER_MODE: mode,
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    };
    return env;
  }

  function internalHeaders(request: Request | undefined): string[] {
    return [...(request?.headers.keys() ?? [])].filter((name) =>
      name.startsWith("x-doxa-"),
    );
  }

  test("never reach the shared renderer", async () => {
    const env = createEnv("off");
    await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html", ...INJECTED_HEADERS },
      }),
      env as never,
      { exports: {} } as never,
    );

    expect(internalHeaders(env.SHARED_RENDERER.fetch.mock.calls[0]?.[0])).toEqual(
      [],
    );
  });

  test("never reach the HTML cache entrypoint", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv("all");
    const htmlFetch = vi.fn(async (_request: Request) => new Response("html"));
    const htmlCache = vi.fn(() => ({ fetch: htmlFetch }));
    await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html", ...INJECTED_HEADERS },
      }),
      env as never,
      {
        exports: {
          DocsHostCache: ({ props }: { props: { hostname: string } }) =>
            new DocsHostCache({ props } as never, env as never),
          DocsHtmlCache: htmlCache,
        },
      } as never,
    );

    // No delivery rollout is on, so the dispatcher sets no render ID either.
    expect(internalHeaders(htmlFetch.mock.calls[0]?.[0])).toEqual([]);
    expect(htmlCache).toHaveBeenCalledWith({
      props: expect.objectContaining({ deliveryRenderId: null }),
    });
  });

  test("never reach an uncached dynamic render", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv("all");
    const rendererFetch = vi.fn(
      async (_request: Request) => new Response("dynamic"),
    );
    env.LOADER.get.mockImplementation(() => ({
      getEntrypoint: () => ({ fetch: rendererFetch }),
    }));
    await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: {
          accept: "text/html",
          "cache-control": "no-cache",
          ...INJECTED_HEADERS,
        },
      }),
      env as never,
      {
        exports: {
          DocsHostCache: ({ props }: { props: { hostname: string } }) =>
            new DocsHostCache({ props } as never, env as never),
          ScopedDocsContent: vi.fn(),
          DocsRendererCodeCache: vi.fn(),
        },
      } as never,
    );

    expect(rendererFetch).toHaveBeenCalledOnce();
    expect(internalHeaders(rendererFetch.mock.calls[0]?.[0])).toEqual([]);
  });
});

describe("HTTPS redirect at the gateway", () => {
  test("mode on redirects HTTP before the hostname lookup", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const resolver = { fetch: vi.fn() };
    const response = await worker.fetch(
      new Request("http://docs.example.com/guide?a=1"),
      {
        DOCS_RESOLVER: resolver,
        DOXA_PROD_HTTPS_REDIRECT_MODE: "on",
        DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      } as never,
      { exports: {} } as never,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://docs.example.com/guide?a=1",
    );
    expect(resolver.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["on", "max-age=86400"],
    ["off", null],
  ])("mode %s sets HSTS %s on an HTTPS page", async (mode, expected) => {
    const env = {
      SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
      DOXA_PROD_HTTPS_REDIRECT_MODE: mode,
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "off",
    };
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      env as never,
      { exports: {} } as never,
    );

    expect(await response.text()).toBe("shared");
    expect(response.headers.get("strict-transport-security")).toBe(expected);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("runtime call traces", () => {
  test("the content binding sends its own trace, never the renderer's", async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { type: "page" },
      timing: { totalMs: 3 },
    }));
    const content = new ScopedDocsContent(
      { props: { resolution: publicResolution } } as never,
      { DOCS_RUNTIME: { request } } as never,
    );

    const answer = await content.request({
      operation: "getPage",
      payload: { pathname: "/guide" },
      // A renderer cannot choose the trace ID.
      ...{ trace: { id: "renderer-chosen", caller: "plan" } },
    });

    expect(answer).toEqual({ ok: true, data: { type: "page" } });
    expect(request).toHaveBeenCalledWith({
      resolution: publicResolution,
      operation: "getPage",
      payload: { pathname: "/guide" },
      trace: { id: expect.stringMatching(UUID), caller: "content" },
    });
  });

  test("the pre-render plan call is traced as plan", async () => {
    const request = vi.fn(async () => ({ ok: true as const, data: [] }));
    const api = new PrerenderRendererApi(
      {} as never,
      { DOCS_RUNTIME: { request } } as never,
    );

    await api.getPlan({ resolution: publicResolution });

    expect(request).toHaveBeenCalledWith({
      resolution: publicResolution,
      operation: "getPrerenderPlan",
      trace: { id: expect.stringMatching(UUID), caller: "plan" },
    });
  });
});

describe("route-data prefetch for prepare", () => {
  function prepare(options: { mode: string; cold: boolean }) {
    const runtimeRequest = vi.fn(async () => ({
      ok: true as const,
      data: { type: "page" },
    }));
    const waitUntil = vi.fn();
    const contentProps: unknown[] = [];
    const env = {
      DOCS_RUNTIME: { request: runtimeRequest },
      LOADER: { get: vi.fn() },
      RENDERER_CODE_BUCKET: {},
      DOXA_PROD_ROUTE_DATA_PREFETCH_MODE: options.mode,
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    };
    const ctx = {
      waitUntil,
      exports: {
        ScopedDocsContent: ({ props }: { props: unknown }) => {
          contentProps.push(props);
          return new ScopedDocsContent({ props } as never, env as never);
        },
        DocsRendererCodeCache: vi.fn(),
      },
    };
    env.LOADER.get.mockImplementation(
      (_id: string, getCode: () => Promise<WorkerLoaderWorkerCode>) => {
        const started = options.cold ? getCode() : undefined;
        return {
          getEntrypoint: () => ({
            // Like docs-template's DocsPrerenderRenderer.prepare.
            prepare: async () => {
              const code = await started;
              const content = code?.env?.DOXA_DOCS_CONTENT_BINDING;
              const binding =
                content instanceof ScopedDocsContent
                  ? content
                  : new ScopedDocsContent(
                      { props: contentProps[0] } as never,
                      env as never,
                    );
              await binding.request({
                operation: "getRouteData",
                payload: { pathname: "/guide" },
              });
              return createRouteData();
            },
            render: vi.fn(),
          }),
        };
      },
    );
    const api = new PrerenderRendererApi(ctx as never, env as never);
    const result = api.prepare({
      resolution: publicResolution,
      pathname: "/guide/",
    });
    return { result, runtimeRequest, waitUntil, contentProps };
  }

  function rendererLoadLine(info: ReturnType<typeof vi.spyOn>) {
    return info.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .find((value) => value.event === "docs_renderer_load");
  }

  test("a cold prepare prefetches its route data and hands it over", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { result, runtimeRequest, waitUntil, contentProps } = prepare({
      mode: "all",
      cold: true,
    });

    await expect(result).resolves.toEqual(createRouteData());
    expect(runtimeRequest).toHaveBeenCalledOnce();
    expect(runtimeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getRouteData",
        payload: { pathname: "/guide" },
        trace: expect.objectContaining({ caller: "prefetch" }),
      }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(contentProps[0]).toHaveProperty("routeDataPrefetchId");
    const line = rendererLoadLine(info);
    expect(line.entrypoint).toBe("prepare");
    expect(line.routeDataPrefetch).toMatchObject({
      outcome: "handedOff",
      traceId: expect.stringMatching(UUID),
    });
  });

  test("a warm prepare prefetches nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { result, runtimeRequest, waitUntil } = prepare({
      mode: "all",
      cold: false,
    });

    await result;
    expect(runtimeRequest).toHaveBeenCalledOnce();
    expect(runtimeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        trace: expect.objectContaining({ caller: "content" }),
      }),
    );
    expect(waitUntil).not.toHaveBeenCalled();
    expect(rendererLoadLine(info)).not.toHaveProperty("routeDataPrefetch");
  });

  test("mode off keeps prepare unchanged", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { result, waitUntil, contentProps } = prepare({
      mode: "off",
      cold: true,
    });

    await result;
    expect(waitUntil).not.toHaveBeenCalled();
    expect(contentProps[0]).toEqual({ resolution: publicResolution });
    expect(rendererLoadLine(info)).not.toHaveProperty("routeDataPrefetch");
  });
});
