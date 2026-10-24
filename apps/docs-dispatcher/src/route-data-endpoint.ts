import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_PRERENDER_SCHEMA_VERSION,
  parsePublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";

import {
  getEnabledPrerenderMode,
  hasAnyDeliveryRollout,
  resolveActiveDelivery,
  type ActiveDelivery,
  type DeliveryRequestContext,
} from "./delivery-identity";
import { createLiveRouteDataResponse } from "./live-route-data";
import {
  applyPrerenderDiagnostics,
  readPrerenderDiagnostics,
  type PrerenderAttemptDiagnostics,
} from "./prerender-routing";
import { createRouteDataCacheUrl } from "./route-data-cache-entrypoint";
import {
  parseRouteDataRequest,
  RouteDataRequestError,
  type ParsedRouteDataRequest,
} from "./route-data-request";
import { mergeFreshInternalServerTiming } from "./server-timing";
import { getWorkerExports } from "./worker-exports";

export interface RouteDataEndpointResult {
  response: Response;
  /** The `cf-cache-status` of the cache entrypoint used, or `BYPASS`. */
  cacheStatus: string;
}

/** Where one request reads its route data from. */
type RouteDataSource = "savedCache" | "liveCache" | "live";

interface FetchedRouteData {
  /** Internal response: route-data JSON on success, any non-200 on failure. */
  response: Response;
  cacheStatus: string;
  diagnostics: PrerenderAttemptDiagnostics | null;
}

interface RouteDataLookup {
  input: DeliveryRequestContext;
  parsed: ParsedRouteDataRequest;
  resolution: DocsDomainResolution;
  active: ActiveDelivery;
}

const BYPASS = "BYPASS";

export async function handleRouteDataEndpoint(
  input: DeliveryRequestContext,
): Promise<RouteDataEndpointResult> {
  let parsed: ParsedRouteDataRequest;
  try {
    parsed = parseRouteDataRequest(input.request);
  } catch (error) {
    if (error instanceof RouteDataRequestError) {
      return uncached(
        Response.json(
          { status: "invalid_request" },
          { status: error.code === "method_not_allowed" ? 405 : 400 },
        ),
      );
    }
    throw error;
  }
  if (!hasAnyDeliveryRollout(input.rollouts)) {
    return uncached(unavailable(404, true));
  }
  const resolution = await input.resolveHost(
    new URL(input.request.url).hostname,
  );
  const active = await resolveActiveDelivery(
    input.request,
    resolution,
    input.env,
    input.rollouts,
  );
  if (!resolution || !active) return uncached(unavailable(404, false));
  if (parsed.renderHint && parsed.renderHint !== active.identity.renderId) {
    return uncached(
      Response.json({ status: "version_mismatch" }, { status: 409 }),
    );
  }

  const lookup: RouteDataLookup = { input, parsed, resolution, active };
  const fetched = await fetchRouteData(lookup, selectRouteDataSource(lookup));
  const response = await createEnvelopeResponse(lookup, fetched.response);
  if (fetched.diagnostics) {
    applyPrerenderDiagnostics(response, fetched.diagnostics, input.timing);
  }
  return { response, cacheStatus: fetched.cacheStatus };
}

function selectRouteDataSource({
  input,
  parsed,
  active,
}: RouteDataLookup): RouteDataSource {
  // A visitor-specific request never reads or fills a shared entry.
  if (!parsed.sharedCacheEligible) return "live";
  if (active.delivery === "cachedLive") return "liveCache";
  return input.env.DOCS_RENDERED_BUCKET ? "savedCache" : "live";
}

function fetchRouteData(
  lookup: RouteDataLookup,
  source: RouteDataSource,
): Promise<FetchedRouteData> {
  switch (source) {
    case "savedCache":
      return fetchSavedRouteData(lookup);
    case "liveCache":
      return fetchCachedLiveRouteData(lookup);
    case "live":
      return fetchLiveRouteData(lookup);
  }
}

async function fetchSavedRouteData(
  lookup: RouteDataLookup,
): Promise<FetchedRouteData> {
  const { input, parsed, resolution, active } = lookup;
  const featureMode = getEnabledPrerenderMode(input.rollouts);
  if (!featureMode) return fetchLiveRouteData(lookup);
  const url = new URL(input.request.url);
  const result = await measureCacheFetch(input, "doxa_prerender_cache", () =>
    getWorkerExports(input.ctx)
      .DocsPrerenderCache({
        props: {
          expected: active.identity,
          featureMode,
          hostname: url.hostname,
          pathname: parsed.pathname,
          representation: "data",
          resolution,
        },
      })
      // The route-data representation keeps its own internal URL space.
      // Two representations of one route must never share a cache key.
      .fetch(createRouteDataCacheRequest(url.origin, parsed.pathname)),
  );
  return {
    ...result,
    diagnostics: readPrerenderDiagnostics(result.response, result.cacheStatus),
  };
}

async function fetchCachedLiveRouteData(
  lookup: RouteDataLookup,
): Promise<FetchedRouteData> {
  const { input, parsed, resolution, active } = lookup;
  const url = new URL(input.request.url);
  const result = await measureCacheFetch(input, "doxa_route_data_cache", () =>
    getWorkerExports(input.ctx)
      .DocsRouteDataCache({
        props: {
          expected: active.identity,
          hostname: url.hostname,
          pathname: parsed.pathname,
          resolution,
        },
      })
      .fetch(createRouteDataCacheRequest(url.origin, parsed.pathname)),
  );
  return { ...result, diagnostics: null };
}

async function fetchLiveRouteData({
  input,
  parsed,
  resolution,
}: RouteDataLookup): Promise<FetchedRouteData> {
  return {
    response: await createLiveRouteDataResponse(
      getWorkerExports(input.ctx).PrerenderRendererApi({}),
      resolution,
      parsed.pathname,
    ),
    cacheStatus: BYPASS,
    diagnostics: null,
  };
}

async function measureCacheFetch(
  input: DeliveryRequestContext,
  timingName: string,
  fetchEntry: () => Promise<Response>,
): Promise<Omit<FetchedRouteData, "diagnostics">> {
  let cacheStatus = BYPASS;
  const response = await input.timing.measure(
    timingName,
    async () => {
      const result = await fetchEntry();
      cacheStatus = result.headers.get("cf-cache-status") ?? BYPASS;
      return result;
    },
    () => cacheStatus,
  );
  mergeFreshInternalServerTiming(input.timing, response, cacheStatus);
  return { response, cacheStatus };
}

function createRouteDataCacheRequest(
  origin: string,
  pathname: string,
): Request {
  return new Request(createRouteDataCacheUrl(origin, pathname), {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

/** One public envelope for every source, so the client sees one contract. */
async function createEnvelopeResponse(
  { input, active }: RouteDataLookup,
  fetched: Response,
): Promise<Response> {
  if (!fetched.ok) return unavailable(503, true);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-doxa-representation-source":
      fetched.headers.get("x-doxa-representation-source") ?? "dynamic",
  };
  if (input.request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return Response.json(
    {
      status: "ok",
      schemaVersion: DOCS_PRERENDER_SCHEMA_VERSION,
      renderId: active.identity.renderId,
      data: parsePublicDocsRouteDataV1(await fetched.json()),
    },
    { headers },
  );
}

function unavailable(status: 404 | 503, retryable: boolean): Response {
  return Response.json({ status: "unavailable", retryable }, { status });
}

function uncached(response: Response): RouteDataEndpointResult {
  return { response, cacheStatus: BYPASS };
}
