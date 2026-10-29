import { describe, expect, test, vi } from "vitest";

import {
  cacheControlFor,
  withHtmlCachePolicy,
  withoutResponseCaching,
} from "../src/cache-policy";
import {
  CACHE_PROBE_HEADER,
  createIdentityEtag,
  fetchWithoutProbeMarker,
  isAcceptedBuild,
  matchesEtag,
  probeCache,
  serveVersionedEntrypoint,
  withCacheProbe,
  withoutCacheProbeMarker,
  type VersionedEntrypointCall,
} from "../src/versioned-entrypoint-protocol";

const DEPLOYED = "d".repeat(64);
const PREVIOUS = "e".repeat(64);
const props = { hostname: "docs.example.com", build: DEPLOYED, nested: { a: 1 } };

function htmlResponse(): Response {
  return withHtmlCachePolicy(
    new Response("<p>Guide</p>", { headers: { "content-type": "text/html" } }),
  );
}

function createCall(
  overrides: Partial<VersionedEntrypointCall<typeof props>> & {
    headers?: Record<string, string>;
  } = {},
) {
  const fill = vi.fn(async () => htmlResponse());
  const isTrusted = vi.fn(() => true);
  const call: VersionedEntrypointCall<typeof props> = {
    entrypoint: "DocsHtmlCache",
    request: new Request("https://docs.example.com/guide", {
      headers: { accept: "text/html", ...overrides.headers },
    }),
    props,
    build: { requested: DEPLOYED, deployed: DEPLOYED, previous: PREVIOUS },
    isTrusted,
    rejection: "Invalid cache request",
    fill,
    ...overrides,
  };
  return { call, fill, isTrusted };
}

describe("identity ETag", () => {
  test("is strong, stable and independent of key order", async () => {
    const first = await createIdentityEtag("DocsHtmlCache", props);
    const reordered = await createIdentityEtag("DocsHtmlCache", {
      nested: { a: 1 },
      build: DEPLOYED,
      hostname: "docs.example.com",
    });
    expect(first).toMatch(/^"doxa1-[a-f0-9]{64}"$/);
    expect(reordered).toBe(first);
  });

  test("changes with the props and with the entrypoint", async () => {
    const base = await createIdentityEtag("DocsHtmlCache", props);
    expect(
      await createIdentityEtag("DocsHtmlCache", { ...props, build: PREVIOUS }),
    ).not.toBe(base);
    expect(await createIdentityEtag("DocsRouteDataCache", props)).not.toBe(
      base,
    );
  });

  test("matches a list and a weak form of the same value", async () => {
    const etag = await createIdentityEtag("DocsHtmlCache", props);
    const request = (value: string) =>
      new Request("https://x.test/", { headers: { "if-none-match": value } });
    expect(matchesEtag(request(etag), etag)).toBe(true);
    expect(matchesEtag(request(`"other", W/${etag}`), etag)).toBe(true);
    expect(matchesEtag(request('"other"'), etag)).toBe(false);
    expect(matchesEtag(new Request("https://x.test/"), etag)).toBe(false);
  });
});

