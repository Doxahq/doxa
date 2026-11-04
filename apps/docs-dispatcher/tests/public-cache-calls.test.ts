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
  selectPublicCacheCalls,
  type PublicCacheCall,
} from "../src/public-cache-calls";
import {
  PREVIOUS_BUILD,
  PREVIOUS_RELEASE,
  createSimulatedWorld,
  resolution,
  visitorRequest,
  type CacheCallRecord,
  type SimulatedWorld,
} from "./fixtures/simulated-cache";

/**
 * GOLDEN CACHE-KEY SNAPSHOT (F17). Every content-cache props shape and
 * canonical request is frozen here. A change silently empties the cache and
 * disables the previous-build fallback for one deploy (the previous build's
 * entries use the old shape). Change a snapshot only on purpose, and note it
 * in the deploy plan.
 */

const ORIGIN = "https://docs.example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

function describeCall(call: PublicCacheCall) {
  return {
    entrypoint: call.entrypoint,
    props: call.props,
    url: call.request.url,
    method: call.request.method,
    headers: Object.fromEntries(call.request.headers),
  };
}

function describeRecord(record: CacheCallRecord) {
  return {
    entrypoint: record.entrypoint,
    props: record.props,
    url: record.url,
    method: record.method,
    headers: record.headers,
  };
}

async function builderCalls(
  world: SimulatedWorld,
  build?: { buildId: string; releaseId: string },
) {
  const calls = await selectPublicCacheCalls({
    hostname: resolution.hostname,
    origin: ORIGIN,
    pathname: "/guide",
    resolution,
    env: world.env,
    ...(build ? { build } : {}),
  });
  if (!calls) throw new Error("No calls.");
  return calls;
}

async function visitPage(world: SimulatedWorld) {
  await worker.fetch(
    visitorRequest(`${ORIGIN}/guide`, { headers: { accept: "text/html" } }),
    world.env as never,
    world.ctx as never,
  );
}

async function visitRouteData(world: SimulatedWorld) {
  await worker.fetch(
    visitorRequest(`${ORIGIN}/_doxa/route-data/v1?path=%2Fguide`, {
      headers: { accept: "application/json" },
    }),
    world.env as never,
    world.ctx as never,
  );
}

