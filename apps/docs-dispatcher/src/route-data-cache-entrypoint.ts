import type { DocsDomainResolution } from "@doxahq/contracts";
import type { PrerenderIdentity } from "@doxahq/contracts/docs-prerender";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  isPublicProduction,
  withRouteDataCachePolicy,
  withoutResponseCaching,
} from "./cache-policy";
import {
  readDeliveryRollouts,
  selectRouteDataDelivery,
  type DeliveryRolloutEnv,
} from "./delivery-identity";
import { createLiveRouteDataResponse } from "./live-route-data";
import { ROUTE_DATA_PATH } from "./route-data-request";
import {
  attachInternalServerTiming,
  createServerTiming,
} from "./server-timing";
import { getWorkerExports } from "./worker-exports";

/** Set only by the dispatcher. Together with the URL, they form the cache key. */
export interface RouteDataCacheProps {
  expected: PrerenderIdentity;
  hostname: string;
  pathname: string;
  resolution: DocsDomainResolution;
}

interface RouteDataCacheEnv extends DeliveryRolloutEnv {
  DEBUG?: string;
}

/** The internal URL of one route-data entry. It never overlaps HTML paths. */
export function createRouteDataCacheUrl(
  origin: string,
  pathname: string,
): string {
  return `${origin}${ROUTE_DATA_PATH}${pathname}`;
}

/**
 * Cache entrypoint for live route data. The first request for a page and
 * version renders it; later requests in every region read the stored copy.
 */
export class DocsRouteDataCache extends WorkerEntrypoint<
  RouteDataCacheEnv,
  RouteDataCacheProps
> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    if (!isTrustedRouteDataCacheRequest(request, props, this.env)) {
      return withoutResponseCaching(
        new Response("Invalid route-data cache request", { status: 400 }),
      );
    }
    const timing = createServerTiming(this.env.DEBUG);
    const live = await timing.measure("doxa_route_data_prepare", () =>
      createLiveRouteDataResponse(
        getWorkerExports(this.ctx).PrerenderRendererApi({}),
        props.resolution,
        props.pathname,
      ),
    );
    return attachInternalServerTiming(
      withRouteDataCachePolicy(live, "versioned"),
      timing,
    );
  }
}

function isTrustedRouteDataCacheRequest(
  request: Request,
  props: RouteDataCacheProps,
  env: DeliveryRolloutEnv,
): boolean {
  const { expected, hostname, pathname, resolution } = props;
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    // Compare normalized URLs, so percent-encoding cannot cause a mismatch.
    url.href === new URL(createRouteDataCacheUrl(url.origin, pathname)).href &&
    isPublicProduction(resolution) &&
    selectRouteDataDelivery(readDeliveryRollouts(env), resolution.siteId) ===
      "cachedLive" &&
    hostname === url.hostname &&
    resolution.hostname === hostname &&
    expected.siteId === resolution.siteId &&
    expected.artifactPrefix === resolution.artifactPrefix &&
    expected.trustedRequestOrigin === url.origin
  );
}
