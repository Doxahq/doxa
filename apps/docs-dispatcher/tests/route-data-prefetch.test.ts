import type { DocsHostResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  RouteDataPrefetches,
  planRouteDataPrefetch,
  readRouteDataPrefetchRollout,
  toRuntimeHref,
  type RouteDataPrefetchPlan,
} from "../src/route-data-prefetch";
import type { RuntimeResponse } from "../src/worker-exports";

const SITE = "site-1";
const resolution: DocsHostResolution = {
  siteId: SITE,
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/v1",
  manifestPath: "sites/site-1/versions/v1/manifest.json",
  accessPolicy: "public",
};
const ALL = readRouteDataPrefetchRollout({
  DOXA_PROD_ROUTE_DATA_PREFETCH_MODE: "all",
});
const ROUTE_DATA: RuntimeResponse = { ok: true, data: { type: "page" } };

function htmlRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://docs.example.com${path}`, {
    ...init,
    headers: { accept: "text/html", ...init.headers },
  });
}

function plan(pathname = "/guide"): RouteDataPrefetchPlan {
  return { id: "prefetch-1", payload: { pathname } };
}

/** A runtime whose answer the test releases, and a clock it moves. */
function setup(answer: () => Promise<RuntimeResponse> = async () => ROUTE_DATA) {
  let time = 1_000;
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = {
    request: vi.fn(async () => {
      await gate;
      return answer();
    }),
  };
  const call = vi.fn(async (): Promise<RuntimeResponse> => ({
    ok: true,
    data: { type: "fresh" },
  }));
  const prefetches = new RouteDataPrefetches(clock.now);
  return { clock, release, runtime, call, prefetches };
}

describe("route-data prefetch rollout", () => {
  test("is off by default", () => {
    expect(
      planRouteDataPrefetch({
        request: htmlRequest("/guide"),
        siteId: SITE,
        rollout: readRouteDataPrefetchRollout({}),
      }),
    ).toBeNull();
  });

  test("allowlist prefetches only the listed sites", () => {
    const rollout = readRouteDataPrefetchRollout({
      DOXA_PROD_ROUTE_DATA_PREFETCH_MODE: "allowlist",
      DOXA_PROD_ROUTE_DATA_PREFETCH_SITE_IDS: `${SITE}, site-3`,
    });
    const request = htmlRequest("/guide");
    expect(planRouteDataPrefetch({ request, siteId: SITE, rollout })).not.toBeNull();
    expect(
      planRouteDataPrefetch({ request, siteId: "site-2", rollout }),
    ).toBeNull();
  });

  test("an invalid mode warns and fails closed", () => {
    const warn = vi.fn();
    const rollout = readRouteDataPrefetchRollout(
      { DOXA_PROD_ROUTE_DATA_PREFETCH_MODE: "yes" },
      warn,
    );
    expect(rollout.mode).toBe("off");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DOXA_PROD_ROUTE_DATA_PREFETCH_MODE"),
    );
  });
});

