import type { DocsDomainResolution } from "@doxahq/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createDeliveryIdentity,
  readDeliveryRollouts,
  resolveActiveDelivery,
  selectRouteDataDelivery,
  type DeliveryRollouts,
} from "../src/delivery-identity";
import { createExpectedPrerenderIdentity } from "../src/prerender-policy";

const releaseId = "a".repeat(64);

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

function rollouts(input: {
  prerender?: string;
  routeDataCache?: string;
}): DeliveryRollouts {
  return readDeliveryRollouts({
    DOXA_PROD_PRERENDER_MODE: input.prerender,
    DOXA_PROD_ROUTE_DATA_CACHE_MODE: input.routeDataCache,
  });
}

function request(url = "https://docs.example.com/guide"): Request {
  return new Request(url);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route-data delivery selection", () => {
  test.each([
    { prerender: "all", routeDataCache: "all", expected: "saved" },
    { prerender: "all", routeDataCache: "off", expected: "saved" },
    { prerender: "off", routeDataCache: "all", expected: "cachedLive" },
    { prerender: "off", routeDataCache: "off", expected: null },
  ])(
    "selects $expected for pre-render $prerender and route-data cache $routeDataCache",
    ({ prerender, routeDataCache, expected }) => {
      expect(
        selectRouteDataDelivery(
          rollouts({ prerender, routeDataCache }),
          "site-1",
        ),
      ).toBe(expected);
    },
  );

  test("uses each allowlist for its own rollout", () => {
    const selected = readDeliveryRollouts({
      DOXA_PROD_PRERENDER_MODE: "allowlist",
      DOXA_PROD_PRERENDER_SITE_IDS: "site-1",
      DOXA_PROD_ROUTE_DATA_CACHE_MODE: "allowlist",
      DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS: "site-2",
    });
    expect(selectRouteDataDelivery(selected, "site-1")).toBe("saved");
    expect(selectRouteDataDelivery(selected, "site-2")).toBe("cachedLive");
    expect(selectRouteDataDelivery(selected, "site-3")).toBeNull();
  });

  test("fails closed and warns for an invalid route-data cache mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(rollouts({ routeDataCache: "maybe" }).routeDataCache.mode).toBe(
      "off",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DOXA_PROD_ROUTE_DATA_CACHE_MODE"),
    );
  });
});

describe("delivery identity", () => {
  test("matches the saved-output identity for the same trusted input", async () => {
    const identity = await createDeliveryIdentity(request(), resolution, {
      DOXA_RENDERER_RELEASE_ID: releaseId,
    });
    expect(identity).toEqual(
      await createExpectedPrerenderIdentity({
        siteId: resolution.siteId,
        artifactPrefix: resolution.artifactPrefix,
        manifestPath: resolution.manifestPath,
        rendererReleaseId: releaseId,
        trustedRequestOrigin: "https://docs.example.com",
      }),
    );
  });

  test.each([
    { name: "missing", value: undefined },
    { name: "placeholder", value: "unconfigured" },
  ])("has no identity with a $name release ID", async ({ value }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await createDeliveryIdentity(request(), resolution, {
        DOXA_RENDERER_RELEASE_ID: value,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  test.each([
    { name: "plain HTTP", url: "http://docs.example.com/guide" },
    { name: "another host", url: "https://other.example.com/guide" },
  ])("has no identity for a $name request", async ({ url }) => {
    expect(
      await createDeliveryIdentity(request(url), resolution, {
        DOXA_RENDERER_RELEASE_ID: releaseId,
      }),
    ).toBeNull();
  });

  test.each([
    { name: "unknown host", value: null },
    {
      name: "private site",
      value: { ...resolution, accessPolicy: "authenticated" as const },
    },
    {
      name: "preview",
      value: { ...resolution, renderTarget: "preview" as const },
    },
    {
      name: "generation snapshot",
      value: { ...resolution, renderTarget: "generation_snapshot" as const },
    },
  ])("has no active delivery for a $name", async ({ value }) => {
    expect(
      await resolveActiveDelivery(
        request(),
        value,
        { DOXA_RENDERER_RELEASE_ID: releaseId },
        rollouts({ prerender: "all", routeDataCache: "all" }),
      ),
    ).toBeNull();
  });

  test("returns the selected delivery with its identity", async () => {
    const active = await resolveActiveDelivery(
      request(),
      resolution,
      { DOXA_RENDERER_RELEASE_ID: releaseId },
      rollouts({ routeDataCache: "all" }),
    );
    expect(active?.delivery).toBe("cachedLive");
    expect(active?.identity.renderId).toMatch(/^[a-f0-9]{64}$/);
  });
});
