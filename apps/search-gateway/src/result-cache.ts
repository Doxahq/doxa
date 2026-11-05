const RESULT_TTL_SECONDS = 300;

/**
 * A published version never changes, so one query on one index always has the
 * same answer. The key holds the index name, so sites never share an entry.
 * The stored answer has no CORS header: the gateway adds it per request.
 */
export interface SearchResultCache {
  read(key: string): Promise<string | null>;
  write(key: string, body: string): Promise<void>;
}

export function createSearchResultCache(cache: Cache): SearchResultCache {
  return {
    async read(key) {
      const hit = await cache.match(toRequest(key));
      return hit ? hit.text() : null;
    },
    async write(key, body) {
      await cache.put(
        toRequest(key),
        new Response(body, {
          headers: { "cache-control": `public, max-age=${RESULT_TTL_SECONDS}` },
        }),
      );
    },
  };
}

export function searchResultCacheKey(input: {
  indexKey: string;
  query: string;
  limit: number;
}): string {
  const params = new URLSearchParams({
    q: input.query.toLowerCase(),
    limit: String(input.limit),
  });
  return `${encodeURIComponent(input.indexKey)}?${params}`;
}

function toRequest(key: string): Request {
  return new Request(`https://search-results.internal/${key}`);
}
