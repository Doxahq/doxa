import { resolveSiteConfig } from "@doxahq/site-config";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { DoxaDocsRuntimeSource } from "./runtime/runtime-source";
import server, { renderPreparedDocsRequest } from "./server";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const handlers = vi.hoisted(() => ({
  accessGate: vi.fn(async (): Promise<Response | null> => null),
  rawMarkdown: vi.fn(async () => null),
  redirect: vi.fn(() => null),
  start: vi.fn(async () => new Response("rendered")),
}));

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => handlers.start,
  defaultStreamHandler: vi.fn(),
}));

vi.mock("@/src/lib/access-gate", () => ({
  getAccessGateResponse: handlers.accessGate,
}));

vi.mock("@/src/lib/raw-markdown", () => ({
  tryRawMarkdownResponse: handlers.rawMarkdown,
}));

vi.mock("@/src/lib/request-redirects", () => ({
  getRedirectResponse: handlers.redirect,
}));

describe("docs renderer server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("answers the health request before the documentation request pipeline", async () => {
    const response = await server.fetch(
      new Request("https://docs.example.com/.well-known/doxa-health", {
        method: "HEAD",
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("x-doxa-renderer-health")).toBe("ok");
    expect(handlers.redirect).not.toHaveBeenCalled();
    expect(handlers.accessGate).not.toHaveBeenCalled();
    expect(handlers.rawMarkdown).not.toHaveBeenCalled();
    expect(handlers.start).not.toHaveBeenCalled();
  });

  test("passes a dispatcher-scoped runtime source into TanStack Start", async () => {
    const runtimeBinding = {
      request: vi.fn(async () => ({ ok: true as const, data: null })),
    };
    await server.fetch(new Request("https://docs.example.com/guide"), {
      DOXA_DOCS_RUNTIME_SOURCE: "binding",
      DOXA_DOCS_CONTENT_BINDING: runtimeBinding,
      DOXA_DOCS_CONTENT_RESOLUTION: {
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "demo",
        publishedVersionId: "version-1",
        artifactPrefix: "sites/site-1/versions/version-1",
        manifestPath: "sites/site-1/versions/version-1/manifest.json",
        accessPolicy: "public",
      },
    });

    expect(handlers.start).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        context: expect.objectContaining({
          runtimeSourceMode: "binding",
          runtimeSource: expect.any(Object),
        }),
      })
    );
    expect(handlers.rawMarkdown).toHaveBeenCalledWith(
      "/guide",
      expect.any(Object)
    );
  });

  test("renders prepared data through the installed TanStack handler", async () => {
    const runtimeSource = createUnusedRuntimeSource();
    const routeData = {
      type: "redirect" as const,
      href: "/overview",
      status: 308 as const,
    };

    await renderPreparedDocsRequest(new Request("https://docs.example.com/"), {
      runtimeSource,
      pathname: "/",
      routeData,
      renderId: "a".repeat(64),
    });

    expect(handlers.start).toHaveBeenCalledWith(expect.any(Request), {
      context: expect.objectContaining({
        preparedRoute: { pathname: "/", data: routeData },
        delivery: {
          mode: "public-production",
          renderId: "a".repeat(64),
          schemaVersion: 1,
        },
        runtimeSource,
        runtimeSourceMode: "binding",
      }),
    });
  });

  test("loads HTML configuration in the single route-data request", async () => {
    const config = resolveSiteConfig({ name: "One-shot configuration" });
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { type: "page", siteConfig: config },
    }));
    await server.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      {
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: { request },
        DOXA_DOCS_CONTENT_RESOLUTION: {
          siteId: "site-1",
          projectId: "project-1",
          projectSlug: "demo",
          publishedVersionId: "version-1",
          artifactPrefix: "sites/site-1/versions/version-1",
          manifestPath: "sites/site-1/versions/version-1/manifest.json",
          accessPolicy: "public",
        },
      }
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getRouteData",
        payload: { pathname: "/guide" },
      })
    );
    expect(handlers.start).toHaveBeenCalledWith(expect.any(Request), {
      context: expect.objectContaining({ siteConfig: config }),
    });
  });

  test("serves a platform-mode asset with the request host, outside the Start context", async () => {
    vi.stubEnv("DOXA_DOCS_RUNTIME_SOURCE", "platform");
    vi.stubEnv("DOXA_DOCS_CONTENT_WORKER_URL", "http://content.test");
    vi.stubEnv("DOXA_DOCS_CONTENT_TOKEN", "local-token");
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
    vi.stubGlobal("fetch", fetch);
    const hash = "b".repeat(64);
    try {
      const response = await server.fetch(
        new Request(`http://flagforge.localhost:3002/_doxa/assets/${hash}`)
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<svg/>");
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe(`http://content.test/runtime-source/assets/${hash}`);
      expect(new Headers(init?.headers).get("x-doxa-host")).toBe(
        "flagforge.localhost:3002"
      );
      expect(handlers.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("forwards the content hash of a pinned image URL", async () => {
    const sha256 = "d".repeat(64);
    const versionAsset = vi.fn(
      async () =>
        new Response("png", { headers: { "content-type": "image/png" } })
    );
    await server.fetch(
      new Request(`https://docs.example.com/assets/diagram.png?v=${sha256}`),
      {
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: { request: vi.fn(), versionAsset },
        DOXA_DOCS_CONTENT_RESOLUTION: RESOLUTION,
      }
    );

    expect(versionAsset).toHaveBeenCalledWith({
      resolution: RESOLUTION,
      name: "diagram.png",
      version: sha256,
    });
  });

  test("serves a version image through the dispatcher binding", async () => {
    const versionAsset = vi.fn(
      async () =>
        new Response("png", { headers: { "content-type": "image/png" } })
    );
    const response = await server.fetch(
      new Request("https://docs.example.com/assets/diagram.png"),
      {
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: {
          request: vi.fn(),
          versionAsset,
        },
        DOXA_DOCS_CONTENT_RESOLUTION: RESOLUTION,
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png");
    expect(versionAsset).toHaveBeenCalledWith({
      resolution: RESOLUTION,
      name: "diagram.png",
    });
    expect(handlers.start).not.toHaveBeenCalled();
  });

  test("serves a platform-mode version image with the request host", async () => {
    vi.stubEnv("DOXA_DOCS_RUNTIME_SOURCE", "platform");
    vi.stubEnv("DOXA_DOCS_CONTENT_WORKER_URL", "http://content.test");
    vi.stubEnv("DOXA_DOCS_CONTENT_TOKEN", "local-token");
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await server.fetch(
        new Request("http://flagforge.localhost:3002/assets/flow.svg")
      );

      expect(response.status).toBe(200);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        "http://content.test/runtime-source/version-assets/flow.svg"
      );
      expect(new Headers(init?.headers).get("x-doxa-host")).toBe(
        "flagforge.localhost:3002"
      );
      expect(handlers.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("passes a missing version image and other asset paths to the pipeline", async () => {
    const versionAsset = vi.fn(async () => new Response(null, { status: 404 }));
    const env = {
      DOXA_DOCS_RUNTIME_SOURCE: "binding",
      DOXA_DOCS_CONTENT_BINDING: { request: vi.fn(), versionAsset },
      DOXA_DOCS_CONTENT_RESOLUTION: RESOLUTION,
    };

    await server.fetch(
      new Request("https://docs.example.com/assets/missing.png"),
      env
    );
    await server.fetch(
      new Request("https://docs.example.com/assets/index-Bx9_a.js"),
      env
    );

    expect(versionAsset).toHaveBeenCalledOnce();
    expect(handlers.start).toHaveBeenCalledTimes(2);
  });

  test("runs the private access gate before asset delivery", async () => {
    handlers.accessGate.mockResolvedValueOnce(
      new Response("Sign in", { status: 401 })
    );
    const response = await server.fetch(
      new Request(`https://docs.example.com/_doxa/assets/${"a".repeat(64)}`)
    );
    expect(response.status).toBe(401);
    expect(handlers.start).not.toHaveBeenCalled();
  });

  test("runs the private access gate before version image delivery", async () => {
    handlers.accessGate.mockResolvedValueOnce(
      new Response("Sign in", { status: 401 })
    );
    const versionAsset = vi.fn();
    const response = await server.fetch(
      new Request("https://docs.example.com/assets/diagram.png"),
      {
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: { request: vi.fn(), versionAsset },
        DOXA_DOCS_CONTENT_RESOLUTION: RESOLUTION,
      }
    );
    expect(response.status).toBe(401);
    expect(versionAsset).not.toHaveBeenCalled();
  });
});

const RESOLUTION = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
};

function createUnusedRuntimeSource(): DoxaDocsRuntimeSource {
  const unexpected = async (): Promise<never> => {
    throw new Error("The prepared render must not read source data.");
  };
  return {
    getResolvedSiteConfig: async () =>
      resolveSiteConfig({ name: "Prepared site" }),
    getRouteData: unexpected,
    getSiteConfig: unexpected,
    getCompanyConfig: unexpected,
    getSocialConfig: unexpected,
    getThemeConfig: unexpected,
    getFeatureConfig: unexpected,
    getSections: unexpected,
    getNavigation: unexpected,
    getRoutes: unexpected,
    getHomeHref: unexpected,
    resolvePage: unexpected,
    getPage: unexpected,
    getRawPage: unexpected,
    getSearchIndex: unexpected,
  };
}
