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
import {
  tryPreviousRouteData,
  type PreviousFallbackEnv,
  type PreviousRouteDataInput,
} from "./previous-build-fallback";
import {
  createRouteDataCacheCall,
  createSavedOutputCall,
  fetchPublicCacheCall,
  type RouteDataCacheCall,
  type SavedOutputCacheCall,
} from "./public-cache-calls";
import {
  parseRouteDataRequest,
  RouteDataRequestError,
  type ParsedRouteDataRequest,
} from "./route-data-request";
import { mergeFreshInternalServerTiming } from "./server-timing";
import { fetchWithoutProbeMarker } from "./versioned-entrypoint-protocol";
import { getWorkerExports } from "./worker-exports";

export interface RouteDataEndpointResult {
  response: Response;
  /** The `cf-cache-status` of the cache entrypoint used, or `BYPASS`. */
  cacheStatus: string;
  /**
   * True when the request's render hint equals the live render ID. The
   * answer for that URL then cannot change (`route-data-browser-cache.ts`).
   */
  hintMatched: boolean;
}

/** Where one request reads its route data from. */
type RouteDataSource = "savedCache" | "liveCache" | "live";

interface FetchedRouteData {
  /** Internal response: route-data JSON on success, any non-200 on failure. */
  response: Response;
  cacheStatus: string;
  diagnostics: PrerenderAttemptDiagnostics | null;
}

/** The endpoint also reads the previous-build fallback settings. */
export type RouteDataEndpointContext = DeliveryRequestContext & {
  env: PreviousFallbackEnv;
};

interface RouteDataLookup {
  input: RouteDataEndpointContext;
  parsed: ParsedRouteDataRequest;
  resolution: DocsDomainResolution;
  active: ActiveDelivery;
}

const BYPASS = "BYPASS";

export async function handleRouteDataEndpoint(
  input: RouteDataEndpointContext,
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
  const lookup: RouteDataLookup = { input, parsed, resolution, active };
  if (parsed.renderHint && parsed.renderHint !== active.identity.renderId) {
    return answerOtherRenderHint(lookup, parsed.renderHint);
  }
  const hintMatched = parsed.renderHint === active.identity.renderId;

  const fetched = await fetchRouteData(lookup, selectRouteDataSource(lookup));
  const response = await createEnvelopeResponse(
    input,
    active.identity.renderId,
    fetched.response,
  );
  if (fetched.diagnostics) {
    applyPrerenderDiagnostics(response, fetched.diagnostics, input.timing);
  }
  return { response, cacheStatus: fetched.cacheStatus, hintMatched };
}

/**
 * A page of the previous renderer build asks for its own route data (D8).
 * Inside the build window, a stored previous-build entry is served with that
 * build's identity (F15); anything else is a version mismatch.
 */
async function answerOtherRenderHint(
  lookup: RouteDataLookup,
  renderHint: string,
): Promise<RouteDataEndpointResult> {
  const { input, parsed, resolution } = lookup;
  const source = selectPreviousRouteDataSource(lookup);
  const previous = source
    ? await tryPreviousRouteData(
        {
          env: input.env,
          ctx: input.ctx,
          exports: getWorkerExports(input.ctx),
          now: Date.now(),
        },
        {
          request: input.request,
          resolution,
          pathname: parsed.pathname,
          renderHint,
          source,
        },
      )
    : null;
  if (!previous) {
    return uncached(
      Response.json({ status: "version_mismatch" }, { status: 409 }),
    );
  }
  // The answer carries the identity that the hint names, and that URL's
  // content never changes, so the browser may keep it like a live answer.
  return {
    response: await createEnvelopeResponse(
      input,
      previous.renderId,
      previous.response,
    ),
    cacheStatus: "PREVIOUS",
    hintMatched: true,
  };
}

/** The shared source a previous-build entry could be stored in, if any. */
function selectPreviousRouteDataSource(
  lookup: RouteDataLookup,
): PreviousRouteDataInput["source"] | null {
  switch (selectRouteDataSource(lookup)) {
    case "live":
      return null;
    case "liveCache":
      return { kind: "cachedLive" };
    case "savedCache": {
      const featureMode = getEnabledPrerenderMode(lookup.input.rollouts);
      return featureMode ? { kind: "saved", featureMode } : null;
    }
  }
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
  const call = createSavedOutputCall({
    origin: new URL(input.request.url).origin,
    pathname: parsed.pathname,
    resolution,
    identity: active.identity,
    featureMode,
    representation: "data",
  });
  const result = await measureCacheFetch(input, call);
  if (!result) return fetchLiveRouteData(lookup);
  return {
    ...result,
    diagnostics: readPrerenderDiagnostics(result.response, result.cacheStatus),
  };
}

async function fetchCachedLiveRouteData(
  lookup: RouteDataLookup,
): Promise<FetchedRouteData> {
  const { input, parsed, resolution, active } = lookup;
  const call = createRouteDataCacheCall({
    origin: new URL(input.request.url).origin,
    pathname: parsed.pathname,
    resolution,
    identity: active.identity,
  });
  const result = await measureCacheFetch(input, call);
  if (!result) return fetchLiveRouteData(lookup);
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

const TIMING_NAMES: Record<
  (SavedOutputCacheCall | RouteDataCacheCall)["entrypoint"],
  string
> = {
  DocsPrerenderCache: "doxa_prerender_cache",
  DocsRouteDataCache: "doxa_route_data_cache",
};

/** Null when the entry was not filled twice; the caller prepares it live. */
async function measureCacheFetch(
  input: DeliveryRequestContext,
  call: SavedOutputCacheCall | RouteDataCacheCall,
): Promise<Omit<FetchedRouteData, "diagnostics"> | null> {
  let cacheStatus = BYPASS;
  const response = await input.timing.measure(
    TIMING_NAMES[call.entrypoint],
    async () => {
      const result = await fetchWithoutProbeMarker(call.entrypoint, () =>
        fetchPublicCacheCall(getWorkerExports(input.ctx), call),
      );
      cacheStatus = result?.headers.get("cf-cache-status") ?? BYPASS;
      return result;
    },
    () => cacheStatus,
  );
  if (!response) return null;
  mergeFreshInternalServerTiming(input.timing, response, cacheStatus);
  return { response, cacheStatus };
}

/**
 * One public envelope for every source, so the client sees one contract.
 * `renderId` is the identity of the build that produced `fetched`.
 */
async function createEnvelopeResponse(
  input: DeliveryRequestContext,
  renderId: string,
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
      renderId,
      data: parsePublicDocsRouteDataV1(await fetched.json()),
    },
    { headers },
  );
}

function unavailable(status: 404 | 503, retryable: boolean): Response {
  return Response.json({ status: "unavailable", retryable }, { status });
}

function uncached(response: Response): RouteDataEndpointResult {
  return { response, cacheStatus: BYPASS, hintMatched: false };
}
