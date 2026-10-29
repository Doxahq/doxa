import { docsWarmStateKey } from "@doxahq/contracts/docs-warm-state";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  // The warm Durable Objects (M28) are exported from the same module.
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker from "../src/index";
import {
  parseFallbackWindowSeconds,
  parsePreviousFallbackMode,
  selectFallbackWindow,
} from "../src/previous-build-fallback";
import {
  createBuildIdentity,
  selectPublicCacheCalls,
  type PublicCacheCalls,
} from "../src/public-cache-calls";
import { CACHE_PROBE_HEADER } from "../src/versioned-entrypoint-protocol";
import {
  BUILD,
  PREVIOUS_BUILD,
  PREVIOUS_RELEASE,
  RELEASE,
  createSimulatedWorld,
  resolution,
  visitorRequest,
  type SimulatedWorld,
} from "./fixtures/simulated-cache";
import { createRouteData } from "./fixtures/route-data";

const ORIGIN = "https://docs.example.com";
const PAGE = `${ORIGIN}/guide`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function previousCalls(world: SimulatedWorld): Promise<PublicCacheCalls> {
  const calls = await selectPublicCacheCalls({
    hostname: resolution.hostname,
    origin: ORIGIN,
    pathname: "/guide",
    resolution,
    env: world.env,
    build: { buildId: PREVIOUS_BUILD, releaseId: PREVIOUS_RELEASE },
  });
  if (!calls) throw new Error("The previous-build calls are missing.");
  return calls;
}

async function liveCalls(world: SimulatedWorld): Promise<PublicCacheCalls> {
  const calls = await selectPublicCacheCalls({
    hostname: resolution.hostname,
    origin: ORIGIN,
    pathname: "/guide",
    resolution,
    env: world.env,
  });
  if (!calls) throw new Error("The live calls are missing.");
  return calls;
}

async function seedPreviousHtml(world: SimulatedWorld): Promise<void> {
  world.seed((await previousCalls(world)).html, "<p>Previous build</p>", "text/html");
}

function visit(world: SimulatedWorld, init: Parameters<typeof visitorRequest>[1] = {}) {
  return worker.fetch(
    visitorRequest(PAGE, {
      ...init,
      headers: { accept: "text/html", ...init.headers },
    }),
    world.env as never,
    world.ctx as never,
  );
}

function setWarmState(world: SimulatedWorld, releaseId: string, pools: object) {
  world.kv.set(
    docsWarmStateKey(resolution.siteId),
    JSON.stringify({ format: 1, releaseId, pools }),
  );
}

function probedBuilds(world: SimulatedWorld): string[] {
  return world.calls
    .filter((call) => call.probe)
    .map((call) => JSON.stringify(call.props));
}

function lastRequestLog(info: ReturnType<typeof vi.spyOn>) {
  return info.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((line) => line.event === "docs_request_cache")
    .at(-1);
}

