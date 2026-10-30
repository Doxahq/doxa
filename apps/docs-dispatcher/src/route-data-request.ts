import { normalizePublicDocsPathname } from "@doxahq/contracts/docs-prerender";

/** Public path of the route-data endpoint, and its internal cache namespace. */
export const ROUTE_DATA_PATH = "/_doxa/route-data/v1";

export interface ParsedRouteDataRequest {
  status: "ok";
  pathname: string;
  renderHint?: string;
  sharedCacheEligible: boolean;
}

export function parseRouteDataRequest(
  request: Request,
): ParsedRouteDataRequest {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new RouteDataRequestError(
      "method_not_allowed",
      "Only GET and HEAD are supported.",
    );
  }
  const url = new URL(request.url);
  if (url.pathname !== ROUTE_DATA_PATH) {
    throw new RouteDataRequestError(
      "invalid_path",
      "The route-data endpoint path is invalid.",
    );
  }
  assertSameOriginRequest(request, url.origin);

  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "path" && key !== "render")) {
    throw new RouteDataRequestError(
      "invalid_query",
      "Unknown route-data query field.",
    );
  }
  if (url.searchParams.getAll("path").length !== 1) {
    throw new RouteDataRequestError(
      "invalid_query",
      "Exactly one docs path is required.",
    );
  }
  if (url.searchParams.getAll("render").length > 1) {
    throw new RouteDataRequestError(
      "invalid_query",
      "The render hint is ambiguous.",
    );
  }

  const pathname = normalizePublicDocsPathname(
    url.searchParams.get("path") ?? "",
  );
  if (pathname.split("/").some((segment) => segment.startsWith("_"))) {
    throw new RouteDataRequestError(
      "invalid_path",
      "Internal docs paths are not available.",
    );
  }
  const renderHint = url.searchParams.get("render") ?? undefined;
  if (renderHint !== undefined && !/^[a-f0-9]{64}$/.test(renderHint)) {
    throw new RouteDataRequestError(
      "invalid_query",
      "The render hint is invalid.",
    );
  }

  return {
    status: "ok",
    pathname,
    ...(renderHint ? { renderHint } : {}),
    // A cookie does not make route data visitor-specific: shared entries
    // exist only for public production sites, which never read cookies (RES-1).
    sharedCacheEligible: !request.headers.has("authorization"),
  };
}

function assertSameOriginRequest(
  request: Request,
  requestOrigin: string,
): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (
    (origin !== null && origin !== requestOrigin) ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    throw new RouteDataRequestError(
      "cross_origin",
      "The route-data endpoint requires same-origin use.",
    );
  }
}

export class RouteDataRequestError extends Error {
  constructor(
    readonly code:
      | "method_not_allowed"
      | "invalid_path"
      | "invalid_query"
      | "cross_origin",
    message: string,
  ) {
    super(message);
  }
}
