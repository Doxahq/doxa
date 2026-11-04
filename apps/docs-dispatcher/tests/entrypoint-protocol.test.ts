import { describe, expect, test, vi } from "vitest";

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

import { DocsHtmlCache, DocsRouteDataCache } from "../src/index";
import { DocsPrerenderCache } from "../src/prerender-cache-entrypoint";
import {
  readPreviousRendererBuild,
  readRendererDeployedAt,
} from "../src/previous-renderer-build";
import {
  createIdentityEtag,
  CACHE_PROBE_HEADER,
} from "../src/versioned-entrypoint-protocol";
import { selectPublicCacheCalls } from "../src/public-cache-calls";
import {
  BUILD,
  PREVIOUS_BUILD,
  PREVIOUS_RELEASE,
  RELEASE,
  createSimulatedWorld,
  resolution,
  type SimulatedWorld,
} from "./fixtures/simulated-cache";

const ORIGIN = "https://docs.example.com";

async function callsFor(
  world: SimulatedWorld,
  build: { buildId: string; releaseId: string } = { buildId: BUILD, releaseId: RELEASE },
) {
  const calls = await selectPublicCacheCalls({
    hostname: resolution.hostname,
    origin: ORIGIN,
    pathname: "/guide",
    resolution,
    env: world.env,
    build,
  });
  if (!calls?.data) throw new Error("Missing calls.");
  return { html: calls.html, data: calls.data };
}

function entrypointContext(world: SimulatedWorld, props: unknown) {
  return { props, exports: world.ctx.exports, waitUntil: world.ctx.waitUntil };
}

function withHeaders(request: Request, headers: Record<string, string>): Request {
  const merged = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Request(request.url, { method: request.method, headers: merged });
}

const PREVIOUS = { buildId: PREVIOUS_BUILD, releaseId: PREVIOUS_RELEASE };

