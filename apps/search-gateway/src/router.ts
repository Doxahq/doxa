import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  docsSearchRemoteProviderSchema,
  isDocsSearchIndexKeyOfSite,
  type DocsSearchRemoteProvider,
} from "@doxahq/contracts/docs-search";
import {
  createTypesenseReader,
  type SearchReader,
} from "@doxahq/docs-search/providers";

import type { SearchGatewayEnv } from "./env";

export type SearchReaders = Partial<
  Record<DocsSearchRemoteProvider, SearchReader>
>;

/** The one place that knows which providers exist. */
export function createSearchReaders(
  env: Pick<
    SearchGatewayEnv,
    "SEARCH_TYPESENSE_HOST" | "SEARCH_TYPESENSE_SEARCH_KEY"
  >,
): SearchReaders {
  const readers: SearchReaders = {};
  if (env.SEARCH_TYPESENSE_HOST && env.SEARCH_TYPESENSE_SEARCH_KEY) {
    readers.typesense = createTypesenseReader({
      host: env.SEARCH_TYPESENSE_HOST,
      apiKey: env.SEARCH_TYPESENSE_SEARCH_KEY,
    });
  }
  return readers;
}

export interface SearchRoute {
  provider: DocsSearchRemoteProvider;
  reader: SearchReader;
  indexKey: string;
}

/**
 * Chooses where a search goes. Only a public production site with a remote
 * provider has a route. The index name comes from the resolved site, and it
 * must belong to that site.
 */
export function routeSearch(
  resolution: DocsDomainResolution,
  readers: SearchReaders,
): SearchRoute | null {
  if (resolution.accessPolicy !== "public") return null;
  if (resolution.renderTarget !== "production") return null;
  const provider = docsSearchRemoteProviderSchema.safeParse(
    resolution.searchProvider,
  );
  if (!provider.success) return null;
  const indexKey = resolution.searchIndexKey;
  if (!indexKey || !isDocsSearchIndexKeyOfSite(indexKey, resolution.siteId)) {
    return null;
  }
  const reader = readers[provider.data];
  if (!reader) return null;
  return { provider: provider.data, reader, indexKey };
}
