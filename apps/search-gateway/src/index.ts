import type { SearchGatewayEnv } from "./env";
import { handleSearchRequest } from "./handler";
import { resolveSearchHost } from "./host";
import { createSearchResultCache } from "./result-cache";
import { createSearchReaders } from "./router";

/**
 * Lexis: the public search entry point of docs sites. It holds the routing,
 * limits and usage records, so a site's provider can change without a change
 * in the docs page.
 */
export default {
  fetch(request, env, ctx) {
    return handleSearchRequest(request, {
      enabled: env.DOXA_PROD_SEARCH_GATEWAY_MODE === "on",
      allowHttpOrigins: env.SEARCH_ALLOW_HTTP_ORIGINS === "true",
      resolveHost: (hostname) => resolveSearchHost(env, hostname, Date.now()),
      readers: createSearchReaders(env),
      // The DOM types in this workspace do not know `caches.default`.
      cache: createSearchResultCache(
        (caches as unknown as { default: Cache }).default,
      ),
      ...(env.SEARCH_CLIENT ? { clientLimiter: env.SEARCH_CLIENT } : {}),
      ...(env.SEARCH_SITE ? { siteLimiter: env.SEARCH_SITE } : {}),
      ...(env.SEARCH_USAGE ? { usage: env.SEARCH_USAGE } : {}),
      waitUntil: (work) => ctx.waitUntil(work),
      now: () => Date.now(),
    });
  },
} satisfies ExportedHandler<SearchGatewayEnv>;