const visitorOnly = { DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off" };

describe("public cache calls: visitor path equals the shared builder", () => {
  test("HTML and live route data of a site without saved output", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld(visitorOnly);
    await visitPage(world);
    await visitRouteData(world);
    const calls = await builderCalls(world);
    if (!calls.data) throw new Error("No data call.");

    expect(world.calls.map(describeRecord)).toEqual([
      describeCall(calls.html),
      describeCall(calls.data),
    ]);
    expect(describeCall(calls.html)).toMatchInlineSnapshot(`
      {
        "entrypoint": "DocsHtmlCache",
        "headers": {
          "accept": "text/html",
          "x-doxa-internal-render-id": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
        },
        "method": "GET",
        "props": {
          "deliveryRenderId": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
          "hostname": "docs.example.com",
          "lifetime": "versioned",
          "rendererBuildId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "resolution": {
            "accessPolicy": "public",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "domainKind": "custom_domain",
            "hostname": "docs.example.com",
            "manifestPath": "sites/site-1/versions/source-1/manifest.json",
            "projectId": "project-1",
            "projectSlug": "demo",
            "publishedVersionId": "version-1",
            "renderTarget": "production",
            "siteId": "site-1",
          },
        },
        "url": "https://docs.example.com/guide",
      }
    `);
    expect(describeCall(calls.data)).toMatchInlineSnapshot(`
      {
        "entrypoint": "DocsRouteDataCache",
        "headers": {
          "accept": "application/json",
        },
        "method": "GET",
        "props": {
          "expected": {
            "artifactIdentity": "6a922708ff178a07b321b5b46a939d57908e331fdafa4e3fe8f3c2d99e7b5067",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "renderContextId": "fdc5a3884f319988a147940e583ed20b01c6310720a79368c669bd038227de4e",
            "renderId": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
            "rendererReleaseId": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "siteId": "site-1",
            "sourceArtifactVersion": "source-1",
            "sourceManifestPath": "sites/site-1/versions/source-1/manifest.json",
            "trustedRequestOrigin": "https://docs.example.com",
          },
          "hostname": "docs.example.com",
          "pathname": "/guide",
          "resolution": {
            "accessPolicy": "public",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "domainKind": "custom_domain",
            "hostname": "docs.example.com",
            "manifestPath": "sites/site-1/versions/source-1/manifest.json",
            "projectId": "project-1",
            "projectSlug": "demo",
            "publishedVersionId": "version-1",
            "renderTarget": "production",
            "siteId": "site-1",
          },
        },
        "url": "https://docs.example.com/_doxa/route-data/v1/guide",
      }
    `);
  });

  test("saved HTML and saved route data of an M36 site", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld({
      ...visitorOnly,
      DOXA_PROD_PRERENDER_MODE: "all",
    });
    await visitPage(world);
    await visitRouteData(world);
    const calls = await builderCalls(world);
    if (!calls.data) throw new Error("No data call.");

    const [savedHtml, liveFallback, savedData] = world.calls.map(describeRecord);
    expect(savedHtml).toEqual(describeCall(calls.html));
    expect(savedData).toEqual(describeCall(calls.data));
    expect(describeCall(calls.html)).toMatchInlineSnapshot(`
      {
        "entrypoint": "DocsPrerenderCache",
        "headers": {
          "accept": "text/html",
        },
        "method": "GET",
        "props": {
          "expected": {
            "artifactIdentity": "6a922708ff178a07b321b5b46a939d57908e331fdafa4e3fe8f3c2d99e7b5067",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "renderContextId": "fdc5a3884f319988a147940e583ed20b01c6310720a79368c669bd038227de4e",
            "renderId": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
            "rendererReleaseId": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "siteId": "site-1",
            "sourceArtifactVersion": "source-1",
            "sourceManifestPath": "sites/site-1/versions/source-1/manifest.json",
            "trustedRequestOrigin": "https://docs.example.com",
          },
          "featureMode": "all",
          "hostname": "docs.example.com",
          "pathname": "/guide",
          "representation": "html",
          "resolution": {
            "accessPolicy": "public",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "domainKind": "custom_domain",
            "hostname": "docs.example.com",
            "manifestPath": "sites/site-1/versions/source-1/manifest.json",
            "projectId": "project-1",
            "projectSlug": "demo",
            "publishedVersionId": "version-1",
            "renderTarget": "production",
            "siteId": "site-1",
          },
        },
        "url": "https://docs.example.com/guide",
      }
    `);
    expect(describeCall(calls.data)).toMatchInlineSnapshot(`
      {
        "entrypoint": "DocsPrerenderCache",
        "headers": {
          "accept": "application/json",
        },
        "method": "GET",
        "props": {
          "expected": {
            "artifactIdentity": "6a922708ff178a07b321b5b46a939d57908e331fdafa4e3fe8f3c2d99e7b5067",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "renderContextId": "fdc5a3884f319988a147940e583ed20b01c6310720a79368c669bd038227de4e",
            "renderId": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
            "rendererReleaseId": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "siteId": "site-1",
            "sourceArtifactVersion": "source-1",
            "sourceManifestPath": "sites/site-1/versions/source-1/manifest.json",
            "trustedRequestOrigin": "https://docs.example.com",
          },
          "featureMode": "all",
          "hostname": "docs.example.com",
          "pathname": "/guide",
          "representation": "data",
          "resolution": {
            "accessPolicy": "public",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "domainKind": "custom_domain",
            "hostname": "docs.example.com",
            "manifestPath": "sites/site-1/versions/source-1/manifest.json",
            "projectId": "project-1",
            "projectSlug": "demo",
            "publishedVersionId": "version-1",
            "renderTarget": "production",
            "siteId": "site-1",
          },
        },
        "url": "https://docs.example.com/_doxa/route-data/v1/guide",
      }
    `);
    // The 30-second live fallback after a saved-output miss.
    expect(liveFallback).toMatchInlineSnapshot(`
      {
        "entrypoint": "DocsHtmlCache",
        "headers": {
          "accept": "text/html",
          "x-doxa-internal-render-id": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
        },
        "method": "GET",
        "props": {
          "deliveryRenderId": "438b8f0caf6ca8523863c92d5bb175d758e8dae4595ea22cd27848313663118b",
          "hostname": "docs.example.com",
          "lifetime": "liveFallback",
          "rendererBuildId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "resolution": {
            "accessPolicy": "public",
            "artifactPrefix": "sites/site-1/versions/source-1",
            "domainKind": "custom_domain",
            "hostname": "docs.example.com",
            "manifestPath": "sites/site-1/versions/source-1/manifest.json",
            "projectId": "project-1",
            "projectSlug": "demo",
            "publishedVersionId": "version-1",
            "renderTarget": "production",
            "siteId": "site-1",
          },
        },
        "url": "https://docs.example.com/guide",
      }
    `);
  });

  test("HTML of a site without any route-data delivery", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld({
      ...visitorOnly,
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: "off",
    });
    await visitPage(world);
    const calls = await builderCalls(world);

    expect(calls.data).toBeNull();
    expect(world.calls.map(describeRecord)).toEqual([describeCall(calls.html)]);
    expect(describeCall(calls.html).props).toMatchObject({
      deliveryRenderId: null,
    });
    expect(describeCall(calls.html).headers).toEqual({ accept: "text/html" });
  });
});

