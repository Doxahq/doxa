/**
 * Per-IP limit on docs requests that reach the dispatcher (SEC-007).
 *
 * Random paths, query strings and hostnames each miss the cache, so a cache
 * alone cannot stop one client from making the shared renderer and the
 * resolver database do work for every request. Hashed client files are served
 * before this check. Warm fills and pre-renders use `ctx.exports` and service
 * bindings, not the public gateway, so they are not counted.
 */
import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";

export interface DocsRequestLimitEnv {
  /** Workers Rate Limiting binding. Without it, nothing is limited. */
  DOCS_REQUEST_LIMITER?: RateLimit;
}

export async function limitDocsRequest(
  request: Request,
  env: DocsRequestLimitEnv,
): Promise<Response | null> {
  const limiter = env.DOCS_REQUEST_LIMITER;
  const clientIp = request.headers.get("cf-connecting-ip");
  if (!limiter || !clientIp) return null;

  const { success } = await limiter.limit({ key: clientIpRateLimitKey(clientIp) });
  if (success) return null;

  return new Response("Too many requests.", {
    status: 429,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "60",
    },
  });
}
