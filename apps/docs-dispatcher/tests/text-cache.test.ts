import type { DocsDomainResolution } from "@doxahq/contracts";
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

import worker, { DocsTextCache } from "../src/index";
import {
  DOCS_TEXT_CACHE_FORMAT,
  createCanonicalTextRequest,
  isCacheableDocsTextRequest,
  matchDocsTextRoute,
  readTextRouteCacheRollout,
  selectDocsTextCacheRoute,
  withDocsTextCachePolicy,
  type DocsTextRoute,
  type TextCacheProps,
} from "../src/text-cache-policy";

afterEach(() => {
  vi.restoreAllMocks();
});

const VERSIONED =
  "public, max-age=2592000, stale-while-revalidate=604800, stale-if-error=604800";

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

const request = (path: string, init?: RequestInit) =>
  new Request(`https://docs.example.com${path}`, init);

const allRollout = { mode: "all" as const, siteIds: new Set<string>() };

describe("text route allowlist", () => {
  test.each<[string, DocsTextRoute]>([
    ["/llms.txt", "llms"],
    ["/llms-full.txt", "llms-full"],
    ["/sitemap.xml", "sitemap"],
    ["/robots.txt", "robots"],
    ["/guide.md", "md"],
    ["/index.md", "md"],
    ["/llms.md", "md"],
    ["/guides/Get_started-2.md", "md"],
    ["/a/b/c/d.md", "md"],
    // Docs pages under an api path (RES-2).
    ["/docs/api.md", "md"],
    ["/api/notes/create.md", "md"],
  ])("accepts %s", (path, route) => {
    expect(matchDocsTextRoute(path)).toBe(route);
    expect(isCacheableDocsTextRequest(request(path))).toBe(true);
    expect(isCacheableDocsTextRequest(request(path, { method: "HEAD" }))).toBe(
      true,
    );
  });

  test.each([
    // Not exact.
    "/llms.txt/",
    "/LLMS.txt",
    "/docs/llms.txt",
    "/llms.txt.md",
    "/Sitemap.xml",
    "/docs/sitemap.xml",
    "/robots.txt/",
    // One `.md` suffix, segments from [A-Za-z0-9_-].
    "/.md",
    "/guide.md/",
    "/guide.md.md",
    "/a.b.md",
    "/v1.2/guide.md",
    "/a//b.md",
    "/guide.MD",
    "/guide",
    // Percent, traversal and backslash.
    "/a%20b.md",
    "/%2e%2e/guide.md",
    "/a/../b.md",
    "/a\\b.md",
    // Private segments and the renderer's own server routes.
    "/_doxa/guide.md",
    "/docs/_hidden.md",
    "/api/search.md",
    "/API/search.md",
    "/api/echo/v1/notes.md",
  ])("rejects the path %s", (path) => {
    expect(matchDocsTextRoute(path)).toBeNull();
  });

  test.each<[string, RequestInit]>([
    ["/llms.txt?x=1", {}],
    ["/guide.md?raw", {}],
    ["/llms.txt", { method: "POST" }],
    ["/llms.txt", { method: "OPTIONS" }],
    ["/llms.txt", { headers: { cookie: "session=1" } }],
    ["/guide.md", { headers: { authorization: "Bearer x" } }],
    ["/llms-full.txt", { headers: { range: "bytes=0-10" } }],
  ])("rejects the visitor request %s %j", (path, init) => {
    expect(isCacheableDocsTextRequest(request(path, init))).toBe(false);
  });

  test("rejects plain HTTP", () => {
    expect(
      isCacheableDocsTextRequest(new Request("http://docs.example.com/llms.txt")),
    ).toBe(false);
  });

  test("rejects the URL-normalized traversal forms", () => {
    // The URL parser resolves dot segments; the result must still pass.
    expect(request("/a/../_doxa/x.md").url).toBe(
      "https://docs.example.com/_doxa/x.md",
    );
    expect(isCacheableDocsTextRequest(request("/a/../_doxa/x.md"))).toBe(false);
    expect(
      isCacheableDocsTextRequest(request("/a/%2e%2e/api/search.md")),
    ).toBe(false);
  });
});

