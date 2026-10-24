import type { DocsDomainResolution } from "@doxahq/contracts";
import type { PrerenderIdentity } from "@doxahq/contracts/docs-prerender";

import { isPublicProduction } from "./cache-policy";
import {
  createExpectedPrerenderIdentity,
  parsePrerenderMode,
} from "./prerender-policy";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type RolloutMode,
  type SiteRollout,
} from "./rollout-policy";
import type { ServerTimingRecorder } from "./server-timing";

/**
 * How client navigation gets route data for a public production site:
 * - `saved`: pre-rendered JSON in R2, behind Workers Cache.
 * - `cachedLive`: live route data, stored in Workers Cache on first request.
 */
export type RouteDataDelivery = "saved" | "cachedLive";

export interface DeliveryRollouts {
  prerender: SiteRollout;
  routeDataCache: SiteRollout;
}

export interface DeliveryRolloutEnv {
  DOXA_PROD_PRERENDER_MODE?: string;
  DOXA_PROD_PRERENDER_SITE_IDS?: string;
  DOXA_PROD_ROUTE_DATA_CACHE_MODE?: string;
  DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS?: string;
}

export interface DeliveryIdentityEnv {
  DOXA_RENDERER_RELEASE_ID?: string;
}

/** One public request that can use a route-data delivery. */
export interface DeliveryRequestContext {
  request: Request;
  env: DeliveryIdentityEnv & { DOCS_RENDERED_BUCKET?: R2Bucket };
  ctx: ExecutionContext;
  rollouts: DeliveryRollouts;
  timing: ServerTimingRecorder;
  resolveHost(hostname: string): Promise<DocsDomainResolution | null>;
}

/** A delivery and the version identity that the browser receives for it. */
export interface ActiveDelivery {
  delivery: RouteDataDelivery;
  identity: PrerenderIdentity;
}

const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;

function parseRouteDataCacheMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): RolloutMode {
  return parseRolloutMode(value, (invalid) =>
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_ROUTE_DATA_CACHE_MODE ${JSON.stringify(invalid)}; the route-data cache is disabled.`,
    ),
  );
}

export function readDeliveryRollouts(
  env: DeliveryRolloutEnv,
): DeliveryRollouts {
  return {
    prerender: {
      mode: parsePrerenderMode(env.DOXA_PROD_PRERENDER_MODE),
      siteIds: parseSiteAllowlist(env.DOXA_PROD_PRERENDER_SITE_IDS),
    },
    routeDataCache: {
      mode: parseRouteDataCacheMode(env.DOXA_PROD_ROUTE_DATA_CACHE_MODE),
      siteIds: parseSiteAllowlist(env.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS),
    },
  };
}

export function hasAnyDeliveryRollout(rollouts: DeliveryRollouts): boolean {
  return (
    rollouts.prerender.mode !== "off" || rollouts.routeDataCache.mode !== "off"
  );
}

/** The pre-render mode as saved-output cache props carry it, if enabled. */
export function getEnabledPrerenderMode(
  rollouts: DeliveryRollouts,
): Exclude<RolloutMode, "off"> | null {
  const mode = rollouts.prerender.mode;
  return mode === "off" ? null : mode;
}

/** Saved output has priority, because it needs no render on a cache miss. */
export function selectRouteDataDelivery(
  rollouts: DeliveryRollouts,
  siteId: string,
): RouteDataDelivery | null {
  if (isSiteInRollout(rollouts.prerender, siteId)) return "saved";
  if (isSiteInRollout(rollouts.routeDataCache, siteId)) return "cachedLive";
  return null;
}

/**
 * Builds the version identity from trusted data only: the host resolution,
 * the deployed renderer release, and the request origin.
 */
export async function createDeliveryIdentity(
  request: Request,
  resolution: DocsDomainResolution,
  env: DeliveryIdentityEnv,
): Promise<PrerenderIdentity | null> {
  const rendererReleaseId = env.DOXA_RENDERER_RELEASE_ID?.trim();
  if (!rendererReleaseId || !RELEASE_ID_PATTERN.test(rendererReleaseId)) {
    console.warn(
      "[doxa-docs-dispatcher] Route-data delivery is enabled without a valid DOXA_RENDERER_RELEASE_ID; the delivery identity is bypassed.",
    );
    return null;
  }
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname !== resolution.hostname) {
    return null;
  }
  return createExpectedPrerenderIdentity({
    siteId: resolution.siteId,
    artifactPrefix: resolution.artifactPrefix,
    manifestPath: resolution.manifestPath,
    rendererReleaseId,
    trustedRequestOrigin: url.origin,
  });
}

export async function resolveActiveDelivery(
  request: Request,
  resolution: DocsDomainResolution | null | undefined,
  env: DeliveryIdentityEnv,
  rollouts: DeliveryRollouts,
): Promise<ActiveDelivery | null> {
  if (!resolution || !isPublicProduction(resolution)) return null;
  const delivery = selectRouteDataDelivery(rollouts, resolution.siteId);
  if (!delivery) return null;
  const identity = await createDeliveryIdentity(request, resolution, env);
  return identity ? { delivery, identity } : null;
}
