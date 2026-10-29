import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  applyRouteDataBrowserCachePolicy,
  isRouteDataBrowserCacheable,
  readRouteDataBrowserCacheRollout,
} from "../src/route-data-browser-cache";

const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};
const ALL = readRouteDataBrowserCacheRollout({
  DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE: "all",
});
const request = new Request(
  "https://docs.example.com/_doxa/route-data/v1?path=%2Fguide",
);
type CacheableInput = Parameters<typeof isRouteDataBrowserCacheable>[0];
const eligible: CacheableInput = {
  request,
  status: 200,
  hintMatched: true,
  resolution,
  rollout: ALL,
};

describe("route-data browser cache rollout", () => {
  test("is off by default", () => {
    expect(readRouteDataBrowserCacheRollout({}).mode).toBe("off");
  });

  test("an invalid mode warns and fails closed", () => {
    const warn = vi.fn();
    expect(
      readRouteDataBrowserCacheRollout(
        { DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE: "yes" },
        warn,
      ).mode,
    ).toBe("off");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE"),
    );
  });
});

describe("isRouteDataBrowserCacheable", () => {
  test("allows a matched 200 for a public production site in the rollout", () => {
    expect(isRouteDataBrowserCacheable(eligible)).toBe(true);
  });

  test.each<[string, Partial<CacheableInput>]>([
    ["an unmatched hint", { hintMatched: false }],
    ["a 409", { status: 409 }],
    ["a 503", { status: 503 }],
    ["no resolution", { resolution: null }],
    [
      "a private site",
      { resolution: { ...resolution, accessPolicy: "authenticated" } },
    ],
    ["a preview host", { resolution: { ...resolution, renderTarget: "preview" } }],
    ["mode off", { rollout: readRouteDataBrowserCacheRollout({}) }],
    [
      "an allowlist without the site",
      {
        rollout: readRouteDataBrowserCacheRollout({
          DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE: "allowlist",
          DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS: "site-2",
        }),
      },
    ],
    [
      "a cookie",
      {
        request: new Request(request.url, { headers: { cookie: "a=b" } }),
      },
    ],
    [
      "authorization",
      {
        request: new Request(request.url, {
          headers: { authorization: "Bearer x" },
        }),
      },
    ],
  ])("refuses %s", (_case, change) => {
    expect(isRouteDataBrowserCacheable({ ...eligible, ...change })).toBe(false);
  });
});

describe("applyRouteDataBrowserCachePolicy", () => {
  test("changes only cache-control", () => {
    const response = new Response("{}", {
      headers: {
        "cache-control": "private, no-store",
        "cdn-cache-control": "private, no-store",
      },
    });

    applyRouteDataBrowserCachePolicy(response, {
      request,
      hintMatched: true,
      resolution,
      rollout: ALL,
    });

    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=3600",
    );
    expect(response.headers.get("cdn-cache-control")).toBe(
      "private, no-store",
    );
  });
});