describe("serveVersionedEntrypoint", () => {
  test("stores a deployed-build fill with its identity ETag", async () => {
    const { call, fill } = createCall();
    const response = await serveVersionedEntrypoint(call);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(
      await createIdentityEtag("DocsHtmlCache", props),
    );
    expect(fill).toHaveBeenCalledOnce();
  });

  test("answers a trusted matching revalidation with 304 before the build check (F39)", async () => {
    const etag = await createIdentityEtag("DocsHtmlCache", props);
    const { call, fill, isTrusted } = createCall({
      // A refresh that a probe started carries the probe header too, and
      // its key names a build that a real call would not accept.
      headers: { "if-none-match": etag, [CACHE_PROBE_HEADER]: "1" },
      build: { requested: DEPLOYED, deployed: "f".repeat(64), previous: null },
    });
    const response = await serveVersionedEntrypoint(call);
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe(
      cacheControlFor("versioned"),
    );
    expect(response.headers.get(CACHE_PROBE_HEADER)).toBeNull();
    expect(fill).not.toHaveBeenCalled();
    expect(isTrusted).not.toHaveBeenCalled();
  });

  test("answers a matching refresh with 304 even when its replayed headers fail the trust check", async () => {
    const etag = await createIdentityEtag("DocsHtmlCache", props);
    const { call, fill } = createCall({
      // For example a refresh replayed with `cache-control`: a 400 here
      // would delete the stored entry.
      headers: { "if-none-match": etag, "cache-control": "no-cache" },
      isTrusted: () => false,
    });
    const response = await serveVersionedEntrypoint(call);
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(fill).not.toHaveBeenCalled();
  });

  test("rejects an untrusted call whose ETag does not match", async () => {
    const { call, fill } = createCall({
      headers: { "if-none-match": '"doxa1-other"' },
      isTrusted: () => false,
    });
    const response = await serveVersionedEntrypoint(call);
    expect(response.status).toBe(400);
    expect(response.headers.has("etag")).toBe(false);
    expect(fill).not.toHaveBeenCalled();
  });

  test("fills normally for a revalidation with another ETag", async () => {
    const { call, fill } = createCall({
      headers: { "if-none-match": '"doxa1-old"' },
    });
    expect((await serveVersionedEntrypoint(call)).status).toBe(200);
    expect(fill).toHaveBeenCalledOnce();
  });

  test("answers a probe miss with an uncacheable marker and never fills", async () => {
    const { call, fill } = createCall({ headers: { [CACHE_PROBE_HEADER]: "1" } });
    const response = await serveVersionedEntrypoint(call);
    expect(response.status).toBe(204);
    expect(response.headers.get(CACHE_PROBE_HEADER)).toBe("miss");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("private, no-store");
    expect(fill).not.toHaveBeenCalled();
  });

  test("accepts the previous build only for a probe (F14)", async () => {
    const previous = {
      requested: PREVIOUS,
      deployed: DEPLOYED,
      previous: PREVIOUS,
    };
    const real = createCall({ build: previous });
    const realResponse = await serveVersionedEntrypoint(real.call);
    expect(realResponse.status).toBe(400);
    expect(realResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(real.fill).not.toHaveBeenCalled();

    const probe = createCall({
      build: previous,
      headers: { [CACHE_PROBE_HEADER]: "1" },
    });
    expect((await serveVersionedEntrypoint(probe.call)).status).toBe(204);
    expect(probe.fill).not.toHaveBeenCalled();
  });

  test("rejects an unknown build and an untrusted call, probe or not", async () => {
    const variants: Record<string, string>[] = [{}, { [CACHE_PROBE_HEADER]: "1" }];
    for (const headers of variants) {
      const unknown = createCall({
        headers,
        build: { requested: "f".repeat(64), deployed: DEPLOYED, previous: PREVIOUS },
      });
      expect((await serveVersionedEntrypoint(unknown.call)).status).toBe(400);
      const untrusted = createCall({ headers, isTrusted: () => false });
      expect((await serveVersionedEntrypoint(untrusted.call)).status).toBe(400);
      expect(unknown.fill).not.toHaveBeenCalled();
      expect(untrusted.fill).not.toHaveBeenCalled();
    }
  });

  test("puts no ETag on output that is not stored with the versioned lifetime", async () => {
    for (const response of [
      withHtmlCachePolicy(
        new Response("<p>Live</p>", { headers: { "content-type": "text/html" } }),
        "liveFallback",
      ),
      withoutResponseCaching(new Response("failed", { status: 503 })),
    ]) {
      const { call } = createCall({ fill: async () => response });
      expect((await serveVersionedEntrypoint(call)).headers.has("etag")).toBe(
        false,
      );
    }
  });
});

describe("build acceptance", () => {
  test("never accepts a previous build that is not configured", () => {
    expect(
      isAcceptedBuild({ requested: PREVIOUS, deployed: DEPLOYED, previous: null }, true),
    ).toBe(false);
    expect(
      isAcceptedBuild({ requested: DEPLOYED, deployed: null, previous: null }, false),
    ).toBe(false);
  });
});

describe("probe client", () => {
  test("adds the probe header to a copy of the canonical request", () => {
    const original = new Request("https://docs.example.com/guide", {
      headers: { accept: "text/html" },
    });
    const probe = withCacheProbe(original);
    expect(probe.headers.get(CACHE_PROBE_HEADER)).toBe("1");
    expect(probe.headers.get("accept")).toBe("text/html");
    expect(original.headers.has(CACHE_PROBE_HEADER)).toBe(false);
  });

  test("treats only a 200 without the marker as a hit", async () => {
    expect(
      (await probeCache(async () => new Response("cached"))).status,
    ).toBe("hit");
    for (const response of [
      new Response(null, { status: 204, headers: { [CACHE_PROBE_HEADER]: "miss" } }),
      new Response("bad", { status: 400 }),
      new Response("gone", { status: 404 }),
    ]) {
      expect((await probeCache(async () => response)).status).toBe("miss");
    }
    expect(
      (
        await probeCache(async () => {
          throw new Error("network");
        })
      ).status,
    ).toBe("miss");
  });

  test("retries a real call once after a marker, then gives up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const marker = () =>
      new Response(null, { status: 204, headers: { [CACHE_PROBE_HEADER]: "miss" } });
    const once = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(marker())
      .mockResolvedValueOnce(new Response("filled"));
    expect(await (await fetchWithoutProbeMarker("DocsHtmlCache", once))?.text()).toBe(
      "filled",
    );
    expect(once).toHaveBeenCalledTimes(2);

    const always = vi.fn(async () => marker());
    expect(await fetchWithoutProbeMarker("DocsHtmlCache", always)).toBeNull();
    expect(always).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toEqual({
      event: "docs_cache_probe_marker_received",
      entrypoint: "DocsHtmlCache",
      attempt: 2,
    });
    warn.mockRestore();
  });

  test("removes the marker from a response", () => {
    const response = withoutCacheProbeMarker(
      new Response(null, { status: 204, headers: { [CACHE_PROBE_HEADER]: "miss" } }),
    );
    expect(response.headers.has(CACHE_PROBE_HEADER)).toBe(false);
  });
});
