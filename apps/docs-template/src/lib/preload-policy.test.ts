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
      defaultPreloadStaleTime: 600_000,
    });
  });

  test("defers viewport preloading of aggressive navigation links until after load", () => {
    const deferred = {
      preload: "intent",
      preloadDelay: 75,
      deferredViewportPreload: true,
    };
    expect(docsSidebarLinkPreload).toEqual(deferred);
    expect(docsNearRoutePreload).toEqual(deferred);
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
