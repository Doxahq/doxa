import { featuresSchema } from "@doxahq/site-config";

export type DocsPreloadMode = false | "intent" | "viewport" | "render";

export interface DocsRouterPreloadPolicy {
  defaultPreload: DocsPreloadMode;
  defaultPreloadDelay: number;
  defaultPreloadIntentProximity: number;
}

export interface DocsLinkPreloadPolicy {
  preload: DocsPreloadMode;
  preloadDelay?: number;
  /**
   * Also preload when the link is visible, but only after the page has loaded
   * and through a shared queue with a small concurrency limit.
   */
  deferredViewportPreload?: true;
}

export interface DocsNavigationPreloadSettings {
  AgressiveNavPrefetch: boolean;
}

const INTENT_PRELOAD_DELAY_MS = 75;
const INTENT_PRELOAD_PROXIMITY_PX = 48;

export const docsRouterPreloadPolicy = {
  defaultPreload: "intent",
  defaultPreloadDelay: INTENT_PRELOAD_DELAY_MS,
  defaultPreloadIntentProximity: INTENT_PRELOAD_PROXIMITY_PX,
} as const satisfies DocsRouterPreloadPolicy;

/**
 * Aggressive navigation preloads every visible link, but only after the page
 * has loaded, a few at a time, so the preloads do not slow the page itself.
 * Hover still preloads at once.
 */
function createDeferredViewportPreloadPolicy(): DocsLinkPreloadPolicy {
  return {
    ...createIntentPreloadPolicy(),
    deferredViewportPreload: true,
  };
}

function createIntentPreloadPolicy(): DocsLinkPreloadPolicy {
  return {
    preload: "intent",
    preloadDelay: INTENT_PRELOAD_DELAY_MS,
  };
}

export function createDocsSidebarLinkPreload(
  settings: DocsNavigationPreloadSettings
): DocsLinkPreloadPolicy {
  return settings.AgressiveNavPrefetch
    ? createDeferredViewportPreloadPolicy()
    : createIntentPreloadPolicy();
}

export function createDocsNearRoutePreload(
  settings: DocsNavigationPreloadSettings
): DocsLinkPreloadPolicy {
  return settings.AgressiveNavPrefetch
    ? createDeferredViewportPreloadPolicy()
    : createIntentPreloadPolicy();
}

export const docsSidebarLinkPreload = createDocsSidebarLinkPreload(
  featuresSchema.parse({})
);

export const docsNearRoutePreload = createDocsNearRoutePreload(
  featuresSchema.parse({})
);