describe("public cache call props key order", () => {
  // Snapshots sort keys; the cache may key on the serialized order, so the
  // order is frozen too.
  test("keeps the order of every props shape", async () => {
    const live = await builderCalls(createSimulatedWorld(visitorOnly));
    const saved = await builderCalls(
      createSimulatedWorld({ ...visitorOnly, DOXA_PROD_PRERENDER_MODE: "all" }),
    );
    expect(Object.keys(live.html.props)).toEqual([
      "hostname",
      "rendererBuildId",
      "resolution",
      "lifetime",
      "deliveryRenderId",
    ]);
    expect(Object.keys(live.data?.props ?? {})).toEqual([
      "expected",
      "hostname",
      "pathname",
      "resolution",
    ]);
    for (const call of [saved.html, saved.data]) {
      expect(Object.keys(call?.props ?? {})).toEqual([
        "expected",
        "featureMode",
        "hostname",
        "pathname",
        "representation",
        "resolution",
      ]);
    }
  });
});

describe("public cache calls for the previous build", () => {
  test("differ from the live calls only in the build and its identity", async () => {
    const world = createSimulatedWorld(visitorOnly);
    const live = await builderCalls(world);
    const previous = await builderCalls(world, {
      buildId: PREVIOUS_BUILD,
      releaseId: PREVIOUS_RELEASE,
    });
    if (!live.data || !previous.data || !previous.identity || !live.identity) {
      throw new Error("Missing calls.");
    }
    expect(previous.html.props).toEqual({
      ...live.html.props,
      rendererBuildId: PREVIOUS_BUILD,
      deliveryRenderId: previous.identity.renderId,
    });
    expect(previous.identity.rendererReleaseId).toBe(PREVIOUS_RELEASE);
    expect(previous.identity.renderId).not.toBe(live.identity.renderId);
    expect(previous.data.request.url).toBe(live.data.request.url);
  });
});

describe("public cache call inputs", () => {
  test.each([
    ["a private site", { resolution: { ...resolution, accessPolicy: "authenticated" as const } }],
    ["another hostname", { hostname: "other.example.com" }],
    ["an http origin", { origin: "http://docs.example.com" }],
    ["an origin with a path", { origin: "https://docs.example.com/x" }],
  ])("returns null for %s", async (_name, change) => {
    const world = createSimulatedWorld(visitorOnly);
    expect(
      await selectPublicCacheCalls({
        hostname: resolution.hostname,
        origin: ORIGIN,
        pathname: "/guide",
        resolution,
        env: world.env,
        ...change,
      }),
    ).toBeNull();
  });

  test("returns null without a deployed build", async () => {
    const world = createSimulatedWorld({
      ...visitorOnly,
      DOXA_RENDERER_BUILD_ID: undefined,
    });
    expect(
      await selectPublicCacheCalls({
        hostname: resolution.hostname,
        origin: ORIGIN,
        pathname: "/guide",
        resolution,
        env: world.env,
      }),
    ).toBeNull();
  });
});
