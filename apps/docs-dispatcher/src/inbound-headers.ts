/**
 * Every header with this prefix is internal to the docs platform. The
 * dispatcher sets these headers itself (for example `x-doxa-internal-render-id`
 * on a renderer call), and internal entrypoints trust them.
 */
export const INTERNAL_HEADER_PREFIX = "x-doxa-";

/**
 * Removes every visitor-sent `x-doxa-*` request header before any routing.
 *
 * No external client sends an `x-doxa-*` header to a docs hostname: the API
 * health check (`/.well-known/doxa-health`) reads `x-doxa-renderer-health`
 * from the response only, and preview, private and generation hosts use no
 * such request header. So the strip has no exceptions. Returns the same
 * request when it has no such header, so the common path makes no copy.
 */
export function stripInboundDoxaHeaders(request: Request): Request {
  const names = internalHeaderNames(request.headers);
  if (names.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function internalHeaderNames(headers: Headers): string[] {
  const names: string[] = [];
  // Header names from `Headers` iteration are lowercase.
  for (const [name] of headers) {
    if (name.startsWith(INTERNAL_HEADER_PREFIX)) names.push(name);
  }
  return names;
}
