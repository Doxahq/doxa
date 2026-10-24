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
}

export interface DocsNavigationPreloadSettings {
  AgressiveNavPrefetch: boolean;
}

const INTENT_PRELOAD_DELAY_MS = 75;
const INTENT_PRELOAD_PROXIMITY_PX = 48;
const AGRESSIVE_NAV_VIEWPORT_DELAY_MS = 50;

export const docsRouterPreloadPolicy = {
  defaultPreload: "intent",
  defaultPreloadDelay: INTENT_PRELOAD_DELAY_MS,
  defaultPreloadIntentProximity: INTENT_PRELOAD_PROXIMITY_PX,
} as const satisfies DocsRouterPreloadPolicy;

function createViewportPreloadPolicy(
  preloadDelay = AGRESSIVE_NAV_VIEWPORT_DELAY_MS
): DocsLinkPreloadPolicy {
  return {
    preload: "viewport",
    preloadDelay,
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
    ? createViewportPreloadPolicy()
    : createIntentPreloadPolicy();
}

export function createDocsNearRoutePreload(
  settings: DocsNavigationPreloadSettings
): DocsLinkPreloadPolicy {
  return settings.AgressiveNavPrefetch
    ? createViewportPreloadPolicy()
    : createIntentPreloadPolicy();
}

export const docsSidebarLinkPreload = createDocsSidebarLinkPreload(
  featuresSchema.parse({})
);

export const docsNearRoutePreload = createDocsNearRoutePreload(
  featuresSchema.parse({})
);
