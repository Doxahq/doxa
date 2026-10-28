import { afterEach, describe, expect, test, vi } from "vitest";
import type { DocsDomainResolution } from "@doxahq/contracts";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import worker, { DocsHostCache } from "../src/index";

const HOST = "docs.example.com";
const current: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-2",
  artifactPrefix: "artifacts/v2",
  manifestPath: "artifacts/v2/manifest.json",
  accessPolicy: "public",
  hostname: HOST,
  domainKind: "custom_domain",
  renderTarget: "production",
};
const previous: DocsDomainResolution = {
  ...current,
  publishedVersionId: "version-1",
  artifactPrefix: "artifacts/v1",
  manifestPath: "artifacts/v1/manifest.json",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function kvWith(resolution: DocsDomainResolution | null) {
  return {
    get: vi.fn(async () =>
      resolution
        ? JSON.stringify({ format: 1, resolvedAt: Date.now(), resolution })
        : null,
    ),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function dispatch(input: {
  mode?: string;
  kv: ReturnType<typeof kvWith>;
  hostCache: DocsDomainResolution | null;
}) {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const hostFetch = vi.fn(async () =>
    Response.json(input.hostCache, { headers: { "cf-cache-status": "HIT" } }),
  );
  const htmlCache = vi.fn((_options: { props: { resolution: unknown } }) => ({
    fetch: async () =>
      new Response("cached html", { headers: { "cf-cache-status": "HIT" } }),
  }));
  const ctx = {
    exports: {
      DocsHostCache: () => ({ fetch: hostFetch }),
      DocsHtmlCache: htmlCache,
    },
  };
  const env = {
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOCS_HOSTNAME_MAP: input.kv,
    ...(input.mode ? { DOXA_PROD_KV_HOSTNAME_MODE: input.mode } : {}),
  };
  const response = worker.fetch(
    new Request(`https://${HOST}/guide`, { headers: { accept: "text/html" } }),
    env as never,
    ctx as never,
  );
  const logLine = () => JSON.parse(String(info.mock.calls.at(-1)?.[0]));
  return { response, hostFetch, htmlCache, logLine };
}

describe("hostname map in the dispatcher", () => {
  test("does not read the map by default", async () => {
    const kv = kvWith(current);
    const run = dispatch({ kv, hostCache: current });
    const response = await run.response;
    expect(kv.get).not.toHaveBeenCalled();
    expect(run.hostFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("x-doxa-host-source")).toBe("cache");
    expect(run.logLine()).toMatchObject({
      event: "docs_request_cache",
      cache: { host: "HIT", html: "HIT" },
      hostSource: "cache",
    });
    expect(run.logLine()).not.toHaveProperty("hostnameMap");
  });

  test("on: serves a map hit without the host cache or the resolver", async () => {
    const kv = kvWith(current);
    const run = dispatch({ mode: "on", kv, hostCache: previous });
    const response = await run.response;
    expect(await response.text()).toBe("cached html");
    expect(kv.get).toHaveBeenCalledWith(`host:${HOST}`);
    expect(run.hostFetch).not.toHaveBeenCalled();
    expect(run.htmlCache.mock.calls[0]?.[0].props.resolution).toEqual(current);
    expect(response.headers.get("x-doxa-host-cache")).toBe("BYPASS");
    expect(response.headers.get("x-doxa-host-source")).toBe("kv");
    expect(run.logLine()).toMatchObject({
      cache: { host: "BYPASS", html: "HIT" },
      hostSource: "kv",
      hostnameMap: { mode: "on", status: "hit" },
    });
  });

  test("on: falls back to the host cache on a map miss", async () => {
    const run = dispatch({ mode: "on", kv: kvWith(null), hostCache: current });
    await run.response;
    expect(run.hostFetch).toHaveBeenCalledOnce();
    expect(run.htmlCache.mock.calls[0]?.[0].props.resolution).toEqual(current);
    expect(run.logLine()).toMatchObject({
      hostSource: "cache",
      hostnameMap: { mode: "on", status: "miss" },
    });
  });

  test("shadow: serves the host cache answer and logs the disagreement", async () => {
    const run = dispatch({
      mode: "shadow",
      kv: kvWith(previous),
      hostCache: current,
    });
    await run.response;
    expect(run.htmlCache.mock.calls[0]?.[0].props.resolution).toEqual(current);
    expect(run.logLine()).toMatchObject({
      hostSource: "cache",
      hostnameMap: { mode: "shadow", status: "hit", agreement: "disagree" },
    });
  });
});

describe("DocsHostCache.syncHostnames", () => {
  const update = { hostname: HOST, resolvedAt: Date.now(), resolution: current };

  test("writes the map through the dispatcher's own binding", async () => {
    const kv = kvWith(null);
    const entrypoint = new DocsHostCache(
      {} as never,
      { DOCS_HOSTNAME_MAP: kv } as never,
    );
    await entrypoint.syncHostnames({
      updates: [update, { hostname: "old.example.com", resolvedAt: 1, resolution: null }],
    });
    expect(kv.put).toHaveBeenCalledWith(
      `host:${HOST}`,
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
    expect(kv.delete).toHaveBeenCalledWith("host:old.example.com");
  });

  test("does nothing before the namespace is bound", async () => {
    const entrypoint = new DocsHostCache({} as never, {} as never);
    await expect(
      entrypoint.syncHostnames({ updates: [update] }),
    ).resolves.toBeUndefined();
  });
});
