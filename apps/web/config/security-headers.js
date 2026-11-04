/**
 * Response headers of every doxa.so page (SEC-011). worker.js adds them to
 * rendered responses, and public/_headers repeats them for the prerendered
 * pages and files that the assets binding serves without the Worker. A test
 * keeps the two lists equal.
 *
 * No script-src yet: TanStack Start writes inline hydration scripts that
 * change per request, so a script policy needs per-request nonces.
 * No form-action: Chrome applies it to the redirects after the OAuth consent
 * form, which go to each client's own redirect URI.
 */
export const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
}

/** The response with each security header that it does not set itself. */
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