describe("previous-build fallback settings", () => {
  test("parses the mode and fails closed with a warning", () => {
    const warn = vi.fn();
    expect(parsePreviousFallbackMode("on", warn)).toBe("on");
    expect(parsePreviousFallbackMode("shadow", warn)).toBe("shadow");
    expect(parsePreviousFallbackMode(undefined, warn)).toBe("off");
    expect(warn).not.toHaveBeenCalled();
    expect(parsePreviousFallbackMode("all", warn)).toBe("off");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("defaults the window to 24 hours and turns off on a bad value", () => {
    const warn = vi.fn();
    expect(parseFallbackWindowSeconds(undefined, warn)).toBe(86_400);
    expect(parseFallbackWindowSeconds("3600", warn)).toBe(3_600);
    expect(warn).not.toHaveBeenCalled();
    for (const value of ["0", "-1", "1.5", "abc", String(30 * 86_400)]) {
      expect(parseFallbackWindowSeconds(value, warn)).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["mode off", { DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off" }],
    ["no previous build", { DOXA_PREVIOUS_RENDERER_BUILD_ID: "" }],
    ["a malformed previous release", { DOXA_PREVIOUS_RENDERER_RELEASE_ID: "x" }],
    ["previous equal to the deployed build", { DOXA_PREVIOUS_RENDERER_BUILD_ID: BUILD }],
    ["no deploy time", { DOXA_RENDERER_DEPLOYED_AT: "" }],
    [
      "outside the window",
      { DOXA_RENDERER_DEPLOYED_AT: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    ],
    [
      "a deploy time in the future",
      { DOXA_RENDERER_DEPLOYED_AT: new Date(Date.now() + 3_600_000).toISOString() },
    ],
    ["warm rollout off", { DOXA_PROD_WARM_MODE: "off" }],
    [
      "a site outside the warm allowlist",
      { DOXA_PROD_WARM_MODE: "allowlist", DOXA_PROD_WARM_SITE_IDS: "site-2" },
    ],
  ])("never applies with %s", (_name, overrides) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = createSimulatedWorld(overrides);
    expect(selectFallbackWindow(world.env, resolution, Date.now())).toBeNull();
  });

  test("never applies to a private site", () => {
    const world = createSimulatedWorld();
    expect(
      selectFallbackWindow(
        world.env,
        { ...resolution, accessPolicy: "authenticated" },
        Date.now(),
      ),
    ).toBeNull();
  });
});

describe("previous-build fallback for HTML", () => {
  test("serves the previous build in a cold pool without rendering", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);

    const response = await visit(world);

    expect(await response.text()).toBe("<p>Previous build</p>");
    expect(response.headers.get("x-doxa-html-cache")).toBe("PREVIOUS");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has(CACHE_PROBE_HEADER)).toBe(false);
    expect(world.render).not.toHaveBeenCalled();
    // Only the previous build's key was probed; the live key was not touched.
    expect(world.calls).toEqual([
      expect.objectContaining({
        entrypoint: "DocsHtmlCache",
        probe: true,
        status: "HIT",
        props: expect.objectContaining({ rendererBuildId: PREVIOUS_BUILD }),
      }),
    ]);
    expect(lastRequestLog(info)).toMatchObject({
      cache: { html: "PREVIOUS" },
      fallback: {
        mode: "on",
        used: true,
        pool: "eu-west",
        warmState: "missing",
        probe: "hit",
        probeMs: expect.any(Number),
      },
    });
  });

  test("embeds the previous identity, so its route data matches (F15)", async () => {
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);
    await visit(world);
    const previousIdentity = await createBuildIdentity(
      resolution,
      PREVIOUS_RELEASE,
      ORIGIN,
    );
    expect(world.calls[0]?.props).toMatchObject({
      deliveryRenderId: previousIdentity?.renderId,
    });
  });

  test("takes today's path without any probe when the pool is warm", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);
    setWarmState(world, RELEASE, { "eu-west": Date.now() });

    const response = await visit(world);

    expect(await response.text()).toBe("<p>Live build</p>");
    expect(response.headers.get("x-doxa-html-cache")).toBe("MISS");
    expect(probedBuilds(world)).toEqual([]);
    expect(world.calls).toEqual([
      expect.objectContaining({
        probe: false,
        props: expect.objectContaining({ rendererBuildId: BUILD }),
      }),
    ]);
  });

  test.each([
    ["another pool is warm", RELEASE, { "us-east": 1 }],
    ["the record is for the previous release", PREVIOUS_RELEASE, { "eu-west": 1 }],
  ])("probes the previous build when %s", async (_name, releaseId, pools) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);
    setWarmState(world, releaseId, pools);
    const response = await visit(world);
    expect(response.headers.get("x-doxa-html-cache")).toBe("PREVIOUS");
  });

  test("treats a malformed warm record as not warm", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);
    world.kv.set(docsWarmStateKey(resolution.siteId), "{not json");
    expect((await visit(world)).headers.get("x-doxa-html-cache")).toBe("PREVIOUS");
  });

  test("renders live after a previous-build miss and fills only the live key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();

    const response = await visit(world);

    expect(await response.text()).toBe("<p>Live build</p>");
    expect(response.headers.get("x-doxa-html-cache")).toBe("MISS");
    expect(world.calls.map(({ probe, status, props }) => ({
      probe,
      status,
      build: (props as { rendererBuildId: string }).rendererBuildId,
    }))).toEqual([
      { probe: true, status: "MISS", build: PREVIOUS_BUILD },
      { probe: false, status: "MISS", build: BUILD },
    ]);
    // The probe miss stored nothing, and never rendered.
    expect(world.has((await previousCalls(world)).html)).toBe(false);
    expect(world.render).toHaveBeenCalledOnce();
    expect(world.has((await liveCalls(world)).html)).toBe(true);
  });

  test("shadow mode serves today's path and logs what it would serve", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld({ DOXA_PROD_PREVIOUS_FALLBACK_MODE: "shadow" });
    await seedPreviousHtml(world);

    const response = await visit(world);
    await Promise.all(world.backgroundTasks);

    expect(await response.text()).toBe("<p>Live build</p>");
    const shadow = info.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .find((line) => line.event === "docs_request_cache_fallback");
    expect(shadow).toMatchObject({
      hostname: "docs.example.com",
      path: "/guide",
      mode: "shadow",
      pool: "eu-west",
      probe: "hit",
      wouldServe: true,
    });
    expect(lastRequestLog(info)).toMatchObject({
      fallback: { mode: "shadow", used: false },
    });
  });

  test.each<[string, Parameters<typeof visitorRequest>[1]]>([
    ["a HEAD request", { method: "HEAD" }],
    ["an unknown pool", { cf: { colo: "BOM", country: "IN", continent: "AS" } }],
    ["no location", { cf: {} }],
    ["a request with a query", {}],
  ])("never probes for %s", async (name, init) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    await seedPreviousHtml(world);
    const url = name === "a request with a query" ? `${PAGE}?q=1` : PAGE;
    await worker.fetch(
      visitorRequest(url, { ...init, headers: { accept: "text/html" } }),
      world.env as never,
      world.ctx as never,
    );
    expect(probedBuilds(world)).toEqual([]);
  });

  test("never serves a previous build to a preview host", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    const preview = { ...resolution, renderTarget: "preview" as const };
    world.env.DOCS_RESOLVER = {
      fetch: vi.fn(async () => Response.json({ resolution: preview })),
    };
    await visit(world);
    expect(probedBuilds(world)).toEqual([]);
  });

  test("renders without the cache when a real call gets the probe marker twice", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = createSimulatedWorld({ DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off" });
    world.ctx.exports.DocsHtmlCache = vi.fn(() => ({
      fetch: async () =>
        new Response(null, {
          status: 204,
          headers: { [CACHE_PROBE_HEADER]: "miss", "cache-control": "private, no-store" },
        }),
    }));

    const response = await visit(world);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>Live build</p>");
    expect(response.headers.has(CACHE_PROBE_HEADER)).toBe(false);
    expect(world.ctx.exports.DocsHtmlCache).toHaveBeenCalledTimes(2);
  });
});

