import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import worker from "../../src/index";
import type { PublicCacheCall } from "../../src/public-cache-calls";
import {
  fillCacheCall,
  isCacheCallStored,
  selectWarmCalls,
  type WarmCacheExports,
} from "../../src/warm/warm-fill";
import { CACHE_PROBE_HEADER } from "../../src/versioned-entrypoint-protocol";
import {
  createSimulatedWorld,
  resolution,
  visitorRequest,
  type CacheCallRecord,
  type SimulatedWorld,
} from "../fixtures/simulated-cache";

/**
 * GOLDEN (F5, F17): the regional warmer must fill exactly the keys that
 * visitors read: the same entrypoint, props and canonical request, for M36
 * sites (two `DocsPrerenderCache` calls) and for other sites (versioned
 * `DocsHtmlCache` and `DocsRouteDataCache`).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const visitorOnly = { DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off" };
const target = { hostname: resolution.hostname, resolution, resolvedAt: 1 };

function describeRecord(record: CacheCallRecord) {
  return {
    entrypoint: record.entrypoint,
    props: record.props,
    url: record.url,
    method: record.method,
    headers: record.headers,
  };
}

async function visit(world: SimulatedWorld) {
  await worker.fetch(
    visitorRequest(`https://${resolution.hostname}/guide`, { headers: { accept: "text/html" } }),
    world.env as never,
    world.ctx as never,
  );
  await worker.fetch(
    visitorRequest(`https://${resolution.hostname}/_doxa/route-data/v1?path=%2Fguide`, {
      headers: { accept: "application/json" },
    }),
    world.env as never,
    world.ctx as never,
  );
}

async function warm(world: SimulatedWorld) {
  const calls = await selectWarmCalls({ target, pathname: "/guide", env: world.env });
  if (!calls?.data) throw new Error("No warm calls.");
  const exports = world.ctx.exports as unknown as WarmCacheExports;
  for (const call of [calls.html, calls.data]) {
    expect(await fillCacheCall(exports, call)).toBe("filled");
  }
  return calls;
}

describe("warm calls equal visitor calls", () => {
  test("a site without saved output", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const visitor = createSimulatedWorld(visitorOnly);
    await visit(visitor);
    const warmer = createSimulatedWorld(visitorOnly);
    const calls = await warm(warmer);

    expect(calls.saved).toBe(false);
    expect(warmer.calls.map(describeRecord)).toEqual(visitor.calls.map(describeRecord));
    expect(warmer.calls.map((call) => call.entrypoint)).toEqual([
      "DocsHtmlCache",
      "DocsRouteDataCache",
    ]);
    // The visitor's next request is a hit on the key the warmer filled.
    warmer.calls.length = 0;
    await visit(warmer);
    expect(warmer.calls.map((call) => call.status)).toEqual(["HIT", "HIT"]);
  });

  test("an M36 site: both saved-output calls", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m36 = { ...visitorOnly, DOXA_PROD_PRERENDER_MODE: "all" };
    const visitor = createSimulatedWorld(m36);
    await visit(visitor);
    const warmer = createSimulatedWorld(m36);
    const calls = await warm(warmer);

    expect(calls.saved).toBe(true);
    const savedVisitorCalls = visitor.calls
      .filter((call) => call.entrypoint === "DocsPrerenderCache")
      .map(describeRecord);
    expect(warmer.calls.map(describeRecord)).toEqual(savedVisitorCalls);
    expect(savedVisitorCalls).toHaveLength(2);
  });

  test("a page path is encoded as a visitor's URL would be", async () => {
    const world = createSimulatedWorld(visitorOnly);
    const calls = await selectWarmCalls({ target, pathname: "/guide/hello world", env: world.env });
    expect(calls?.html.request.url).toBe("https://docs.example.com/guide/hello%20world");
  });
});

describe("warm fills", () => {
  function exportsAnswering(responses: Response[]) {
    const fetch = vi.fn(async () => responses.shift() ?? new Response("ok"));
    const entrypoint = () => ({ fetch });
    return {
      exports: {
        DocsHtmlCache: entrypoint,
        DocsPrerenderCache: entrypoint,
        DocsRouteDataCache: entrypoint,
      } satisfies WarmCacheExports,
      fetch,
    };
  }

  async function htmlCall(): Promise<PublicCacheCall> {
    const calls = await selectWarmCalls({
      target,
      pathname: "/guide",
      env: createSimulatedWorld(visitorOnly).env,
    });
    if (!calls) throw new Error("No calls.");
    return calls.html;
  }

  const marker = () =>
    new Response(null, { status: 204, headers: { [CACHE_PROBE_HEADER]: "miss" } });

  test("a received probe marker is not a fill: retry once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const once = exportsAnswering([marker(), new Response("ok")]);
    expect(await fillCacheCall(once.exports, await htmlCall())).toBe("filled");
    expect(once.fetch).toHaveBeenCalledTimes(2);
    const twice = exportsAnswering([marker(), marker()]);
    expect(await fillCacheCall(twice.exports, await htmlCall())).toBe("not_filled");
    expect(twice.fetch).toHaveBeenCalledTimes(2);
  });

  test("fills are real calls; only the verification is a probe", async () => {
    const answer = exportsAnswering([new Response("ok"), new Response("ok")]);
    const call = await htmlCall();
    await fillCacheCall(answer.exports, call);
    expect(await isCacheCallStored(answer.exports, call)).toBe(true);
    const requests = answer.fetch.mock.calls.map(
      (args: unknown[]) => args[0] as Request,
    );
    expect(requests[0]?.headers.get(CACHE_PROBE_HEADER)).toBeNull();
    expect(requests[1]?.headers.get(CACHE_PROBE_HEADER)).toBe("1");
  });

  test("a 5xx or a thrown call is an error, never a fill", async () => {
    const failing = exportsAnswering([new Response("no", { status: 503 })]);
    expect(await fillCacheCall(failing.exports, await htmlCall())).toBe("error");
    const throwing = {
      DocsHtmlCache: () => ({ fetch: async () => Promise.reject(new Error("x")) }),
      DocsPrerenderCache: () => ({ fetch: async () => new Response("ok") }),
      DocsRouteDataCache: () => ({ fetch: async () => new Response("ok") }),
    } satisfies WarmCacheExports;
    expect(await fillCacheCall(throwing, await htmlCall())).toBe("error");
  });
});
