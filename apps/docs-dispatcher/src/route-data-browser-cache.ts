import type { DocsDomainResolution } from "@doxahq/contracts";

import { isPublicProduction } from "./cache-policy";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";

/**
 * Route data in the browser cache (M40, D5).
 *
 * A route-data URL carries the render ID as its `render` hint. When the hint
 * matches the live render ID, the answer for that URL never changes, so the
 * browser may keep it for one hour. A new publish or renderer release changes
 * the render ID and so the URL. Shared caches never store it: only
 * `cache-control` changes, and the CDN headers stay `private, no-store`.
 */
export interface RouteDataBrowserCacheEnv {
  DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE?: string;
  DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS?: string;
}

export const ROUTE_DATA_BROWSER_CACHE_CONTROL = "private, max-age=3600";

export function readRouteDataBrowserCacheRollout(
  env: RouteDataBrowserCacheEnv,
  warn: (message: string) => void = console.warn,
): SiteRollout {
  return {
    mode: parseRolloutMode(
      env.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE,
      (invalid) =>
        warn(
          `[doxa-docs-dispatcher] Invalid DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE ${JSON.stringify(invalid)}; route data stays out of the browser cache.`,
        ),
    ),
    siteIds: parseSiteAllowlist(env.DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS),
  };
}

/**
 * True only for a 200 answer to a request without cookie or authorization,
 * for a public production site in the rollout, whose render hint matched.
 */
export function isRouteDataBrowserCacheable(input: {
  request: Request;
  status: number;
  hintMatched: boolean;
  resolution: DocsDomainResolution | null | undefined;
  rollout: SiteRollout;
}): boolean {
  const { request, status, hintMatched, resolution, rollout } = input;
  return (
    status === 200 &&
    hintMatched &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    resolution !== null &&
    resolution !== undefined &&
    isPublicProduction(resolution) &&
    isSiteInRollout(rollout, resolution.siteId)
  );
}

/**
 * Sets the browser-cache lifetime on an uncached gateway response when
 * `isRouteDataBrowserCacheable` allows it. The response must have mutable
 * headers (the gateway's own copy).
 */
export function applyRouteDataBrowserCachePolicy(
  response: Response,
  input: Omit<Parameters<typeof isRouteDataBrowserCacheable>[0], "status">,
): Response {
  if (isRouteDataBrowserCacheable({ ...input, status: response.status })) {
    response.headers.set("cache-control", ROUTE_DATA_BROWSER_CACHE_CONTROL);
  }
  return response;
}