describe("previous-build fallback for saved output (M36)", () => {
  const m36 = { DOXA_PROD_PRERENDER_MODE: "all" };

  test("probes the previous saved output only after a real 404 (F16)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld(m36);
    const previous = await previousCalls(world);
    expect(previous.html.entrypoint).toBe("DocsPrerenderCache");
    world.seed(previous.html, "<p>Previous saved</p>", "text/html; charset=utf-8");

    const response = await visit(world);

    expect(await response.text()).toBe("<p>Previous saved</p>");
    expect(response.headers.get("x-doxa-html-cache")).toBe("PREVIOUS");
    expect(world.calls.map(({ entrypoint, probe, props }) => ({
      entrypoint,
      probe,
      release: (props as { expected: { rendererReleaseId: string } }).expected
        .rendererReleaseId,
    }))).toEqual([
      { entrypoint: "DocsPrerenderCache", probe: false, release: RELEASE },
      { entrypoint: "DocsPrerenderCache", probe: true, release: PREVIOUS_RELEASE },
    ]);
    // The probe of the previous release never read R2.
    const previousIdentity = await createBuildIdentity(resolution, PREVIOUS_RELEASE, ORIGIN);
    expect(
      world.bucket.get.mock.calls.some(([key]) =>
        key.includes(previousIdentity?.renderId ?? "none"),
      ),
    ).toBe(false);
  });

  test("falls back to the live HTML cache after a previous saved-output miss", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld(m36);
    const response = await visit(world);
    expect(await response.text()).toBe("<p>Live build</p>");
    expect(world.calls.at(-1)).toMatchObject({
      entrypoint: "DocsHtmlCache",
      probe: false,
      props: { lifetime: "liveFallback", rendererBuildId: BUILD },
    });
    // One probe only: the live fallback does not probe again.
    expect(world.calls.filter((call) => call.probe)).toHaveLength(1);
  });
});

