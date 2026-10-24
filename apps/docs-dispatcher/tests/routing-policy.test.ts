import { describe, expect, test } from "vitest";

import { parseSiteAllowlist } from "../src/rollout-policy";
import {
  createDynamicWorkerId,
  getRendererSelection,
  parseRendererMode,
  shouldResolveDocsHost,
} from "../src/routing-policy";

const productionResolution = {
  siteId: "site-1",
  publishedVersionId: "version-1",
  renderTarget: "production" as const,
};

describe("renderer routing policy", () => {
  test("treats missing and invalid modes as off", () => {
    expect(parseRendererMode(undefined)).toBe("off");
    expect(parseRendererMode("broken")).toBe("off");
  });

  test("does not resolve a hostname while dynamic rendering is off", () => {
    expect(shouldResolveDocsHost("off")).toBe(false);
    expect(shouldResolveDocsHost("allowlist")).toBe(true);
    expect(shouldResolveDocsHost("all")).toBe(true);
  });

  test("keeps previews and permanent generation URLs on the shared renderer", () => {
    for (const renderTarget of ["preview", "generation_snapshot"] as const) {
      expect(
        getRendererSelection({
          mode: "all",
          allowedSiteIds: new Set(),
          resolution: { ...productionResolution, renderTarget },
        }),
      ).toBe("shared");
    }
  });

  test("only enables allowlisted production sites in allowlist mode", () => {
    expect(
      getRendererSelection({
        mode: "allowlist",
        allowedSiteIds: new Set(["site-1"]),
        resolution: productionResolution,
      }),
    ).toBe("dynamic");
    expect(
      getRendererSelection({
        mode: "allowlist",
        allowedSiteIds: new Set(["site-2"]),
        resolution: productionResolution,
      }),
    ).toBe("shared");
  });

  test("enables every resolved production site in all mode", () => {
    expect(
      getRendererSelection({
        mode: "all",
        allowedSiteIds: new Set(),
        resolution: productionResolution,
      }),
    ).toBe("dynamic");
  });

  test("fails closed to shared when the API omits the render target", () => {
    expect(
      getRendererSelection({
        mode: "all",
        allowedSiteIds: new Set(),
        resolution: {
          siteId: "site-1",
          publishedVersionId: "version-1",
        },
      }),
    ).toBe("shared");
  });

  test("normalizes the comma-separated site allowlist", () => {
    expect(parseSiteAllowlist(" site-1,site-2,site-1 ,, ")).toEqual(
      new Set(["site-1", "site-2"]),
    );
  });

  test("creates a stable worker identity for one site version and build", () => {
    expect(
      createDynamicWorkerId({
        siteId: "site-1",
        publishedVersionId: "version-1",
        rendererBuildId: "build-1",
      }),
    ).toBe("docs:site-1:version-1:build-1");
  });
});
