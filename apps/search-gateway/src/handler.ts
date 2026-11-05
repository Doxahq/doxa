import type { DocsDomainResolution } from "@doxahq/contracts";
import { DOCS_SEARCH_GATEWAY_PATH } from "@doxahq/contracts/docs-search";
import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";
import { SearchIndexMissingError } from "@doxahq/docs-search/providers";

import { parseGatewayQuery, readPageHostname } from "./request";
import {
  errorResponse,
  methodNotAllowedResponse,
  resultsBody,
  resultsResponse,
} from "./responses";
import {
  routeSearch,
  type SearchReaders,
  type SearchRoute,
} from "./router";
import {
  searchResultCacheKey,
  type SearchResultCache,
} from "./result-cache";
import { recordSearchUsage } from "./usage";

/** A slow provider must not hold the dialog: the browser falls back instead. */
const PROVIDER_TIMEOUT_MS = 2_000;

export interface SearchHandlerDependencies {
  enabled: boolean;
  allowHttpOrigins: boolean;
  resolveHost(hostname: string): Promise<DocsDomainResolution | null>;
  readers: SearchReaders;
  cache: SearchResultCache;
  clientLimiter?: RateLimit;
  siteLimiter?: RateLimit;
  usage?: AnalyticsEngineDataset;
  waitUntil(work: Promise<unknown>): void;
  now(): number;
}

/**
 * The public entry point of remote search. A plain GET with no custom header
 * needs no CORS preflight, so a search costs one round trip.
 */
export async function handleSearchRequest(
  request: Request,
  deps: SearchHandlerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== DOCS_SEARCH_GATEWAY_PATH) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== "GET") return methodNotAllowedResponse();
  if (!deps.enabled) return errorResponse("not_available", 503, null);

  const page = readPageHostname(request, deps.allowHttpOrigins);
  if (!page) return errorResponse("not_allowed", 403, null);

  const clientIp = request.headers.get("cf-connecting-ip");
  if (deps.clientLimiter && clientIp) {
    const { success } = await deps.clientLimiter.limit({
      key: clientIpRateLimitKey(clientIp),
    });
    if (!success) {
      return errorResponse("rate_limited", 429, null, { "retry-after": "60" });
    }
  }

  const resolution = await deps.resolveHost(page.hostname);
  if (!resolution) return errorResponse("not_allowed", 403, null);
  const route = routeSearch(resolution, deps.readers);
  if (!route) return errorResponse("not_available", 404, page.origin);

  const query = parseGatewayQuery(url);
  if (!query) return errorResponse("invalid_query", 400, page.origin);

  if (deps.siteLimiter) {
    const { success } = await deps.siteLimiter.limit({
      key: resolution.siteId,
    });
    if (!success) {
      record(deps, resolution, route, "rate_limited", 0, 0);
      return errorResponse("rate_limited", 429, page.origin, {
        "retry-after": "60",
      });
    }
  }

  const startedAt = deps.now();
  const cacheKey = searchResultCacheKey({
    indexKey: route.indexKey,
    query: query.query,
    limit: query.limit,
  });
  const cached = await deps.cache.read(cacheKey);
  if (cached) {
    record(
      deps,
      resolution,
      route,
      "cached",
      deps.now() - startedAt,
      utf8ByteLength(cached),
    );
    return resultsResponse(cached, page.origin);
  }

  try {
    const results = await route.reader.search({
      indexKey: route.indexKey,
      query: query.query,
      limit: query.limit,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const body = resultsBody(results);
    deps.waitUntil(deps.cache.write(cacheKey, body));
    record(
      deps,
      resolution,
      route,
      "answered",
      deps.now() - startedAt,
      utf8ByteLength(body),
    );
    return resultsResponse(body, page.origin);
  } catch (error) {
    const missing = error instanceof SearchIndexMissingError;
    record(
      deps,
      resolution,
      route,
      missing ? "index_not_ready" : "provider_error",
      deps.now() - startedAt,
      0,
    );
    return errorResponse(
      missing ? "index_not_ready" : "provider_error",
      503,
      page.origin,
    );
  }
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function record(
  deps: SearchHandlerDependencies,
  resolution: DocsDomainResolution,
  route: SearchRoute,
  outcome: Parameters<typeof recordSearchUsage>[1]["outcome"],
  elapsedMs: number,
  responseBytes: number,
): void {
  recordSearchUsage(deps.usage, {
    siteId: resolution.siteId,
    provider: route.provider,
    outcome,
    elapsedMs,
    responseBytes,
  });
}