describe("planRouteDataPrefetch", () => {
  test("plans the payload that docs-template sends for a page", () => {
    expect(
      planRouteDataPrefetch({
        request: htmlRequest("/guide/"),
        siteId: SITE,
        rollout: ALL,
        createId: () => "id-1",
      }),
    ).toEqual({ id: "id-1", payload: { pathname: "/guide" } });
  });

  test.each([
    ["a HEAD request", htmlRequest("/guide", { method: "HEAD" })],
    [
      "a request that does not accept HTML",
      new Request("https://docs.example.com/guide"),
    ],
    ["a query string", htmlRequest("/guide?demo=1")],
    ["a renderer asset", htmlRequest(`/_doxa/assets/${"a".repeat(64)}`)],
    ["raw Markdown", htmlRequest("/guide.md")],
    ["a visitor cookie", htmlRequest("/guide", { headers: { cookie: "a=b" } })],
  ])("plans nothing for %s", (_case, request) => {
    expect(
      planRouteDataPrefetch({ request, siteId: SITE, rollout: ALL }),
    ).toBeNull();
  });

  test.each([
    ["/", "/"],
    ["/guide", "/guide"],
    ["//guide//", "/guide"],
    ["/docs/index", "/docs"],
    ["/docs/index.mdx", "/docs"],
    ["/index", "/"],
    ["/a%20b", "/a%20b"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(toRuntimeHref(input)).toBe(expected);
  });

  test("matches docs-template's normalizeRuntimeHref", async () => {
    // A runtime import keeps docs-template out of this package's typecheck.
    const templatePath = "../../docs-template/src/runtime/runtime-source";
    const template: unknown = await import(/* @vite-ignore */ templatePath);
    if (
      typeof template !== "object" ||
      template === null ||
      !("normalizeRuntimeHref" in template) ||
      typeof template.normalizeRuntimeHref !== "function"
    ) {
      throw new Error("docs-template no longer exports normalizeRuntimeHref");
    }
    const templateNormalize = template.normalizeRuntimeHref;
    const normalize = (value: string): unknown =>
      Reflect.apply(templateNormalize, undefined, [value]);
    for (const input of [
      "/",
      "/guide",
      "/guide/",
      "//a//b//",
      "/docs/index",
      "/docs/INDEX.md",
      "/a%20b",
      "/a\\b",
      " /x ",
    ]) {
      expect(toRuntimeHref(input)).toBe(normalize(input));
    }
  });
});

describe("RouteDataPrefetches", () => {
  test("hands the prefetched answer to the renderer's call", async () => {
    const { clock, release, runtime, call, prefetches } = setup();
    const done = prefetches.start({ plan: plan(), runtime, resolution });
    clock.advance(40);

    const served = prefetches.serve(
      "prefetch-1",
      resolution,
      { operation: "getRouteData", payload: { pathname: "/guide" } },
      call,
    );
    clock.advance(10);
    release();

    await expect(served).resolves.toBe(ROUTE_DATA);
    await done;
    expect(call).not.toHaveBeenCalled();
    expect(runtime.request).toHaveBeenCalledOnce();
    expect(runtime.request).toHaveBeenCalledWith({
      resolution,
      operation: "getRouteData",
      payload: { pathname: "/guide" },
    });
    expect(prefetches.finish("prefetch-1")).toEqual({
      outcome: "handedOff",
      prefetchMs: 50,
      leadMs: 40,
      waitMs: 10,
    });
    expect(prefetches.size).toBe(0);
  });

  test("hands the answer over only once", async () => {
    const { release, runtime, call, prefetches } = setup();
    prefetches.start({ plan: plan(), runtime, resolution });
    release();
    const input = {
      operation: "getRouteData",
      payload: { pathname: "/guide" },
    };

    await prefetches.serve("prefetch-1", resolution, input, call);
    await prefetches.serve("prefetch-1", resolution, input, call);

    expect(call).toHaveBeenCalledOnce();
  });

  test.each([
    ["another path", "prefetch-1", resolution, "getRouteData", "/other"],
    ["another operation", "prefetch-1", resolution, "getPage", "/guide"],
    ["no prefetch ID", undefined, resolution, "getRouteData", "/guide"],
    ["an unknown ID", "prefetch-2", resolution, "getRouteData", "/guide"],
    [
      "another version",
      "prefetch-1",
      { ...resolution, publishedVersionId: "version-2" },
      "getRouteData",
      "/guide",
    ],
    [
      "another artifact prefix",
      "prefetch-1",
      { ...resolution, artifactPrefix: "sites/site-1/versions/v2" },
      "getRouteData",
      "/guide",
    ],
  ])(
    "calls docs-runtime itself for %s",
    async (_case, id, callResolution, operation, pathname) => {
      const { release, runtime, call, prefetches } = setup();
      prefetches.start({ plan: plan(), runtime, resolution });
      release();

      const served = await prefetches.serve(
        id,
        callResolution,
        { operation, payload: { pathname } },
        call,
      );

      expect(served).toEqual({ ok: true, data: { type: "fresh" } });
      expect(call).toHaveBeenCalledOnce();
      expect(prefetches.finish("prefetch-1")?.outcome).toBe("notTaken");
    },
  );

  test("falls back to a fresh call when the prefetch answers an error", async () => {
    const { release, runtime, call, prefetches } = setup(async () => ({
      ok: false,
      error: { code: "operation_failed", message: "boom" },
    }));
    prefetches.start({ plan: plan(), runtime, resolution });
    release();

    const served = await prefetches.serve(
      "prefetch-1",
      resolution,
      { operation: "getRouteData", payload: { pathname: "/guide" } },
      call,
    );

    expect(served).toEqual({ ok: true, data: { type: "fresh" } });
    expect(prefetches.finish("prefetch-1")?.outcome).toBe("fellBack");
  });

  test("falls back to a fresh call when the prefetch throws, without a rejection", async () => {
    const { release, runtime, call, prefetches } = setup(async () => {
      throw new Error("network");
    });
    const done = prefetches.start({ plan: plan(), runtime, resolution });
    release();

    await expect(done).resolves.toBeUndefined();
    await prefetches.serve(
      "prefetch-1",
      resolution,
      { operation: "getRouteData", payload: { pathname: "/guide" } },
      call,
    );
    expect(call).toHaveBeenCalledOnce();
    expect(prefetches.finish("prefetch-1")?.outcome).toBe("fellBack");
  });

  test("drops entries that no render finished within a minute", () => {
    const { clock, runtime, prefetches } = setup();
    prefetches.start({ plan: plan(), runtime, resolution });
    clock.advance(60_001);
    prefetches.start({
      plan: { id: "prefetch-2", payload: { pathname: "/" } },
      runtime,
      resolution,
    });

    expect(prefetches.finish("prefetch-1")).toBeUndefined();
    expect(prefetches.size).toBe(1);
  });
});
