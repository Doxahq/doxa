import type { DocsDomainResolution } from "@doxahq/contracts";

/**
 * Response headers for public documentation HTML.
 *
 * Saved output and live output must carry the same headers. A visitor must
 * not receive a weaker response because the saved output was missing.
 */
export const DOCS_HTML_SECURITY_HEADERS = {
  // SEC-023: only the directives that no published page can need. A
  // script-src policy needs per-request nonces in the renderer first.
  "content-security-policy": "base-uri 'self'; object-src 'none'",
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
 * Asks search engines not to index a preview host, and keeps the host out of
 * Referer headers (SEC-033): for a generation preview the hostname is the
 * secret, and strict-origin-when-cross-origin would send it to every
 * external link and embed.
 *
 * A response from `fetch()` or from a service binding has immutable headers,
 * so the headers go on a copy. The copy keeps the status and the body.
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
  result.headers.set("referrer-policy", "no-referrer");
  return result;
}

/**
 * HSTS for docs hostnames. One day only, without `includeSubDomains` or
 * `preload`: a custom domain may leave Doxa, and a browser keeps the policy
 * for its whole `max-age`. The dispatcher adds it to every HTTPS response
 * while `DOXA_PROD_HTTPS_REDIRECT_MODE` is `on` (see `https-policy.ts`).
 */
export const DOCS_STRICT_TRANSPORT_SECURITY = "max-age=86400";

/**
 * Adds HSTS to a response of an HTTPS request. A browser ignores HSTS on
 * plain HTTP, so an HTTP response stays unchanged. The header goes on a copy,
 * because a response from a binding has immutable headers.
 */
export function withDocsStrictTransportSecurity(
  response: Response,
  request: Request,
): Response {
  if (new URL(request.url).protocol !== "https:") return response;
  const result = new Response(response.body, response);
  result.headers.set(
    "strict-transport-security",
    DOCS_STRICT_TRANSPORT_SECURITY,
  );
  return result;
}
