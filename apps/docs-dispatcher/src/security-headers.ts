import type { DocsDomainResolution } from "@doxahq/contracts";

/**
 * Response headers for public documentation HTML.
 *
 * Saved output and live output must carry the same headers. A visitor must
 * not receive a weaker response because the saved output was missing.
 */
export const DOCS_HTML_SECURITY_HEADERS = {
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
} as const;

/**
 * Adds the header set to a response of the public gateway.
 *
 * Every gateway response receives the headers, so no renderer behavior can
 * drop them. A header that the renderer already sent stays unchanged, so a
 * page-level policy can be stricter than this default.
 */
export function withDocsSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(DOCS_HTML_SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

/**
 * Asks search engines not to index a preview host.
 *
 * A response from `fetch()` or from a service binding has immutable headers,
 * so the header goes on a copy. The copy keeps the status and the body.
 */
export function withDocsPreviewSearchPolicy(
  response: Response,
  resolution: DocsDomainResolution | null | undefined,
): Response {
  if (
    resolution?.renderTarget !== "preview" &&
    resolution?.renderTarget !== "generation_snapshot"
  ) {
    return response;
  }

  const result = new Response(response.body, response);
  result.headers.set("x-robots-tag", "noindex, nofollow");
  return result;
}
