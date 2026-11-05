import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  SearchIndexMissingError,
  type SearchReader,
} from "@doxahq/docs-search/providers";
import { describe, expect, it, vi } from "vitest";

import {
  handleSearchRequest,
  type SearchHandlerDependencies,
} from "../src/handler";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INDEX_KEY = `s_${SITE_ID.replaceAll("-", "")}_${VERSION_ID.replaceAll("-", "")}_abcdef01abcdef01abcdef01abcdef01`;
const ORIGIN = "https://docs.acme.com";

const resolution: DocsDomainResolution = {
  siteId: SITE_ID,
  projectId: "p",
  projectSlug: "acme",
  publishedVersionId: VERSION_ID,
  artifactPrefix: "sites/x/versions/y",
  manifestPath: "sites/x/versions/y/manifest.json",
  accessPolicy: "public",
  searchProvider: "typesense",
  searchIndexKey: INDEX_KEY,
  hostname: "docs.acme.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

const hit = {
  id: "/a",
  slug: "/a",
  title: "Alpha",
  breadcrumb: [],
  snippetLine: "alpha",
  score: 1,
  terms: ["alpha"],
};

function setup(overrides: Partial<SearchHandlerDependencies> = {}) {
  const reader: SearchReader = { search: vi.fn(async () => [hit]) };
  const store = new Map<string, string>();
  const writeDataPoint = vi.fn();
  const deps: SearchHandlerDependencies = {
    enabled: true,
    allowHttpOrigins: false,
    resolveHost: vi.fn(async () => resolution),
    readers: { typesense: reader },
    cache: {
      read: async (key) => store.get(key) ?? null,
      write: async (key, body) => void store.set(key, body),
    },
    usage: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    waitUntil: () => {},
    now: () => 0,
    ...overrides,
  };
  return { deps, reader, writeDataPoint };
}

function request(path = "/v1/search?q=alpha", origin: string | null = ORIGIN) {
  return new Request(`https://lexis.doxa.so${path}`, {
    headers: origin ? { origin } : {},
  });
}

describe("search gateway", () => {
  it("answers from the index of the resolved version", async () => {
    const { deps, reader } = setup();
    const response = await handleSearchRequest(request(), deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(reader.search).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: INDEX_KEY, query: "alpha", limit: 8 }),
    );
  });

  // SECURITY REGRESSION GUARDRAIL: a request cannot select another site.
  it("ignores every site or index parameter in the request", async () => {
    const { deps, reader } = setup();
    await handleSearchRequest(
      request("/v1/search?q=alpha&site=other&siteId=other&indexKey=s_other&collection=s_other"),
      deps,
    );
    expect(deps.resolveHost).toHaveBeenCalledWith("docs.acme.com");
    expect(reader.search).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: INDEX_KEY }),
    );
  });

  it("refuses a request with no origin, a bad origin or an unknown site", async () => {
    const { deps } = setup();
    expect((await handleSearchRequest(request("/v1/search?q=ab", null), deps)).status).toBe(403);
    expect(
      (await handleSearchRequest(request("/v1/search?q=ab", "http://docs.acme.com"), deps)).status,
    ).toBe(403);

    const unknown = setup({ resolveHost: async () => null });
    const response = await handleSearchRequest(request(), unknown.deps);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  // SECURITY REGRESSION GUARDRAIL: a gated site never reaches a remote index.
  it("gives no route to a private site, a preview or a browser-search site", async () => {
    for (const changed of [
      { accessPolicy: "authenticated" },
      { renderTarget: "preview" },
      { renderTarget: undefined },
      { searchProvider: "minisearch" },
      { searchProvider: undefined },
      { searchIndexKey: undefined },
    ]) {
      const { deps, reader } = setup({
        resolveHost: async () =>
          ({ ...resolution, ...changed }) as DocsDomainResolution,
      });
      const response = await handleSearchRequest(request(), deps);
      expect(response.status).toBe(404);
      expect(reader.search).not.toHaveBeenCalled();
    }
  });

  // SECURITY REGRESSION GUARDRAIL: a bad stored value cannot reach another site.
  it("refuses an index that does not belong to the site", async () => {
    const other = `s_${"3".repeat(32)}_${"4".repeat(32)}_abcdef01abcdef01abcdef01abcdef01`;
    for (const searchIndexKey of [other, "t_real"]) {
      const { deps, reader } = setup({
        resolveHost: async () => ({ ...resolution, searchIndexKey }),
      });
      expect((await handleSearchRequest(request(), deps)).status).toBe(404);
      expect(reader.search).not.toHaveBeenCalled();
    }
  });

  it("rejects bad queries and other methods", async () => {
    const { deps, reader } = setup();
    for (const path of [
      "/v1/search?q=a",
      `/v1/search?q=${"a".repeat(201)}`,
      "/v1/search?q=ab&limit=21",
      "/v1/search?q=ab&limit=0",
    ]) {
      expect((await handleSearchRequest(request(path), deps)).status).toBe(400);
    }
    expect(reader.search).not.toHaveBeenCalled();
    const post = new Request("https://lexis.doxa.so/v1/search?q=ab", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect((await handleSearchRequest(post, deps)).status).toBe(405);
    expect((await handleSearchRequest(request("/other"), deps)).status).toBe(404);
  });

  it("stops at the client limit before it resolves the host", async () => {
    const { deps } = setup({
      clientLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit,
    });
    const response = await handleSearchRequest(
      new Request("https://lexis.doxa.so/v1/search?q=ab", {
        headers: { origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" },
      }),
      deps,
    );
    expect(response.status).toBe(429);
    expect(deps.resolveHost).not.toHaveBeenCalled();
  });

  it("stops at the site limit", async () => {
    const { deps, reader } = setup({
      siteLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit,
    });
    expect((await handleSearchRequest(request(), deps)).status).toBe(429);
    expect(reader.search).not.toHaveBeenCalled();
  });

  it("answers a repeated query from the cache, keyed by index", async () => {
    const { deps, reader, writeDataPoint } = setup();
    await handleSearchRequest(request("/v1/search?q=Alpha"), deps);
    const second = await handleSearchRequest(request("/v1/search?q=alpha"), deps);

    expect(second.status).toBe(200);
    expect(second.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(reader.search).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[1]?.[0].blobs).toEqual([SITE_ID, "typesense", "cached"]);
  });

  it("counts bytes, not characters, for fresh and cached answers", async () => {
    const accented = { ...hit, title: "Déployé €" };
    const { deps, writeDataPoint } = setup({
      readers: { typesense: { search: async () => [accented] } },
    });
    await handleSearchRequest(request("/v1/search?q=deploy"), deps);
    await handleSearchRequest(request("/v1/search?q=deploy"), deps);

    const expected = new TextEncoder().encode(
      JSON.stringify({ results: [accented] }),
    ).length;
    const [fresh, cached] = writeDataPoint.mock.calls.map(([point]) => point);
    expect(fresh.blobs[2]).toBe("answered");
    expect(fresh.doubles[1]).toBe(expected);
    expect(cached.blobs[2]).toBe("cached");
    expect(cached.doubles[1]).toBe(expected);
  });

  it("tells the browser to fall back when the index is missing or the provider fails", async () => {
    const missing = setup({
      readers: {
        typesense: {
          search: async () => {
            throw new SearchIndexMissingError(INDEX_KEY);
          },
        },
      },
    });
    const notReady = await handleSearchRequest(request(), missing.deps);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ error: "index_not_ready" });

    const failing = setup({
      readers: {
        typesense: {
          search: async () => {
            throw new Error("secret detail");
          },
        },
      },
    });
    const failed = await handleSearchRequest(request(), failing.deps);
    expect(await failed.json()).toEqual({ error: "provider_error" });
  });

  // SECURITY REGRESSION GUARDRAIL: usage records hold no search text.
  it("records no search text", async () => {
    const { deps, writeDataPoint } = setup();
    await handleSearchRequest(request("/v1/search?q=private-words"), deps);
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("private-words");
  });

  it("stays off until the mode turns it on", async () => {
    const { deps } = setup({ enabled: false });
    expect((await handleSearchRequest(request(), deps)).status).toBe(503);
  });
});