describe("text route rollout", () => {
  test("is off by default and warns about an invalid mode", () => {
    const warn = vi.fn();
    expect(readTextRouteCacheRollout({}, warn).mode).toBe("off");
    expect(warn).not.toHaveBeenCalled();
    expect(
      readTextRouteCacheRollout(
        { DOXA_PROD_TEXT_ROUTE_CACHE_MODE: "everything" },
        warn,
      ).mode,
    ).toBe("off");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("selects only public production sites in the rollout", () => {
    const llms = request("/llms.txt");
    expect(selectDocsTextCacheRoute(llms, resolution, allRollout)).toBe("llms");
    expect(
      selectDocsTextCacheRoute(llms, resolution, {
        mode: "off",
        siteIds: new Set(["site-1"]),
      }),
    ).toBeNull();
    expect(
      selectDocsTextCacheRoute(llms, resolution, {
        mode: "allowlist",
        siteIds: new Set(["site-1"]),
      }),
    ).toBe("llms");
    expect(
      selectDocsTextCacheRoute(llms, resolution, {
        mode: "allowlist",
        siteIds: new Set(["site-2"]),
      }),
    ).toBeNull();
    expect(
      selectDocsTextCacheRoute(
        llms,
        { ...resolution, accessPolicy: "authenticated" },
        allRollout,
      ),
    ).toBeNull();
    expect(
      selectDocsTextCacheRoute(
        llms,
        { ...resolution, renderTarget: "preview" },
        allRollout,
      ),
    ).toBeNull();
  });
});

describe("createCanonicalTextRequest (FS-L2)", () => {
  test("never copies a visitor header, If-None-Match included", () => {
    const canonical = createCanonicalTextRequest(
      request("/llms.txt?x=1", {
        method: "HEAD",
        headers: { "if-none-match": '"doxa1-x"', cookie: "a=1", range: "bytes=0-1" },
      }),
    );
    expect(canonical.url).toBe("https://docs.example.com/llms.txt");
    expect(canonical.method).toBe("GET");
    expect([...canonical.headers.entries()]).toEqual([["accept", "*/*"]]);
  });
});

describe("withDocsTextCachePolicy", () => {
  const respond = (contentType: string, init: ResponseInit = {}) =>
    new Response("text", {
      ...init,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=3600",
        ...init.headers,
      },
    });

  test.each<[DocsTextRoute, string]>([
    ["llms", "text/plain; charset=utf-8"],
    ["llms-full", "text/plain"],
    ["sitemap", "application/xml; charset=utf-8"],
    ["robots", "text/plain; charset=utf-8"],
    ["md", "text/markdown; charset=utf-8"],
  ])("stores %s as %s for the versioned lifetime", (route, contentType) => {
    const response = withDocsTextCachePolicy(respond(contentType), route);
    expect(response.headers.get("cache-control")).toBe(VERSIONED);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(VERSIONED);
    expect(response.headers.get("content-type")).toBe(contentType);
  });

  test.each<[DocsTextRoute, string, ResponseInit]>([
    // An `.md` path with raw Markdown off falls through to the HTML pages.
    ["md", "text/html; charset=utf-8", {}],
    ["llms", "text/html", {}],
    ["llms", "text/markdown", {}],
    ["md", "text/plain; charset=utf-8", {}],
    ["llms", "application/octet-stream", {}],
    ["md", "text/markdown", { status: 404 }],
    ["llms", "text/plain", { status: 500 }],
    ["llms", "text/plain", { status: 301 }],
    // A static template sitemap or an HTML page is never stored as a sitemap.
    ["sitemap", "text/html", {}],
    ["sitemap", "application/xml", { status: 404 }],
    ["robots", "text/html", {}],
    ["llms", "text/plain", { headers: { "set-cookie": "a=b" } }],
    ["llms", "text/plain", { headers: { vary: "accept" } }],
    ["md", "text/markdown", { headers: { "cache-control": "no-store" } }],
  ])("does not store %s with %s %j", (route, contentType, init) => {
    const response = withDocsTextCachePolicy(respond(contentType, init), route);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("DocsTextCache", () => {
  const props: TextCacheProps = {
    hostname: "docs.example.com",
    rendererBuildId: "build-1",
    resolution,
    route: "llms",
    deliveryRenderId: null,
    format: DOCS_TEXT_CACHE_FORMAT,
  };

  function createEnv() {
    const render = vi.fn(
      async (_request: Request) =>
        new Response("# Demo", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    return {
      LOADER: {
        get: vi.fn(() => ({ getEntrypoint: () => ({ fetch: render }) })),
      },
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
      render,
    };
  }

  function createEntrypoint(
    entryProps: TextCacheProps,
    env: ReturnType<typeof createEnv>,
  ) {
    return new DocsTextCache(
      {
        props: entryProps,
        exports: { ScopedDocsContent: () => ({ request: vi.fn() }) },
      } as never,
      env as never,
    );
  }

  test("renders the canonical request with the pinned renderer and stores it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv();
    const response = await createEntrypoint(props, env).fetch(
      createCanonicalTextRequest(request("/llms.txt")),
    );

    expect(await response.text()).toBe("# Demo");
    expect(response.headers.get("cache-control")).toBe(VERSIONED);
    expect(env.LOADER.get).toHaveBeenCalledWith(
      "docs:site-1:version-1:build-1",
      expect.any(Function),
    );
    const rendered = env.render.mock.calls[0]?.[0];
    expect(rendered?.method).toBe("GET");
    expect(rendered?.headers.get("accept")).toBe("*/*");
  });

  test("answers a revalidation with its identity ETag by 304, without rendering", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stored = await createEntrypoint(props, createEnv()).fetch(
      createCanonicalTextRequest(request("/llms.txt")),
    );
    const etag = stored.headers.get("etag");
    expect(etag).toBeTruthy();

    const env = createEnv();
    const revalidation = createCanonicalTextRequest(request("/llms.txt"));
    revalidation.headers.set("if-none-match", etag ?? "");
    const response = await createEntrypoint(props, env).fetch(revalidation);

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(env.LOADER.get).not.toHaveBeenCalled();
  });

  test.each<{ name: string; entryProps: TextCacheProps; path?: string; init?: RequestInit }>([
    { name: "another route", entryProps: { ...props, route: "md" } },
    { name: "a stale build", entryProps: { ...props, rendererBuildId: "old" } },
    { name: "another hostname", entryProps: { ...props, hostname: "x.example.com" } },
    {
      name: "a private version",
      entryProps: {
        ...props,
        resolution: { ...resolution, accessPolicy: "authenticated" },
      },
    },
    { name: "another format", entryProps: { ...props, format: 2 } },
    { name: "a HEAD", entryProps: props, init: { method: "HEAD", headers: { accept: "*/*" } } },
    { name: "an HTML accept", entryProps: props, init: { headers: { accept: "text/html" } } },
    { name: "a query", entryProps: props, path: "/llms.txt?x=1", init: { headers: { accept: "*/*" } } },
    { name: "a path outside the allowlist", entryProps: { ...props, route: "md" }, path: "/_doxa/x.md", init: { headers: { accept: "*/*" } } },
  ])("rejects $name before rendering", async ({ entryProps, path, init }) => {
    const env = createEnv();
    const response = await createEntrypoint(entryProps, env).fetch(
      init
        ? request(path ?? "/llms.txt", init)
        : createCanonicalTextRequest(request(path ?? "/llms.txt")),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(env.LOADER.get).not.toHaveBeenCalled();
  });
});

describe("dispatcher text routes", () => {
  function createGateway(textMode: string) {
    const textFetch = vi.fn(
      async (_request: Request) =>
        new Response("# Demo", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": VERSIONED,
            "cf-cache-status": "HIT",
          },
        }),
    );
    const htmlFetch = vi.fn(
      async (_request: Request) =>
        new Response("<h1>Guide</h1>", {
          headers: { "content-type": "text/html", "cf-cache-status": "HIT" },
        }),
    );
    const render = vi.fn(
      async (_request: Request) =>
        new Response("uncached", { headers: { "content-type": "text/plain" } }),
    );
    const ctx = {
      exports: {
        DocsHostCache: vi.fn(() => ({
          fetch: async () => Response.json(resolution),
        })),
        DocsHtmlCache: vi.fn(() => ({ fetch: htmlFetch })),
        DocsTextCache: vi.fn(() => ({ fetch: textFetch })),
        ScopedDocsContent: vi.fn(() => ({ request: vi.fn() })),
      },
    };
    const env = {
      DOCS_RESOLVER: { fetch: vi.fn() },
      SHARED_RENDERER: { fetch: vi.fn() },
      LOADER: {
        get: vi.fn(() => ({ getEntrypoint: () => ({ fetch: render }) })),
      },
      DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
      DOXA_PROD_TEXT_ROUTE_CACHE_MODE: textMode,
      DOXA_RENDERER_BUILD_ID: "build-1",
      DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    };
    return { ctx, env, textFetch, htmlFetch, render };
  }

  test("serves a text route from DocsTextCache with its own props", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const gateway = createGateway("all");

    const response = await worker.fetch(
      request("/llms.txt", {
        headers: { accept: "text/plain", "x-forwarded-host": "evil.example" },
      }),
      gateway.env as never,
      gateway.ctx as never,
    );

    expect(await response.text()).toBe("# Demo");
    expect(gateway.ctx.exports.DocsTextCache).toHaveBeenCalledWith({
      props: {
        hostname: "docs.example.com",
        rendererBuildId: "build-1",
        resolution,
        route: "llms",
        deliveryRenderId: null,
        format: 1,
      },
    });
    expect(gateway.ctx.exports.DocsHtmlCache).not.toHaveBeenCalled();
    expect(gateway.render).not.toHaveBeenCalled();
    const canonical = gateway.textFetch.mock.calls[0]?.[0];
    expect(canonical?.url).toBe("https://docs.example.com/llms.txt");
    expect(canonical?.method).toBe("GET");
    expect([...(canonical?.headers.entries() ?? [])]).toEqual([
      ["accept", "*/*"],
    ]);
    // The public gateway itself stays uncacheable.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-doxa-text-cache")).toBe("HIT");
    const logged = info.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "docs_text_cache");
    expect(logged).toEqual({
      event: "docs_text_cache",
      hostname: "docs.example.com",
      siteId: "site-1",
      route: "llms",
      status: 200,
      cacheStatus: "HIT",
    });
  });

  test("answers a visitor HEAD from the canonical GET without a body", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const gateway = createGateway("all");

    const response = await worker.fetch(
      request("/guide.md", { method: "HEAD" }),
      gateway.env as never,
      gateway.ctx as never,
    );

    expect(gateway.textFetch.mock.calls[0]?.[0].method).toBe("GET");
    expect(gateway.ctx.exports.DocsTextCache).toHaveBeenCalledWith({
      props: expect.objectContaining({ route: "md" }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  test.each<[string, RequestInit]>([
    ["/llms-full.txt?fresh=1", {}],
    ["/llms-full.txt", { headers: { cookie: "session=1" } }],
    ["/guide.md", { headers: { authorization: "Bearer x" } }],
    ["/llms-full.txt", { headers: { range: "bytes=0-10" } }],
    ["/llms.txt?a=1&b=2", { headers: { cookie: "x=1", "if-none-match": '"v"' } }],
  ])(
    "serves %s %j from DocsTextCache with the canonical request (FS-M2)",
    async (path, init) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const gateway = createGateway("all");

      const response = await worker.fetch(
        request(path, init),
        gateway.env as never,
        gateway.ctx as never,
      );

      expect(response.status).toBe(200);
      expect(gateway.render).not.toHaveBeenCalled();
      const canonical = gateway.textFetch.mock.calls[0]?.[0];
      expect(canonical?.url).toBe(
        `https://docs.example.com${new URL(path, "https://x").pathname}`,
      );
      expect([...(canonical?.headers.entries() ?? [])]).toEqual([
        ["accept", "*/*"],
      ]);
    },
  );

  test("keeps the uncached path for a private site with a cookie (FS-M2)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const gateway = createGateway("all");
    gateway.ctx.exports.DocsHostCache = vi.fn(() => ({
      fetch: async () =>
        Response.json({ ...resolution, accessPolicy: "authenticated" }),
    }));

    await worker.fetch(
      request("/llms.txt", { headers: { cookie: "session=1" } }),
      gateway.env as never,
      gateway.ctx as never,
    );

    expect(gateway.ctx.exports.DocsTextCache).not.toHaveBeenCalled();
  });

  test("keeps HTML pages on DocsHtmlCache with unchanged props", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const gateway = createGateway("all");

    await worker.fetch(
      request("/guide", { headers: { accept: "text/html" } }),
      gateway.env as never,
      gateway.ctx as never,
    );

    expect(gateway.ctx.exports.DocsTextCache).not.toHaveBeenCalled();
    expect(gateway.ctx.exports.DocsHtmlCache).toHaveBeenCalledWith({
      props: {
        hostname: "docs.example.com",
        rendererBuildId: "build-1",
        resolution,
        lifetime: "versioned",
        deliveryRenderId: null,
      },
    });
  });

  test.each<[string, string, RequestInit]>([
    ["off", "/llms.txt", {}],
    ["invalid", "/llms.txt", {}],
    ["all", "/_doxa/x.md", {}],
  ])(
    "renders uncached when the mode is %s for %s %j",
    async (mode, path, init) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const gateway = createGateway(mode);

      const response = await worker.fetch(
        request(path, init),
        gateway.env as never,
        gateway.ctx as never,
      );

      expect(await response.text()).toBe("uncached");
      expect(gateway.ctx.exports.DocsTextCache).not.toHaveBeenCalled();
      expect(gateway.render).toHaveBeenCalledOnce();
    },
  );
});
