import { z } from "zod";

/**
 * The provider-neutral contract of docs search.
 *
 * `minisearch` runs in the visitor's browser and needs no remote index. Every
 * other provider holds a remote index and answers through the search gateway.
 * A new provider adds one name here and one adapter in
 * `@doxahq/docs-search/providers`.
 */
export const DOCS_SEARCH_PROVIDERS = ["minisearch", "typesense"] as const;
export const docsSearchProviderSchema = z.enum(DOCS_SEARCH_PROVIDERS);
export type DocsSearchProvider = z.infer<typeof docsSearchProviderSchema>;

/** The providers that hold a remote index. */
export const DOCS_SEARCH_REMOTE_PROVIDERS = ["typesense"] as const;
export const docsSearchRemoteProviderSchema = z.enum(
  DOCS_SEARCH_REMOTE_PROVIDERS,
);
export type DocsSearchRemoteProvider = z.infer<
  typeof docsSearchRemoteProviderSchema
>;

export function isRemoteSearchProvider(
  provider: DocsSearchProvider,
): provider is DocsSearchRemoteProvider {
  return docsSearchRemoteProviderSchema.safeParse(provider).success;
}

/** Same-origin dispatcher routes. */
export const DOCS_SEARCH_CONFIG_PATH = "/_doxa/search/v1/config";
export const DOCS_SEARCH_INDEX_PATH = "/_doxa/search/v1/index";
export const DOCS_SEARCH_SNIPPETS_PATH = "/_doxa/search/v1/snippets";

/**
 * Above this size a browser download costs more than a search on the server:
 * about 3,000 pages. The page then uses the renderer's search.
 */
export const MAX_BROWSER_SEARCH_INDEX_BYTES = 8 * 1024 * 1024;

/** The gateway route. It lives on its own hostname. */
export const DOCS_SEARCH_GATEWAY_PATH = "/v1/search";

/** Limits of one gateway search. The renderer route keeps its own limits. */
export const DOCS_SEARCH_GATEWAY_LIMITS = {
  minQueryLength: 2,
  maxQueryLength: 200,
  maxResults: 20,
  defaultResults: 8,
} as const;

/**
 * How a docs page searches.
 *
 * - `browser`: download `indexUrl`, then search with no further network call.
 *   `snippetsUrl` adds result snippets, and search works without it.
 * - `gateway`: send each search to `endpoint`.
 * - `server`: use the renderer's same-origin `/api/search`. This is the mode
 *   for a site behind an access gate, and the fallback for the other two.
 */
export const docsSearchClientConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("browser"),
    contentVersion: z.string().min(1),
    indexUrl: z.string().startsWith("/"),
    snippetsUrl: z.string().startsWith("/"),
  }),
  z.object({
    mode: z.literal("gateway"),
    endpoint: z.url({ protocol: /^https?$/ }),
  }),
  z.object({ mode: z.literal("server") }),
]);
export type DocsSearchClientConfig = z.infer<
  typeof docsSearchClientConfigSchema
>;

/** The browser mode of a version. `?v=` makes each version a new URL. */
export function createBrowserSearchConfig(
  contentVersion: string,
): DocsSearchClientConfig {
  const version = encodeURIComponent(contentVersion);
  return {
    mode: "browser",
    contentVersion,
    indexUrl: `${DOCS_SEARCH_INDEX_PATH}?v=${version}`,
    snippetsUrl: `${DOCS_SEARCH_SNIPPETS_PATH}?v=${version}`,
  };
}

/** Why the gateway answered with no results. The browser falls back on it. */
export const docsSearchGatewayErrorSchema = z.object({
  error: z.enum([
    "invalid_query",
    "not_allowed",
    "not_available",
    "index_not_ready",
    "provider_error",
    "rate_limited",
  ]),
});
export type DocsSearchGatewayError = z.infer<
  typeof docsSearchGatewayErrorSchema
>["error"];

/** Every remote index name starts with this. API keys are scoped to it. */
export const DOCS_SEARCH_INDEX_KEY_PREFIX = "s_";

export const docsSearchIndexKeySchema = z
  .string()
  .regex(/^s_[a-f0-9]{32}_[a-f0-9]{32}_[a-f0-9]{32}$/);

function compactId(id: string): string {
  return z.uuid().parse(id).replaceAll("-", "");
}

/**
 * The name of one remote index. Each new build gets a random generation (a full
 * UUID), so a delete of an old index cannot hit a newer one. It comes only from
 * the task's site and version, so no visitor input can choose it.
 */
export function createDocsSearchIndexKey(input: {
  siteId: string;
  versionId: string;
}): string {
  const generation = crypto.randomUUID().replaceAll("-", "");
  return `${DOCS_SEARCH_INDEX_KEY_PREFIX}${compactId(input.siteId)}_${compactId(input.versionId)}_${generation}`;
}

/** A guard for every reader: an index name must belong to the site. */
export function isDocsSearchIndexKeyOfSite(
  indexKey: string,
  siteId: string,
): boolean {
  return (
    docsSearchIndexKeySchema.safeParse(indexKey).success &&
    z.uuid().safeParse(siteId).success &&
    indexKey.startsWith(
      `${DOCS_SEARCH_INDEX_KEY_PREFIX}${compactId(siteId)}_`,
    )
  );
}

/**
 * A resolution without its search target. Public page cache keys and the warm
 * job's "live version changed" test use the resolution, and a search change
 * must not make pages cold or start a warm job.
 */
export function withoutSearchTarget<
  T extends { searchProvider?: unknown; searchIndexKey?: unknown },
>(resolution: T): Omit<T, "searchProvider" | "searchIndexKey"> {
  const {
    searchProvider: _provider,
    searchIndexKey: _indexKey,
    ...rest
  } = resolution;
  return rest;
}

/** One data point of search usage. No field holds the search text. */
export const DOCS_SEARCH_USAGE_OUTCOMES = [
  "answered",
  "cached",
  "index_not_ready",
  "provider_error",
  "rate_limited",
  "index_download",
] as const;
export type DocsSearchUsageOutcome =
  (typeof DOCS_SEARCH_USAGE_OUTCOMES)[number];
