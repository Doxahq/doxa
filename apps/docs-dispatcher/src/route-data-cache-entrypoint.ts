import type { DocsDomainResolution } from "@doxahq/contracts";
import type { PrerenderIdentity } from "@doxahq/contracts/docs-prerender";
import { WorkerEntrypoint } from "cloudflare:workers";

import { isPublicProduction, withRouteDataCachePolicy } from "./cache-policy";
import {
  readDeliveryRollouts,
  selectRouteDataDelivery,
  type DeliveryRolloutEnv,
} from "./delivery-identity";
import { createLiveRouteDataResponse } from "./live-route-data";
import {
  readPreviousRendererBuild,
  type RendererBuildEnv,
} from "./previous-renderer-build";
import { logRendererReleaseRejected } from "./release-check";
import { ROUTE_DATA_PATH } from "./route-data-request";
import {
  attachInternalServerTiming,
  createServerTiming,
} from "./server-timing";
import { serveVersionedEntrypoint } from "./versioned-entrypoint-protocol";
import { getWorkerExports } from "./worker-exports";

/** Set only by the dispatcher. Together with the URL, they form the cache key. */
export interface RouteDataCacheProps {
  expected: PrerenderIdentity;
  hostname: string;
  pathname: string;
  resolution: DocsDomainResolution;
}

interface RouteDataCacheEnv extends DeliveryRolloutEnv, RendererBuildEnv {
  DEBUG?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
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
    return serveVersionedEntrypoint({
      entrypoint: "DocsRouteDataCache",
      request,
      props,
      build: {
        requested: props.expected.rendererReleaseId,
        deployed: this.env.DOXA_RENDERER_RELEASE_ID?.trim() || null,
        previous: readPreviousRendererBuild(this.env)?.releaseId ?? null,
      },
      isTrusted: () => isTrustedRouteDataCacheRequest(request, props, this.env),
      onBuildRejected: (reason) =>
        logRendererReleaseRejected({
          entrypoint: "DocsRouteDataCache",
          expected: props.expected,
          deployedReleaseId: this.env.DOXA_RENDERER_RELEASE_ID,
          reason,
        }),
      rejection: "Invalid route-data cache request",
      fill: async () => {
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
      },
    });
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
