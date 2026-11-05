import type { DocsSearchGatewayError } from "@doxahq/contracts/docs-search";
import type { RuntimeSearchResult } from "@doxahq/docs-search/contracts";

/** The origin is echoed only after it resolved to a site. */
export type AllowedOrigin = string | null;

function headers(
  allowedOrigin: AllowedOrigin,
  extra: Record<string, string> = {},
): Headers {
  const result = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
    ...extra,
  });
  if (allowedOrigin) {
    result.set("access-control-allow-origin", allowedOrigin);
  }
  return result;
}

export function errorResponse(
  error: DocsSearchGatewayError,
  status: number,
  allowedOrigin: AllowedOrigin,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: headers(allowedOrigin, extra),
  });
}

export function resultsBody(results: readonly RuntimeSearchResult[]): string {
  return JSON.stringify({ results });
}

export function resultsResponse(
  body: string,
  allowedOrigin: AllowedOrigin,
): Response {
  return new Response(body, { headers: headers(allowedOrigin) });
}

export function methodNotAllowedResponse(): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: "GET", "cache-control": "no-store" },
  });
}
