import type { DocsDomainResolution } from "@doxahq/contracts";
import { MAX_BROWSER_SEARCH_INDEX_BYTES } from "@doxahq/contracts/docs-search";
import { describe, expect, it, vi } from "vitest";

import {
  createSearchConfig,
  handleDocsSearchRequest,
  isDocsSearchRequest,
  type DocsSearchRouteDependencies,
} from "../src/search-route";

const VERSION = "22222222-2222-4222-8222-222222222222";
const COMPILED = JSON.stringify({
  schemaVersion: 1,
  contentVersion: VERSION,
  serializedIndex: JSON.stringify({
    documentIds: { "0": "/a" },
    storedFields: { "0": { slug: "/a", lines: [{ text: "Line", anchor: "x" }] } },
  }),
});
const resolution = {
  siteId: "11111111-1111-4111-8111-111111111111",
  projectId: "p",
  projectSlug: "acme",
  publishedVersionId: VERSION,
  artifactPrefix: "sites/x/versions/y",
  manifestPath: "sites/x/versions/y/manifest.json",
  accessPolicy: "public",
  hostname: "acme.doxa.page",
  domainKind: "doxa_subdomain",
} as DocsDomainResolution;

function setup(overrides: Partial<DocsSearchRouteDependencies> = {}) {
  const store = new Map<string, Response>();
  const request = vi.fn(async (_input: unknown) => ({ ok: true, data: COMPILED }));
  const deps: DocsSearchRouteDependencies = {
    resolveHost: async () => resolution,
    runtime: { request } as unknown as DocsSearchRouteDependencies["runtime"],
    mode: "on",
    gatewayOrigin: "https://lexis.doxa.so",
    usage: undefined,
    cache: {
      match: async (key: RequestInfo | URL) =>
        store.get(String((key as Request).url))?.clone(),
      put: async (key: RequestInfo | URL, value: Response) => {
        store.set(String((key as Request).url), value);
      },
    } as DocsSearchRouteDependencies["cache"],
    waitUntil: () => {},
    ...overrides,
  };
  return { deps, request };
}

const url = (path: string) => new Request(`https://acme.doxa.page${path}`);

describe("search config", () => {
  it("stays on the renderer until the mode turns it on", () => {
    expect(createSearchConfig(resolution, { mode: undefined, gatewayOrigin: undefined })).toEqual({
      mode: "server",
    });
  });

  it("uses the browser for a site without a remote provider", () => {
    expect(createSearchConfig(resolution, { mode: "on", gatewayOrigin: "https://g" })).toMatchObject({
      mode: "browser",
      contentVersion: VERSION,
    });
  });

  it("uses the gateway for a production site with a remote provider", () => {
    expect(
      createSearchConfig(
        {
          ...resolution,
          searchProvider: "typesense",
          searchIndexKey: "s_key",
          renderTarget: "production",
        },
        { mode: "on", gatewayOrigin: "https://lexis.doxa.so" },
      ),
    ).toEqual({ mode: "gateway", endpoint: "https://lexis.doxa.so/v1/search" });
  });

  it("uses the browser while a site has no remote index", () => {
    expect(
      createSearchConfig(
        { ...resolution, searchProvider: "typesense", renderTarget: "production" },
        { mode: "on", gatewayOrigin: "https://g" },
      ).mode,
    ).toBe("browser");
  });

  it("uses the browser for a preview, even with a remote provider", () => {
    expect(
      createSearchConfig(
        {
          ...resolution,
          searchProvider: "typesense",
          searchIndexKey: "s_key",
          renderTarget: "preview",
        },
        { mode: "on", gatewayOrigin: "https://g" },
      ).mode,
    ).toBe("browser");
  });

  // SECURITY REGRESSION GUARDRAIL: the renderer runs the access gate.
  it("sends a gated site to the renderer", () => {
    expect(
      createSearchConfig(
        { ...resolution, accessPolicy: "authenticated" } as DocsDomainResolution,
        { mode: "on", gatewayOrigin: "https://g" },
      ),
    ).toEqual({ mode: "server" });
  });
});

describe("search files", () => {
  it("matches only its own paths", () => {
    expect(isDocsSearchRequest(url("/_doxa/search/v1/index"))).toBe(true);
    expect(isDocsSearchRequest(url("/_doxa/search/v1/other"))).toBe(false);
  });

  it("marks the current version immutable and fills the edge cache", async () => {
    const { deps, request } = setup();
    const first = await handleDocsSearchRequest(url(`/_doxa/search/v1/index?v=${VERSION}`), deps);
    expect(first.headers.get("cache-control")).toContain("immutable");
    expect(await first.text()).not.toContain('"lines"');

    await handleDocsSearchRequest(url(`/_doxa/search/v1/index?v=${VERSION}`), deps);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers 409 for another version, so one engine never mixes two", async () => {
    const { deps, request } = setup();
    for (const path of [
      "/_doxa/search/v1/index?v=old",
      "/_doxa/search/v1/snippets?v=old",
      "/_doxa/search/v1/index",
    ]) {
      const response = await handleDocsSearchRequest(url(path), deps);
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(request).not.toHaveBeenCalled();
  });

  // SECURITY REGRESSION GUARDRAIL: the read uses only the resolved site.
  it("takes nothing from the request for the read", async () => {
    const { deps, request } = setup();
    await handleDocsSearchRequest(
      url(`/_doxa/search/v1/index?v=${VERSION}&prefix=sites/other&path=../x`),
      deps,
    );
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      resolution,
      operation: "getCompiledSearchIndex",
    });
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("payload");
  });

  it("serves no file for a gated site", async () => {
    const { deps, request } = setup({
      resolveHost: async () =>
        ({ ...resolution, accessPolicy: "authenticated" }) as DocsDomainResolution,
    });
    const response = await handleDocsSearchRequest(url(`/_doxa/search/v1/index?v=${VERSION}`), deps);
    expect(response.status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("serves the snippets from the same compiled index", async () => {
    const { deps } = setup();
    const response = await handleDocsSearchRequest(
      url(`/_doxa/search/v1/snippets?v=${VERSION}`),
      deps,
    );
    expect(await response.json()).toEqual({ "/a": [{ text: "Line", anchor: "x" }] });
  });

  it("answers 404 for a version with no compiled index", async () => {
    const request = vi.fn(async () => ({ ok: true, data: null }));
    const { deps } = setup({
      runtime: { request } as unknown as DocsSearchRouteDependencies["runtime"],
    });
    const response = await handleDocsSearchRequest(url(`/_doxa/search/v1/index?v=${VERSION}`), deps);
    expect(response.status).toBe(404);
  });

  it("answers 413 for an index above the browser limit", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      data: JSON.stringify({
        serializedIndex: JSON.stringify({
          documentIds: {},
          storedFields: {},
          index: "x".repeat(MAX_BROWSER_SEARCH_INDEX_BYTES + 1),
        }),
      }),
    }));
    const { deps } = setup({
      runtime: { request } as unknown as DocsSearchRouteDependencies["runtime"],
    });
    const response = await handleDocsSearchRequest(url(`/_doxa/search/v1/index?v=${VERSION}`), deps);
    expect(response.status).toBe(413);
  });

  it("allows only reads", async () => {
    const { deps } = setup();
    const response = await handleDocsSearchRequest(
      new Request("https://acme.doxa.page/_doxa/search/v1/config", { method: "POST" }),
      deps,
    );
    expect(response.status).toBe(405);
  });
});
