import { describe, expect, test } from "vitest";

import {
  createDocsNearRoutePreload,
  createDocsSidebarLinkPreload,
  docsNearRoutePreload,
  docsRouterPreloadPolicy,
  docsSidebarLinkPreload,
} from "./preload-policy";

describe("docs preload policy", () => {
  test("keeps global router preloading intent-based", () => {
    expect(docsRouterPreloadPolicy).toEqual({
      defaultPreload: "intent",
      defaultPreloadDelay: 75,
      defaultPreloadIntentProximity: 48,
    });
  });

  test("uses viewport preloading for configured aggressive navigation links", () => {
    expect(docsSidebarLinkPreload).toEqual({
      preload: "viewport",
      preloadDelay: 50,
    });
    expect(docsNearRoutePreload).toEqual({
      preload: "viewport",
      preloadDelay: 50,
    });
  });

  test("falls back to intent preloading when aggressive navigation prefetch is disabled", () => {
    const settings = { AgressiveNavPrefetch: false };

    expect(createDocsSidebarLinkPreload(settings)).toEqual({
      preload: "intent",
      preloadDelay: 75,
    });
    expect(createDocsNearRoutePreload(settings)).toEqual({
      preload: "intent",
      preloadDelay: 75,
    });
  });
});