describe("previous-build route data (D8)", () => {
  async function fetchRouteData(world: SimulatedWorld, render: string) {
    const search = new URLSearchParams({ path: "/guide", render });
    return worker.fetch(
      visitorRequest(`${ORIGIN}/_doxa/route-data/v1?${search}`, {
        headers: { accept: "application/json" },
      }),
      world.env as never,
      world.ctx as never,
    );
  }

  async function previousRenderId(): Promise<string> {
    const identity = await createBuildIdentity(resolution, PREVIOUS_RELEASE, ORIGIN);
    if (!identity) throw new Error("No previous identity.");
    return identity.renderId;
  }

  test.each([
    ["live route-data cache", {}],
    ["saved output", { DOXA_PROD_PRERENDER_MODE: "all" }],
  ])("serves the previous entry with its own identity from the %s", async (_name, overrides) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld(overrides);
    const data = (await previousCalls(world)).data;
    if (!data) throw new Error("No data call.");
    world.seed(data, JSON.stringify(createRouteData()), "application/json");

    const response = await fetchRouteData(world, await previousRenderId());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      schemaVersion: 1,
      renderId: await previousRenderId(),
      data: createRouteData(),
    });
    expect(response.headers.get("x-doxa-route-data-cache")).toBe("PREVIOUS");
    expect(world.calls).toEqual([expect.objectContaining({ probe: true, status: "HIT" })]);
    expect(world.prepare).not.toHaveBeenCalled();
  });

  test("answers 409 after a previous-build miss, without preparing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    const response = await fetchRouteData(world, await previousRenderId());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "version_mismatch" });
    expect(world.prepare).not.toHaveBeenCalled();
    expect(world.calls).toEqual([expect.objectContaining({ probe: true, status: "MISS" })]);
  });

  test.each<[string, Record<string, string>]>([
    ["outside the window", { DOXA_RENDERER_DEPLOYED_AT: new Date(Date.now() - 2 * 86_400_000).toISOString() }],
    ["mode off", { DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off" }],
    ["shadow mode", { DOXA_PROD_PREVIOUS_FALLBACK_MODE: "shadow" }],
  ])("answers 409 %s", async (_name, overrides) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld(overrides);
    const data = (await previousCalls(world)).data;
    if (!data) throw new Error("No data call.");
    world.seed(data, JSON.stringify(createRouteData()), "application/json");
    expect((await fetchRouteData(world, await previousRenderId())).status).toBe(409);
  });

  test("never probes for an unknown render hint", async () => {
    const world = createSimulatedWorld();
    const response = await fetchRouteData(world, "f".repeat(64));
    expect(response.status).toBe(409);
    expect(world.calls).toEqual([]);
  });
});