describe("DocsHtmlCache protocol", () => {
  async function htmlCache(world: SimulatedWorld, build?: typeof PREVIOUS) {
    const { html } = await callsFor(world, build);
    if (html.entrypoint !== "DocsHtmlCache") throw new Error("Wrong entrypoint.");
    return {
      call: html,
      entrypoint: new DocsHtmlCache(
        entrypointContext(world, html.props) as never,
        world.env as never,
      ),
    };
  }

  test("stores a render with the identity ETag", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = createSimulatedWorld();
    const { call, entrypoint } = await htmlCache(world);
    const response = await entrypoint.fetch(call.request);
    expect(response.headers.get("etag")).toBe(
      await createIdentityEtag("DocsHtmlCache", call.props),
    );
    expect(world.render).toHaveBeenCalledOnce();
  });

  test("confirms a stored entry with 304 without rendering", async () => {
    const world = createSimulatedWorld();
    const { call, entrypoint } = await htmlCache(world);
    const etag = await createIdentityEtag("DocsHtmlCache", call.props);
    const response = await entrypoint.fetch(
      withHeaders(call.request, { "if-none-match": etag }),
    );
    expect(response.status).toBe(304);
    expect(world.render).not.toHaveBeenCalled();
  });

  test("answers a probe miss without rendering", async () => {
    const world = createSimulatedWorld();
    const { call, entrypoint } = await htmlCache(world);
    const response = await entrypoint.fetch(
      withHeaders(call.request, { [CACHE_PROBE_HEADER]: "1" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get(CACHE_PROBE_HEADER)).toBe("miss");
    expect(world.render).not.toHaveBeenCalled();
  });

  test("never renders the deployed build under the previous build's key", async () => {
    const world = createSimulatedWorld();
    const { call, entrypoint } = await htmlCache(world, PREVIOUS);
    expect((await entrypoint.fetch(call.request)).status).toBe(400);
    expect(
      (await entrypoint.fetch(withHeaders(call.request, { [CACHE_PROBE_HEADER]: "1" })))
        .status,
    ).toBe(204);
    expect(world.render).not.toHaveBeenCalled();
  });
});

describe("DocsRouteDataCache protocol (F14)", () => {
  async function routeDataCache(world: SimulatedWorld, build?: typeof PREVIOUS) {
    const { data } = await callsFor(world, build);
    if (data.entrypoint !== "DocsRouteDataCache") throw new Error("Wrong entrypoint.");
    return {
      call: data,
      entrypoint: new DocsRouteDataCache(
        entrypointContext(world, data.props) as never,
        world.env as never,
      ),
    };
  }

  test("stores live route data with the identity ETag", async () => {
    const world = createSimulatedWorld();
    const { call, entrypoint } = await routeDataCache(world);
    const response = await entrypoint.fetch(call.request);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(
      await createIdentityEtag("DocsRouteDataCache", call.props),
    );
  });

  test("rejects a real call of the previous release and answers its probe", async () => {
    const world = createSimulatedWorld();
    const { call, entrypoint } = await routeDataCache(world, PREVIOUS);
    expect((await entrypoint.fetch(call.request)).status).toBe(400);
    expect(
      (await entrypoint.fetch(withHeaders(call.request, { [CACHE_PROBE_HEADER]: "1" })))
        .status,
    ).toBe(204);
    expect(world.prepare).not.toHaveBeenCalled();
  });

  test("rejects a previous-release probe when no previous build is configured", async () => {
    const world = createSimulatedWorld({ DOXA_PREVIOUS_RENDERER_RELEASE_ID: "" });
    const { call, entrypoint } = await routeDataCache(world, PREVIOUS);
    expect(
      (await entrypoint.fetch(withHeaders(call.request, { [CACHE_PROBE_HEADER]: "1" })))
        .status,
    ).toBe(400);
  });
});

describe("DocsPrerenderCache protocol", () => {
  const m36 = { DOXA_PROD_PRERENDER_MODE: "all" };

  async function prerenderCache(world: SimulatedWorld, build?: typeof PREVIOUS) {
    const { html, data } = await callsFor(world, build);
    if (html.entrypoint !== "DocsPrerenderCache" || data.entrypoint !== "DocsPrerenderCache") {
      throw new Error("Wrong entrypoint.");
    }
    const create = (props: unknown) =>
      new DocsPrerenderCache(entrypointContext(world, props) as never, world.env as never);
    return { html, data, create };
  }

  test("answers a probe miss without reading R2", async () => {
    const world = createSimulatedWorld(m36);
    for (const build of [undefined, PREVIOUS]) {
      const { html, data, create } = await prerenderCache(world, build);
      for (const call of [html, data]) {
        const response = await create(call.props).fetch(
          withHeaders(call.request, { [CACHE_PROBE_HEADER]: "1" }),
        );
        expect(response.status).toBe(204);
      }
    }
    expect(world.bucket.get).not.toHaveBeenCalled();
    expect(world.prepare).not.toHaveBeenCalled();
  });

  test("rejects a real call of the previous release", async () => {
    const world = createSimulatedWorld(m36);
    const { html, create } = await prerenderCache(world, PREVIOUS);
    expect((await create(html.props).fetch(html.request)).status).toBe(400);
    expect(world.bucket.get).not.toHaveBeenCalled();
  });

  test("puts no ETag on the 30-second live route-data fallback", async () => {
    const world = createSimulatedWorld(m36);
    const { data, create } = await prerenderCache(world);
    const response = await create(data.props).fetch(data.request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=30");
    expect(response.headers.has("etag")).toBe(false);
  });

  test("confirms a stored entry with 304 without reading R2", async () => {
    const world = createSimulatedWorld(m36);
    const { html, create } = await prerenderCache(world);
    const etag = await createIdentityEtag("DocsPrerenderCache", html.props);
    const response = await create(html.props).fetch(
      withHeaders(html.request, { "if-none-match": etag }),
    );
    expect(response.status).toBe(304);
    expect(world.bucket.get).not.toHaveBeenCalled();
  });
});

describe("probe-started revalidation (F39, FS-L2)", () => {
  const m36 = { DOXA_PROD_PRERENDER_MODE: "all" };

  async function revalidate(
    entrypointName: "DocsHtmlCache" | "DocsRouteDataCache" | "DocsPrerenderCache",
    world: SimulatedWorld,
    call: { props: unknown; request: Request },
  ): Promise<Response> {
    const etag = await createIdentityEtag(entrypointName, call.props);
    const request = withHeaders(call.request, {
      "if-none-match": etag,
      [CACHE_PROBE_HEADER]: "1",
    });
    const context = entrypointContext(world, call.props) as never;
    const env = world.env as never;
    switch (entrypointName) {
      case "DocsHtmlCache":
        return new DocsHtmlCache(context, env).fetch(request);
      case "DocsRouteDataCache":
        return new DocsRouteDataCache(context, env).fetch(request);
      case "DocsPrerenderCache":
        return new DocsPrerenderCache(context, env).fetch(request);
    }
  }

  test("passes the trust check and gets 304 for each previous-build key", async () => {
    const world = createSimulatedWorld();
    const { html, data } = await callsFor(world, PREVIOUS);
    expect((await revalidate("DocsHtmlCache", world, html)).status).toBe(304);
    expect((await revalidate("DocsRouteDataCache", world, data)).status).toBe(304);

    const prerenderWorld = createSimulatedWorld(m36);
    const saved = await callsFor(prerenderWorld, PREVIOUS);
    for (const call of [saved.html, saved.data]) {
      expect((await revalidate("DocsPrerenderCache", prerenderWorld, call)).status).toBe(304);
    }
    expect(world.render).not.toHaveBeenCalled();
    expect(prerenderWorld.bucket.get).not.toHaveBeenCalled();
  });
});

describe("canonical cache requests (FS-L2)", () => {
  test("never carry an If-None-Match", async () => {
    for (const env of [{}, { DOXA_PROD_PRERENDER_MODE: "all" }]) {
      const world = createSimulatedWorld(env);
      for (const build of [undefined, PREVIOUS]) {
        const { html, data } = await callsFor(world, build);
        for (const call of [html, data]) {
          expect(call.request.headers.has("if-none-match")).toBe(false);
        }
      }
    }
  });
});

describe("renderer build vars", () => {
  test("reads a valid previous build", () => {
    expect(
      readPreviousRendererBuild({
        DOXA_RENDERER_BUILD_ID: BUILD,
        DOXA_RENDERER_RELEASE_ID: RELEASE,
        DOXA_PREVIOUS_RENDERER_BUILD_ID: PREVIOUS_BUILD,
        DOXA_PREVIOUS_RENDERER_RELEASE_ID: PREVIOUS_RELEASE,
      }),
    ).toEqual(PREVIOUS);
  });

  test.each([
    ["empty values", { DOXA_PREVIOUS_RENDERER_BUILD_ID: "", DOXA_PREVIOUS_RENDERER_RELEASE_ID: "" }],
    ["only a build", { DOXA_PREVIOUS_RENDERER_RELEASE_ID: "" }],
    ["a short ID", { DOXA_PREVIOUS_RENDERER_BUILD_ID: "abc" }],
    ["the deployed build", { DOXA_PREVIOUS_RENDERER_BUILD_ID: BUILD }],
    ["the deployed release", { DOXA_PREVIOUS_RENDERER_RELEASE_ID: RELEASE }],
  ])("ignores %s", (_name, change) => {
    expect(
      readPreviousRendererBuild({
        DOXA_RENDERER_BUILD_ID: BUILD,
        DOXA_RENDERER_RELEASE_ID: RELEASE,
        DOXA_PREVIOUS_RENDERER_BUILD_ID: PREVIOUS_BUILD,
        DOXA_PREVIOUS_RENDERER_RELEASE_ID: PREVIOUS_RELEASE,
        ...change,
      }),
    ).toBeNull();
  });

  test("parses the deploy time", () => {
    expect(
      readRendererDeployedAt({ DOXA_RENDERER_DEPLOYED_AT: "2026-10-29T12:00:00.000Z" }),
    ).toBe(Date.UTC(2026, 9, 29, 12));
    expect(readRendererDeployedAt({ DOXA_RENDERER_DEPLOYED_AT: "soon" })).toBeNull();
    expect(readRendererDeployedAt({})).toBeNull();
  });
});
